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
  const existingWorkspace = picker.locator('[data-testid^="workspace-select-"]').first();
  if (await existingWorkspace.count()) {
    await existingWorkspace.click();
  } else {
    const workspaceName = `E2E Workspace ${Date.now()}`;
    await picker.locator('[data-testid="workspace-create-input"]').fill(workspaceName);
    await picker.locator('[data-testid="workspace-create-button"]').click();
  }

  await waitForReadyOrWorkspacePicker(page).then((state) => {
    if (state !== "ready") {
      throw new Error("Workspace picker did not advance to the ready shell after selection.");
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
 * NOTE: the validated UI path is the Anthropic API-key endpoint. The provider
 * is resolved from KATA_E2E_AGENT_PROVIDER (default anthropic); a non-anthropic
 * provider that needs a different onboarding UI must extend this flow.
 */
export async function completeApiKeyOnboarding(page: Page): Promise<void> {
  const { apiKey } = readAgentProviderConfig();
  const wizard = page.locator("#onboarding-wizard");
  await waitForOnboardingWizard(page);

  // Provider select -> "I use other provider" -> API Configuration step.
  await wizard.locator('[data-testid="onboarding-provider-api_key"]').click();

  // Enter the key and continue.
  const keyInput = wizard.locator("#api-key");
  await keyInput.waitFor({ state: "visible", timeout: E2E_TIMEOUTS.electronWindowMs });
  await keyInput.fill(apiKey);

  await wizard.locator('[data-testid="onboarding-api-key-continue"]').click();

  // Completion step -> finish onboarding.
  const finishButton = wizard.locator('[data-testid="onboarding-finish"]');
  await finishButton.waitFor({ state: "visible", timeout: E2E_TIMEOUTS.electronWindowMs });
  await finishButton.click();

  // Onboarding completes and the app reaches ready (handling workspace picker).
  await handleWorkspacePickerIfPresent(page);
  await expect(page.locator("#app-ready")).toBeVisible({ timeout: E2E_TIMEOUTS.electronWindowMs });
}
