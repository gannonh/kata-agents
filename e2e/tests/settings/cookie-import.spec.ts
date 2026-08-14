import { E2E_TAGS } from "../../src/config/tags.ts";
import { openBrowserSettings } from "../../src/flows/settings.ts";
import { test, expect } from "../../src/fixtures/testFixtures.ts";

const SECRET_PATTERNS = [
  /Library\/Application Support\/Google\/Chrome/i,
  /Chrome Safe Storage/i,
  /Network\/Cookies/i,
  /keychain/i,
];

test.describe(`Chrome cookie import settings ${E2E_TAGS.settings}`, () => {
  test("shows a Chrome profile picker without secret paths or keychain details", async ({
    authenticatedAppWindow,
  }) => {
    await openBrowserSettings(authenticatedAppWindow);

    const page = authenticatedAppWindow.getByTestId("browser-settings-page");
    await expect(page).toBeVisible();
    await expect(authenticatedAppWindow.getByTestId("chrome-cookie-import-button")).toBeVisible();
    await expect(authenticatedAppWindow.getByTestId("chrome-cookie-import-last")).toBeVisible();

    const missing = authenticatedAppWindow.getByTestId("chrome-cookie-import-missing");
    const profile = authenticatedAppWindow.getByTestId("chrome-cookie-import-profile");
    await expect(missing.or(profile)).toBeVisible();

    const copy = await page.innerText();
    for (const pattern of SECRET_PATTERNS) {
      expect(copy).not.toMatch(pattern);
    }
  });
});
