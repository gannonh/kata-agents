import { E2E_TAGS } from "../../src/config/tags.ts";
import { E2E_TIMEOUTS } from "../../src/config/timeouts.ts";
import {
  agentSuiteTimeoutMs,
  runWithAgentProviderFallback,
  selectModel,
  startNewSession,
} from "../../src/flows/agentChat.ts";
import {
  annotateFixtureUrl,
  clickGuestAnnotateTarget,
  expectBrowserPanelVisible,
  navigateBrowser,
  openNewBrowser,
  submitAnnotationComposer,
  waitForGuestFixture,
  waitForGuestGrabArmed,
} from "../../src/flows/browser.ts";
import { configureAgentConnection } from "../../src/flows/onboarding.ts";
import { waitForAppReady } from "../../src/flows/shell.ts";
import {
  formatMissingPrerequisiteError,
  readAgentProviderPrerequisite,
} from "../../src/harness/env.ts";
import { expect, test } from "../../src/fixtures/testFixtures.ts";

test.describe.configure({ mode: "serial", timeout: agentSuiteTimeoutMs() });

test.describe(`Browser page annotations ${E2E_TAGS.browser}`, () => {
  test("annotates a page element and sends the note to a running agent session", async ({
    appWindow,
    electronApp,
  }) => {
    const prerequisite = readAgentProviderPrerequisite();
    if (!prerequisite.ok) {
      throw new Error(
        formatMissingPrerequisiteError(
          "Browser annotation test",
          prerequisite.missing,
        ),
      );
    }

    const comment = `E2E_ANNOTATE_${crypto.randomUUID().slice(0, 8)}`;
    const page = appWindow;

    await runWithAgentProviderFallback(page, "Browser annotations", async (candidate) => {
      await configureAgentConnection(page, candidate);
      await waitForAppReady(page);

      await startNewSession(page);
      await selectModel(page, candidate.model);

      const instanceId = await openNewBrowser(page);
      await expectBrowserPanelVisible(page, instanceId);
      await navigateBrowser(page, instanceId, annotateFixtureUrl());
      await waitForGuestFixture(electronApp);

      const annotate = page.locator("#browser-annotate-toggle");
      await expect(annotate).toBeEnabled({ timeout: E2E_TIMEOUTS.authMs });
      await annotate.click();
      await expect(annotate).toHaveAttribute("aria-pressed", "true");

      const guestId = await waitForGuestGrabArmed(electronApp);
      await clickGuestAnnotateTarget(electronApp, guestId);
      await expect(page.getByRole("button", { name: "Cancel pending annotation" })).toBeVisible({
        timeout: E2E_TIMEOUTS.authMs,
      });

      await submitAnnotationComposer(electronApp, comment);
      const tray = page.locator("#browser-annotation-tray");
      await expect(tray).toBeVisible({ timeout: E2E_TIMEOUTS.assertionMs });
      await expect(tray).toContainText(comment);

      await page.getByRole("button", { name: "Send to session" }).click();
      const picker = page.locator('[data-slot="popover-content"]');
      await expect(picker).toBeVisible({ timeout: E2E_TIMEOUTS.assertionMs });
      await picker.getByRole("button").first().click();

      const userTurn = page.getByTestId("user-turn").last();
      await expect(userTurn.getByRole("heading", { name: /Page feedback/ })).toBeVisible({
        timeout: E2E_TIMEOUTS.agentReplyMs,
      });
      await expect(userTurn).toContainText(comment);
      await expect(page.getByTestId("assistant-turn").last()).toBeVisible({
        timeout: E2E_TIMEOUTS.agentReplyMs,
      });
    });
  });
});
