import { E2E_TAGS } from "../../src/config/tags.ts";
import {
  attachBrowserToPanel,
  detachBrowser,
  expectBrowserPanelHidden,
  expectBrowserPanelVisible,
  hideBrowser,
  listBrowserInstances,
  openNewBrowser,
} from "../../src/flows/browser.ts";
import { test, expect } from "../../src/fixtures/testFixtures.ts";

test.describe(`Embedded browser panel ${E2E_TAGS.settings}`, () => {
  test("opens an integrated panel by default and round-trips detach without replacing the instance", async ({
    authenticatedAppWindow,
  }) => {
    const instanceId = await openNewBrowser(authenticatedAppWindow);
    await expectBrowserPanelVisible(authenticatedAppWindow, instanceId);

    await detachBrowser(authenticatedAppWindow, instanceId);
    await expectBrowserPanelHidden(authenticatedAppWindow);
    const detached = await listBrowserInstances(authenticatedAppWindow);
    expect(detached.some((item) => item.id === instanceId && item.surface === "detached")).toBe(true);

    await attachBrowserToPanel(authenticatedAppWindow, instanceId);
    await expectBrowserPanelVisible(authenticatedAppWindow, instanceId);

    await hideBrowser(authenticatedAppWindow, instanceId);
    await expectBrowserPanelHidden(authenticatedAppWindow);
    const hidden = await listBrowserInstances(authenticatedAppWindow);
    expect(hidden.some((item) => item.id === instanceId)).toBe(true);
  });
});
