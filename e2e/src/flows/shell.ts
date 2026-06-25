import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "@playwright/test";

import { E2E_TIMEOUTS } from "../config/timeouts.ts";

/** #root always exists in index.html (holds a pre-mount loader). */
export const ROOT_SELECTOR = "#root";
/** Added in OnboardingWizard.tsx; present only on the onboarding screen. */
export const ONBOARDING_SELECTOR = "#onboarding-wizard";
/** Added in App.tsx ready render; present only when appState === 'ready'. */
export const APP_READY_SELECTOR = "#app-ready";
/** Added in WorkspacePicker.tsx; present on the workspace-picker screen. */
export const WORKSPACE_PICKER_SELECTOR = "#workspace-picker";

export async function waitForRootMounted(page: Page, timeoutMs = E2E_TIMEOUTS.assertionMs): Promise<void> {
  await page.locator(ROOT_SELECTOR).waitFor({ state: "attached", timeout: timeoutMs });
}

export async function waitForOnboardingWizard(
  page: Page,
  timeoutMs = E2E_TIMEOUTS.electronWindowMs,
): Promise<void> {
  await page.locator(ONBOARDING_SELECTOR).waitFor({ state: "visible", timeout: timeoutMs });
}

export async function waitForAppReady(
  page: Page,
  timeoutMs = E2E_TIMEOUTS.electronWindowMs,
): Promise<void> {
  await page.locator(APP_READY_SELECTOR).waitFor({ state: "visible", timeout: timeoutMs });
}

export async function isWorkspacePickerVisible(page: Page): Promise<boolean> {
  return await page
    .locator(WORKSPACE_PICKER_SELECTOR)
    .isVisible()
    .catch(() => false);
}

/**
 * Poll for either the ready shell or the workspace picker. Returns which one
 * appeared so the auth flow can handle the picker before asserting ready.
 */
export async function waitForReadyOrWorkspacePicker(
  page: Page,
  timeoutMs = E2E_TIMEOUTS.electronWindowMs,
): Promise<"ready" | "workspace-picker"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.locator(APP_READY_SELECTOR).isVisible().catch(() => false)) {
      return "ready";
    }
    if (await isWorkspacePickerVisible(page)) {
      return "workspace-picker";
    }
    await delay(250);
  }
  throw new Error(
    "E2E shell: neither #app-ready nor #workspace-picker became visible within the timeout.",
  );
}
