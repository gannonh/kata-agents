import { expect, type Page } from "@playwright/test";

import { E2E_TIMEOUTS } from "../config/timeouts.ts";

export type ThemeMode = "system" | "light" | "dark";

/** English labels for the appearance Mode radio (settings.appearance.{light,dark,system}). */
const MODE_LABELS: Record<ThemeMode, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

/**
 * Open the Appearance settings page via the renderer navigation event.
 * Mirrors navigate(routes.view.settings('appearance')) in
 * apps/electron/src/renderer/lib/navigate.ts: the NavigationContext listens for
 * the 'kata-agent-navigate' event with detail `{ route }`. Driving navigation
 * directly avoids depending on the i18n-dependent top-bar menu DOM.
 */
export async function openAppearanceSettings(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("kata-agent-navigate", { detail: { route: "settings/appearance" } }),
    );
  });
  // The Mode radiogroup is unique to the appearance page.
  await page
    .getByRole("radiogroup")
    .first()
    .waitFor({ state: "visible", timeout: E2E_TIMEOUTS.electronWindowMs });
}

export async function setThemeMode(page: Page, mode: ThemeMode): Promise<void> {
  await page.getByText(MODE_LABELS[mode], { exact: true }).first().click();
  if (mode === "dark") {
    await expectResolvedTheme(page, "dark");
  } else if (mode === "light") {
    await expectResolvedTheme(page, "light");
  }
}

/** The renderer toggles a `dark` class on <html> for the resolved theme. */
export async function expectResolvedTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  if (theme === "dark") {
    await expect(page.locator("html")).toHaveClass(/dark/);
  } else {
    await expect(page.locator("html")).not.toHaveClass(/dark/);
  }
}

/**
 * Read the persisted theme mode from localStorage. The renderer namespaces keys
 * with a prefix (see local-storage.ts), so match on the `theme` suffix rather
 * than hardcoding the prefix.
 */
export async function readStoredThemeMode(page: Page): Promise<string | null> {
  return await page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.endsWith("theme")) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      try {
        return (JSON.parse(raw) as { mode?: string }).mode ?? null;
      } catch {
        return null;
      }
    }
    return null;
  });
}
