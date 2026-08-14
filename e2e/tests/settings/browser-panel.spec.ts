import { E2E_TAGS } from "../../src/config/tags.ts";
import { E2E_TIMEOUTS } from "../../src/config/timeouts.ts";
import {
  attachBrowserToPanel,
  detachBrowser,
  expectBrowserPanelHidden,
  expectBrowserPanelVisible,
  hideBrowser,
  listBrowserInstances,
  navigateBrowser,
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

  test("exposes Annotate chrome in the panel and preserves it across detach", async ({
    authenticatedAppWindow,
  }) => {
    const instanceId = await openNewBrowser(authenticatedAppWindow);
    await expectBrowserPanelVisible(authenticatedAppWindow, instanceId);

    const annotate = authenticatedAppWindow.locator("#browser-annotate-toggle");
    await expect(annotate).toBeVisible({ timeout: E2E_TIMEOUTS.assertionMs });
    await expect(annotate).toBeDisabled();
    await expect(authenticatedAppWindow.locator("#browser-annotation-tray")).toHaveCount(0);

    const fixtureUrl = `data:text/html;charset=utf-8,${encodeURIComponent("<!doctype html><title>Annotate fixture</title><button>Save</button>")}`;
    await navigateBrowser(authenticatedAppWindow, instanceId, fixtureUrl);
    await expect(annotate).toBeEnabled({ timeout: E2E_TIMEOUTS.authMs });

    await annotate.click();
    await expect(annotate).toHaveAttribute("aria-pressed", "true");
    await annotate.click();
    await expect(annotate).toHaveAttribute("aria-pressed", "false");

    await detachBrowser(authenticatedAppWindow, instanceId);
    await expectBrowserPanelHidden(authenticatedAppWindow);
    await attachBrowserToPanel(authenticatedAppWindow, instanceId);
    await expectBrowserPanelVisible(authenticatedAppWindow, instanceId);
    await expect(authenticatedAppWindow.locator("#browser-annotate-toggle")).toBeVisible();
  });
});
