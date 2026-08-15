import { expect, type Page } from "@playwright/test";

import { E2E_TIMEOUTS } from "../config/timeouts.ts";
import type { AgentProviderCandidate } from "../harness/env.ts";
import {
  waitForOnboardingOrReady,
  waitForOnboardingWizard,
  waitForReadyOrWorkspacePicker,
} from "./shell.ts";

/**
 * Create the first workspace if the picker appears. The picker offers existing
 * workspaces and a create control; a fresh temp config dir has none, so we
 * create one. Falls through silently if already on the ready shell.
 */
async function handleWorkspacePickerIfPresent(page: Page): Promise<void> {
  const where = await waitForReadyOrWorkspacePicker(page);
  if (where === "ready") {
    return;
  }

  const picker = page.locator("#workspace-picker");
  const existingWorkspace = picker
    .locator('[data-testid^="workspace-select-"]')
    .first();
  if (await existingWorkspace.count()) {
    await existingWorkspace.click();
  } else {
    const workspaceName = `E2E Workspace ${Date.now()}`;
    await picker
      .locator('[data-testid="workspace-create-input"]')
      .fill(workspaceName);
    await picker.locator('[data-testid="workspace-create-button"]').click();
  }

  await waitForReadyOrWorkspacePicker(page).then((state) => {
    if (state !== "ready") {
      throw new Error(
        "Workspace picker did not advance to the ready shell after selection.",
      );
    }
  });
}

/**
 * Deferred-setup path: drive the onboarding "Setup later" control, which sets
 * the `setupDeferred` flag and lets getSetupNeeds() report fully configured.
 * Reaches the ready shell credential-free for Settings and other
 * provider-free product UI.
 */
export async function completeDeferredSetup(page: Page): Promise<void> {
  await waitForOnboardingWizard(page);
  await page.locator('[data-testid="onboarding-setup-later"]').click();
  await handleWorkspacePickerIfPresent(page);
}

async function setAgentWorkingDirectory(page: Page): Promise<void> {
  await page.evaluate(async (workingDirectory) => {
    const api = (
      window as unknown as {
        electronAPI: {
          getWindowWorkspace(): Promise<string | null>;
          updateWorkspaceSetting(
            workspaceId: string,
            key: "workingDirectory",
            value: string,
          ): Promise<void>;
        };
      }
    ).electronAPI;
    const workspaceId = await api.getWindowWorkspace();
    if (!workspaceId) {
      throw new Error(
        "Agent E2E setup: the ready shell has no active workspace.",
      );
    }
    await api.updateWorkspaceSetting(
      workspaceId,
      "workingDirectory",
      workingDirectory,
    );
  }, process.cwd());
}

const CHATGPT_CONNECTION_SLUG = "chatgpt-plus";
const PI_API_KEY_SLUG = "pi-api-key";
const ANTHROPIC_API_KEY_SLUG = "anthropic-api";

/** Connection slug used for an API-key candidate (Anthropic has its own). */
function apiKeySlugFor(provider: string): string {
  return provider === "anthropic" ? ANTHROPIC_API_KEY_SLUG : PI_API_KEY_SLUG;
}

/** Make a connection the global default (retries must repoint the default). */
async function setDefaultConnection(page: Page, slug: string): Promise<void> {
  const result = await page.evaluate(async (targetSlug) => {
    const api = (
      window as unknown as {
        electronAPI: {
          setDefaultLlmConnection(slug: string): Promise<{
            success: boolean;
            error?: string;
          }>;
        };
      }
    ).electronAPI;
    return api.setDefaultLlmConnection(targetSlug);
  }, slug);
  if (!result.success) {
    throw new Error(
      `Failed to set default LLM connection to ${slug}: ${result.error ?? "unknown error"}`,
    );
  }
}

/**
 * Programmatic API-key connection setup (re-runnable on fallback retries,
 * unlike the one-shot onboarding wizard): create/update the connection with
 * the candidate's key + provider + model, make it the default, then reload
 * into the ready shell. Mirrors what the wizard's pi_api_key / anthropic_api_key
 * paths ultimately call (setupLlmConnection).
 */
async function configureApiKeyConnection(
  page: Page,
  candidate: AgentProviderCandidate,
): Promise<void> {
  if (!candidate.apiKey) {
    throw new Error(
      `API-key provider ${candidate.provider} has no key (${candidate.keySource}).`, 
    );
  }
  const slug = apiKeySlugFor(candidate.provider);
  // Keep the credential out of page.evaluate arguments: Playwright records
  // those arguments in failure traces. The page-local binding returns it only
  // when the authenticated renderer invokes the setup IPC.
  const credentialBinding = `__kataE2eCredential_${candidate.index}_${Date.now()}`;
  await page.exposeFunction(credentialBinding, () => candidate.apiKey!);
  const setup = await page.evaluate(
    async ({ targetSlug, defaultModel, piAuthProvider, credentialBinding }) => {
      const api = (
        window as unknown as {
          electronAPI: {
            setupLlmConnection(setup: {
              slug: string;
              credential: string;
              defaultModel: string;
              models: string[];
              piAuthProvider: string;
              modelSelectionMode: "userDefined3Tier";
            }): Promise<{ success: boolean; error?: string }>;
          };
        }
      ).electronAPI;
      const credentialProvider = (
        window as unknown as Record<string, () => Promise<string>>
      )[credentialBinding];
      if (!credentialProvider) {
        throw new Error("Agent E2E setup: credential binding is unavailable.");
      }
      return api.setupLlmConnection({
        slug: targetSlug,
        credential: await credentialProvider(),
        defaultModel,
        models: [defaultModel],
        piAuthProvider,
        modelSelectionMode: "userDefined3Tier",
      });
    },
    {
      targetSlug: slug,
      defaultModel: candidate.model,
      piAuthProvider: candidate.provider,
      credentialBinding,
    },
  );
  if (!setup.success) {
    throw new Error(
      `Provider connection setup failed for ${candidate.provider} (${candidate.keySource}): ${setup.error ?? "unknown error"}. See e2e/README.md.`,
    );
  }
  await setDefaultConnection(page, slug);
  await page.reload({ waitUntil: "domcontentloaded" });
  await handleWorkspacePickerIfPresent(page);
  await setAgentWorkingDirectory(page);
  await expect(page.locator("#app-ready")).toBeVisible({
    timeout: E2E_TIMEOUTS.electronWindowMs,
  });
}

/**
 * Configure the app for one fallback-chain candidate, re-runnable for retries.
 * OAuth candidates (openai-codex) prefer the existing codex OAuth credential
 * and fall back to the provider API key when it is unavailable; api-key
 * candidates configure programmatically.
 */
export async function configureAgentConnection(
  page: Page,
  candidate: AgentProviderCandidate,
): Promise<void> {
  if (candidate.auth !== "oauth") {
    await configureApiKeyConnection(page, candidate);
    return;
  }

  const authStatus = await page.evaluate(async (connectionSlug) => {
    const api = (
      window as unknown as {
        electronAPI: {
          getChatGptAuthStatus(slug: string): Promise<{
            authenticated: boolean;
            expiresAt?: number;
            hasRefreshToken?: boolean;
          }>;
        };
      }
    ).electronAPI;
    return api.getChatGptAuthStatus(connectionSlug);
  }, CHATGPT_CONNECTION_SLUG);

  if (authStatus.authenticated) {
    await completeConfiguredChatGptOnboarding(page, candidate.model);
    // A retry may have pointed the default at an earlier api-key candidate;
    // repoint it at the OAuth connection so new sessions use it.
    await setDefaultConnection(page, CHATGPT_CONNECTION_SLUG);
    return;
  }

  if (candidate.apiKey) {
    console.warn(
      `[e2e][provider] chatgpt-plus OAuth credential is not available; falling back to ${candidate.keySource}`,
    );
    await configureApiKeyConnection(page, candidate);
    return;
  }

  throw new Error(
    `openai-codex OAuth is not authenticated (chatgpt-plus) and no ${candidate.keySource} fallback is set.`,
  );
}

/**
 * Reuse the existing ChatGPT/Codex OAuth credential without opening a browser
 * or entering an API key. The isolated E2E config receives a connection record;
 * the credential manager supplies the already-authenticated OAuth tokens.
 */
export async function completeConfiguredChatGptOnboarding(
  page: Page,
  model: string,
): Promise<void> {
  const shell = await waitForOnboardingOrReady(page);
  if (shell === "workspace-picker") {
    await handleWorkspacePickerIfPresent(page);
  }

  const authStatus = await page.evaluate(async (connectionSlug) => {
    const api = (
      window as unknown as {
        electronAPI: {
          getChatGptAuthStatus(slug: string): Promise<{
            authenticated: boolean;
            expiresAt?: number;
            hasRefreshToken?: boolean;
          }>;
        };
      }
    ).electronAPI;
    return api.getChatGptAuthStatus(connectionSlug);
  }, CHATGPT_CONNECTION_SLUG);

  if (!authStatus.authenticated) {
    throw new Error(
      "ChatGPT OAuth is not available for the chatgpt-plus connection. Sign in to ChatGPT in Kata Agents first; this E2E path intentionally does not open an OAuth browser flow or accept an API key. See e2e/README.md.",
    );
  }

  const setupResult = await page.evaluate(
    async ({ connectionSlug, configuredModel }) => {
      const api = (
        window as unknown as {
          electronAPI: {
            setupLlmConnection(setup: {
              slug: string;
              defaultModel: string;
              models: string[];
              piAuthProvider: "openai-codex";
              modelSelectionMode: "userDefined3Tier";
            }): Promise<{ success: boolean; error?: string }>;
          };
        }
      ).electronAPI;
      return api.setupLlmConnection({
        slug: connectionSlug,
        defaultModel: configuredModel,
        models: [configuredModel],
        piAuthProvider: "openai-codex",
        modelSelectionMode: "userDefined3Tier",
      });
    },
    { connectionSlug: CHATGPT_CONNECTION_SLUG, configuredModel: model },
  );

  if (!setupResult.success) {
    throw new Error(
      `ChatGPT OAuth connection setup failed: ${setupResult.error ?? "unknown error"}. See e2e/README.md.`,
    );
  }

  // The direct connection setup persists the isolated config and the OAuth
  // credential remains in the shared credential manager. Reload so App.tsx
  // recomputes setup needs and enters the normal ready shell.
  await page.reload({ waitUntil: "domcontentloaded" });
  await handleWorkspacePickerIfPresent(page);
  await setAgentWorkingDirectory(page);
  await expect(page.locator("#app-ready")).toBeVisible({
    timeout: E2E_TIMEOUTS.electronWindowMs,
  });
}
