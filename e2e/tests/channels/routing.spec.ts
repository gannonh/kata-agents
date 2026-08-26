import { join } from "node:path";
import { _electron as electron, type ElectronApplication, type Locator, type Page } from "@playwright/test";

import { E2E_TAGS } from "../../src/config/tags.ts";
import { E2E_TIMEOUTS } from "../../src/config/timeouts.ts";
import {
  agentSuiteTimeoutMs,
  buildDeterministicAgentTurn,
  runWithAgentProviderFallback,
} from "../../src/flows/agentChat.ts";
import { configureAgentConnection, resumeAfterAppRestart } from "../../src/flows/onboarding.ts";
import { waitForAppReady } from "../../src/flows/shell.ts";
import { expect, test } from "../../src/fixtures/testFixtures.ts";
import { buildElectronLaunchEnv } from "../../src/harness/launchEnv.ts";
import type { E2ERunContext } from "../../src/harness/isolatedRun.ts";
import {
  formatMissingPrerequisiteError,
  readAgentProviderPrerequisite,
} from "../../src/harness/env.ts";

test.describe.configure({ mode: "serial", timeout: agentSuiteTimeoutMs() * 2 });

const RESEARCH_PROFILE =
  "Gathers evidence. Searches sources, reads documents, and summarizes findings with citations.";
const RELEASE_PROFILE =
  "Ships releases. Bumps versions, writes changelogs, and tags builds.";

async function restartElectron(
  current: ElectronApplication,
  context: E2ERunContext,
): Promise<{ app: ElectronApplication; page: Page }> {
  await current.close();
  const env = Object.fromEntries(
    Object.entries(buildElectronLaunchEnv(context)).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const app = await electron.launch({
    args: [join(context.repoRoot, "apps/electron")],
    cwd: context.repoRoot,
    env,
  });
  const page = await app.firstWindow();
  await resumeAfterAppRestart(page);
  await expect(page.locator("body")).toContainText(/New Session|Bots|Channels/i, {
    timeout: 30_000,
  });
  return { app, page };
}

async function openBots(page: Page): Promise<void> {
  await page.getByTestId("bots-nav").scrollIntoViewIfNeeded();
  await page.getByTestId("bots-nav").click();
  await expect(page.getByTestId("bots-create-button")).toBeVisible({ timeout: 15_000 });
}

async function openChannels(page: Page): Promise<void> {
  await page.getByTestId("channels-nav").scrollIntoViewIfNeeded();
  await page.getByTestId("channels-nav").click();
  await expect(page.getByTestId("channels-create-button")).toBeVisible({ timeout: 15_000 });
}

async function createBot(page: Page, name: string, profile: string): Promise<string> {
  await openBots(page);
  await page.getByTestId("bots-create-button").click();
  await page.getByTestId("bots-name-input").fill(name);
  await page.getByTestId("bots-profile-input").fill(profile);
  await page.getByTestId("bots-create-submit").click();

  const row = page.locator("[data-testid^='bot-row-']").filter({ hasText: name }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  const testId = await row.getAttribute("data-testid");
  const botId = testId?.replace("bot-row-", "");
  expect(botId, `bot row for ${name} carries a bot ID`).toBeTruthy();
  return botId as string;
}

async function createChannel(page: Page, name: string): Promise<string> {
  await openChannels(page);
  await page.getByTestId("channels-create-button").click();
  await page.getByTestId("channels-name-input").fill(name);
  await page.getByTestId("channels-create-submit").click();

  const row = page.locator("[data-testid^='channel-row-']").filter({ hasText: name }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  await expect(page.getByTestId("channel-chat")).toBeVisible({ timeout: 15_000 });
  const testId = await row.getAttribute("data-testid");
  return (testId as string).replace("channel-row-", "");
}

async function addMember(page: Page, botName: string, botId: string): Promise<void> {
  await page.getByTestId("channel-member-add").click();
  await page.getByTestId("channel-member-input").fill(botName);
  await page.getByTestId("channel-member-submit").click();
  await expect(page.getByTestId(`channel-member-${botId}`)).toBeVisible({ timeout: 15_000 });
}

function routeRows(page: Page): Locator {
  return page.locator("[data-testid^='channel-route-']");
}

async function sendAndAwaitRoute(page: Page, message: string, priorRoutes: number): Promise<Locator> {
  await page.getByTestId("channel-chat-input").fill(message);
  await page.getByTestId("channel-chat-send").click();
  await expect(routeRows(page)).toHaveCount(priorRoutes + 1, {
    timeout: E2E_TIMEOUTS.agentReplyMs,
  });
  return routeRows(page).last();
}

test.describe(`Channel routing ${E2E_TAGS.channels}`, () => {
  test("routes autonomously, honors mentions, fans out, and survives restart", async ({
    appWindow,
    electronApp,
    runContext,
    }, testInfo) => {
    const prerequisite = readAgentProviderPrerequisite();
    if (!prerequisite.ok) {
      throw new Error(
        formatMissingPrerequisiteError("Channel routing", prerequisite.missing),
      );
    }

    let page = appWindow;
    let app = electronApp;

    try {
      await runWithAgentProviderFallback(page, "Channel routing", async (candidate) => {
      const stamp = `${candidate.provider} ${Date.now()}`;
      const researchName = `Research Bot ${stamp}`;
      const releaseName = `Release Bot ${stamp}`;
      const channelName = `E2E Channel ${stamp}`;

      await configureAgentConnection(page, candidate);
      await waitForAppReady(page);

      const researchId = await createBot(page, researchName, RESEARCH_PROFILE);
      const releaseId = await createBot(page, releaseName, RELEASE_PROFILE);

      await createChannel(page, channelName);
      await addMember(page, researchName, researchId);
      await addMember(page, releaseName, releaseId);
      await page.screenshot({ path: testInfo.outputPath("channels-created.png"), fullPage: true });

      const autonomous = await sendAndAwaitRoute(
        page,
        "Gather evidence on how our retry backoff behaves under load and summarize what you find.",
        0,
      );
      await expect(autonomous).toHaveAttribute("data-route-mode", "autonomous");
      await expect(autonomous).toHaveAttribute("data-owner-bot-id", researchId);

      const mentionTurn = buildDeterministicAgentTurn();
      const explicit = await sendAndAwaitRoute(
        page,
        `@${releaseName} ${mentionTurn.prompt}`,
        1,
      );
      await expect(explicit).toHaveAttribute("data-route-mode", "explicit");
      await expect(explicit).toHaveAttribute("data-owner-bot-id", releaseId);
      await expect(
        page
          .locator('[data-testid^="channel-journal-entry-"][data-entry-kind="bot"]')
          .filter({ hasText: mentionTurn.expected }),
      ).toBeVisible({ timeout: E2E_TIMEOUTS.agentReplyMs });

      const fanOut = await sendAndAwaitRoute(
        page,
        `@${researchName} @${releaseName} Each of you reply with your own name and nothing else.`,
        2,
      );
      await expect(fanOut).toHaveAttribute("data-route-mode", "explicit");
      const fanOutOwners = await fanOut.getAttribute("data-owner-bot-id");
      expect(fanOutOwners?.split(" ").sort()).toEqual([researchId, releaseId].sort());

      const beforeRestart = await page
        .locator("[data-testid^='channel-journal-entry-']")
        .allTextContents();
      const routeEvidenceBefore = await routeRows(page).allTextContents();
      await page.screenshot({ path: testInfo.outputPath("channels-routing.png"), fullPage: true });

      const restarted = await restartElectron(app, runContext);
      app = restarted.app;
      page = restarted.page;
      await waitForAppReady(page);

      await openChannels(page);
      const reopened = page
        .locator("[data-testid^='channel-row-']")
        .filter({ hasText: channelName })
        .first();
      await expect(reopened).toBeVisible({ timeout: 15_000 });
      await reopened.click();
      await expect(page.getByTestId("channel-chat")).toBeVisible();

      await expect(routeRows(page)).toHaveCount(3, { timeout: 15_000 });
      expect(
        await page.locator("[data-testid^='channel-journal-entry-']").allTextContents(),
      ).toEqual(beforeRestart);
      expect(await routeRows(page).allTextContents()).toEqual(routeEvidenceBefore);
      await page.screenshot({ path: testInfo.outputPath("channels-restored.png"), fullPage: true });
      });
    } finally {
      if (app !== electronApp) await app.close();
    }
  });
});
