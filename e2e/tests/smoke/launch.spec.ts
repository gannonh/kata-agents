import { assertNoFatalLaunchErrors } from "../../src/assertions/appAssertions.ts";
import { E2E_TAGS } from "../../src/config/tags.ts";
import { waitForOnboardingWizard } from "../../src/flows/shell.ts";
import { test, expect } from "../../src/fixtures/testFixtures.ts";

test.describe(`App launch ${E2E_TAGS.smoke}`, () => {
  test("launches Electron and renders the onboarding wizard with no fatal errors", async ({
    launchedApp,
    appWindow,
  }) => {
    await expect(appWindow.locator("#root")).toBeAttached();
    await waitForOnboardingWizard(appWindow);
    assertNoFatalLaunchErrors(launchedApp.readFatalErrors());
  });
});
