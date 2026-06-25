import { E2E_TAGS } from "../../src/config/tags.ts";
import {
  expectResolvedTheme,
  openAppearanceSettings,
  readStoredThemeMode,
  setThemeMode,
} from "../../src/flows/settings.ts";
import { test, expect } from "../../src/fixtures/testFixtures.ts";

test.describe(`Settings appearance ${E2E_TAGS.settings}`, () => {
  test("persists dark theme mode after reload", async ({ authenticatedAppWindow }) => {
    await openAppearanceSettings(authenticatedAppWindow);
    await setThemeMode(authenticatedAppWindow, "dark");

    await authenticatedAppWindow.reload({ waitUntil: "domcontentloaded" });

    await expectResolvedTheme(authenticatedAppWindow, "dark");
    expect(await readStoredThemeMode(authenticatedAppWindow)).toBe("dark");
  });
});
