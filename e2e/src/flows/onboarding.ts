import { expect, type Page } from "@playwright/test";

import { E2E_TIMEOUTS } from "../config/timeouts.ts";
import { readAnthropicApiKey } from "../harness/env.ts";
import {
  waitForOnboardingWizard,
  waitForReadyOrWorkspacePicker,
} from "./shell.ts";

/** English copy for onboarding controls (i18n keys live in packages/shared/src/i18n/locales). */
const SETUP_LATER_LABEL = "Setup later"; // onboarding.providerSelect.setupLater
const OTHER_PROVIDER_LABEL = "I use other provider"; // onboarding.providerSelect.otherProvider

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

  // Create / select the first workspace. The picker auto-selects a default
  // name; pressing the primary action button advances to the ready shell.
  const createButton = page
    .locator("#workspace-picker")
    .getByRole("button")
    .last();
  await createButton.click();
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
  await page
    .locator("#onboarding-wizard")
    .getByText(SETUP_LATER_LABEL, { exact: true })
    .click();
  await handleWorkspacePickerIfPresent(page);
}

/**
 * Real API-key path for @agent: configure a real Anthropic connection using the
 * key from root .env, then reach the ready shell.
 *
 * Flow (validated on a headed harness run, adoption guide learning #7):
 * provider select -> "I use other provider" lands on the API Configuration
 * step with an "API Key" textbox (Anthropic endpoint preselected) and a
 * Continue button.
 */
export async function completeApiKeyOnboarding(page: Page): Promise<void> {
  const apiKey = readAnthropicApiKey();
  const wizard = page.locator("#onboarding-wizard");
  await waitForOnboardingWizard(page);

  // Provider select -> "I use other provider" -> API Configuration step.
  await wizard.getByText(OTHER_PROVIDER_LABEL, { exact: true }).click();

  // Enter the key into the "API Key" textbox and continue.
  const keyInput = wizard.getByRole("textbox", { name: "API Key" });
  await keyInput.waitFor({ state: "visible", timeout: E2E_TIMEOUTS.electronWindowMs });
  await keyInput.fill(apiKey);

  await wizard.getByRole("button", { name: "Continue" }).click();

  // Completion step: "You're all set!" -> "Get Started" finalizes onboarding.
  const getStarted = wizard.getByRole("button", { name: "Get Started" });
  await getStarted.waitFor({ state: "visible", timeout: E2E_TIMEOUTS.electronWindowMs });
  await getStarted.click();

  // Onboarding completes and the app reaches ready (handling workspace picker).
  await handleWorkspacePickerIfPresent(page);
  await expect(page.locator("#app-ready")).toBeVisible({ timeout: E2E_TIMEOUTS.electronWindowMs });
}
