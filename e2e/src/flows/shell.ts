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

/**
 * Wait for the first real shell screen after Electron/Vite startup.
 *
 * This is a startup wait, not an assertion wait: a cold renderer can take
 * longer than the per-assertion budget while the app initializes its config
 * and session services.
 */
export async function waitForRootMounted(page: Page, timeoutMs = E2E_TIMEOUTS.electronWindowMs): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.locator(ONBOARDING_SELECTOR).isVisible().catch(() => false)) {
      return;
    }
    if (await page.locator(APP_READY_SELECTOR).isVisible().catch(() => false)) {
      return;
    }
    if (await isWorkspacePickerVisible(page)) {
      return;
    }
    await delay(100);
  }
  throw new Error(`E2E shell: renderer did not mount within ${timeoutMs}ms.`);
}

export async function waitForOnboardingWizard(
  page: Page,
  timeoutMs = E2E_TIMEOUTS.electronWindowMs,
): Promise<void> {
  await page.locator(ONBOARDING_SELECTOR).waitFor({ state: "visible", timeout: timeoutMs });
}

/** Wait for the onboarding wizard or a shell that has already completed setup. */
export async function waitForOnboardingOrReady(
  page: Page,
  timeoutMs = E2E_TIMEOUTS.electronWindowMs,
): Promise<"onboarding" | "ready" | "workspace-picker"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.locator(ONBOARDING_SELECTOR).isVisible().catch(() => false)) {
      return "onboarding";
    }
    if (await page.locator(APP_READY_SELECTOR).isVisible().catch(() => false)) {
      return "ready";
    }
    if (await isWorkspacePickerVisible(page)) {
      return "workspace-picker";
    }
    await delay(100);
  }
  throw new Error(
    `E2E shell: onboarding or a ready shell did not become visible within ${timeoutMs}ms.`,
  );
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
