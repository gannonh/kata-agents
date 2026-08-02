import { expect, type Page } from "@playwright/test";

import { E2E_TIMEOUTS } from "../config/timeouts.ts";
import { readAgentProviderConfig } from "../harness/env.ts";
import {
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
 * Reaches the ready shell credential-free for @settings.
 */
export async function completeDeferredSetup(page: Page): Promise<void> {
  await waitForOnboardingWizard(page);
  await page.locator('[data-testid="onboarding-setup-later"]').click();
  await handleWorkspacePickerIfPresent(page);
}

/**
 * Real API-key path for @agent: configure a real provider connection using the
 * key from root .env, then reach the ready shell.
 *
 * Flow (validated on a headed harness run, adoption guide learning #7):
 * provider select -> "I use other provider" lands on the API Configuration
 * step with an API key field (Anthropic endpoint preselected) and a Continue
 * button.
 *
 * NOTE: this function is the Anthropic API-key path. The configured
 * ChatGPT/Codex OAuth path is handled by completeConfiguredChatGptOnboarding
 * and does not enter an API key.
 */
export async function completeApiKeyOnboarding(page: Page): Promise<void> {
  const { apiKey } = readAgentProviderConfig();
  if (!apiKey) {
    throw new Error(
      "API-key onboarding requires an API-key provider. Set KATA_E2E_AGENT_PROVIDER=anthropic or use the configured openai-codex OAuth flow; see e2e/README.md.",
    );
  }
  const wizard = page.locator("#onboarding-wizard");
  await waitForOnboardingWizard(page);

  // Provider select -> "I use other provider" -> API Configuration step.
  await wizard.locator('[data-testid="onboarding-provider-api_key"]').click();

  // Enter the key and continue.
  const keyInput = wizard.locator("#api-key");
  await keyInput.waitFor({
    state: "visible",
    timeout: E2E_TIMEOUTS.electronWindowMs,
  });
  await keyInput.fill(apiKey);

  await wizard.locator('[data-testid="onboarding-api-key-continue"]').click();

  // Completion step -> finish onboarding.
  const finishButton = wizard.locator('[data-testid="onboarding-finish"]');
  await finishButton.waitFor({
    state: "visible",
    timeout: E2E_TIMEOUTS.electronWindowMs,
  });
  await finishButton.click();

  // Onboarding completes and the app reaches ready (handling workspace picker).
  await handleWorkspacePickerIfPresent(page);
  await setAgentWorkingDirectory(page);
  await expect(page.locator("#app-ready")).toBeVisible({
    timeout: E2E_TIMEOUTS.electronWindowMs,
  });
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

/**
 * Reuse the existing ChatGPT/Codex OAuth credential without opening a browser
 * or entering an API key. The isolated E2E config receives a connection record;
 * the credential manager supplies the already-authenticated OAuth tokens.
 */
export async function completeConfiguredChatGptOnboarding(
  page: Page,
  model: string,
): Promise<void> {
  await waitForOnboardingWizard(page);

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
