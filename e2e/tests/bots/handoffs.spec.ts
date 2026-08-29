import { join } from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";

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
  await expect(page.locator("body")).toContainText(/New Session|Bots/i, {
    timeout: 30_000,
  });
  return { app, page };
}

async function openBot(page: Page, name: string): Promise<void> {
  await page.getByTestId("bots-nav").scrollIntoViewIfNeeded();
  await page.getByTestId("bots-nav").click();
  const row = page.locator("[data-testid^='bot-row-']").filter({ hasText: name }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  await expect(page.getByTestId("bot-chat")).toBeVisible({ timeout: 15_000 });
}

async function createBot(page: Page, name: string, profile: string): Promise<void> {
  await page.getByTestId("bots-nav").scrollIntoViewIfNeeded();
  await page.getByTestId("bots-nav").click();
  await page.getByTestId("bots-create-button").click();
  await page.getByTestId("bots-name-input").fill(name);
  await page.getByTestId("bots-profile-input").fill(profile);
  await page.getByTestId("bots-create-submit").click();
  await expect(page.locator("[data-testid^='bot-row-']").filter({ hasText: name }).first()).toBeVisible({ timeout: 15_000 });
}

test.describe(`Bot handoffs ${E2E_TAGS.handoffs}`, () => {
  test("delegates to a second Bot, opens the rail, and recovers one card after restart", async ({
    appWindow,
    electronApp,
    runContext,
  }, testInfo) => {
    const prerequisite = readAgentProviderPrerequisite();
    if (!prerequisite.ok) {
      throw new Error(formatMissingPrerequisiteError("Bot handoffs", prerequisite.missing));
    }

    let page = appWindow;
    let app = electronApp;

    try {
      await runWithAgentProviderFallback(page, "Bot handoffs", async candidate => {
        await configureAgentConnection(page, candidate);
        await waitForAppReady(page);

        const stamp = `${candidate.provider} ${Date.now()}`;
        const sourceName = `Handoff Source ${stamp}`;
        const targetName = `Handoff Target ${stamp}`;
        const targetTurn = buildDeterministicAgentTurn();

        await createBot(page, sourceName, "Delegates bounded requests to the named target Bot.");
        await createBot(page, targetName, "Completes delegated requests and returns concise evidence.");
        await openBot(page, sourceName);

        const handoffPrompt = [
          "Use send_handoff exactly once now.",
          `Set targetBot to ${targetName}.`,
          `Set request to: ${targetTurn.prompt}`,
          "Wait for the tool result, then reply with only the returned handoff id.",
        ].join(" ");
        await page.getByTestId("bot-chat-input").fill(handoffPrompt);
        await page.getByTestId("bot-chat-send").click();

        const cards = page.locator("[data-testid^='handoff-card-'][data-handoff-id]");
        await expect(cards).toHaveCount(1, { timeout: E2E_TIMEOUTS.agentReplyMs });
        await expect(cards.first()).toContainText(sourceName);
        await expect(cards.first()).toContainText(targetName);
        await page.screenshot({ path: testInfo.outputPath("handoff-card.png"), fullPage: true });
        await cards.first().click();

        await expect(page.getByTestId(/handoff-rail-/)).toBeVisible({ timeout: 15_000 });
        await expect(page.getByTestId("handoff-rail-result")).toContainText(
          targetTurn.expected,
          { timeout: E2E_TIMEOUTS.agentReplyMs },
        );
        await expect(page.locator("[data-testid^='handoff-exchange-']")).toHaveCount(2);
        await expect(page.locator("[data-testid^='handoff-exchange-']").first()).toContainText(sourceName);
        await expect(page.locator("[data-testid^='handoff-exchange-']").last()).not.toContainText("handoff-terminal");
        await expect(cards.first()).toContainText(targetTurn.expected);
        await page.screenshot({ path: testInfo.outputPath("handoff-rail-complete.png"), fullPage: true });

        const railResult = await page.getByTestId("handoff-rail-result").textContent();
        expect(railResult).toContain(targetTurn.expected);

        const restarted = await restartElectron(app, runContext);
        app = restarted.app;
        page = restarted.page;
        await waitForAppReady(page);
        await openBot(page, sourceName);

        const recoveredCards = page.locator("[data-testid^='handoff-card-'][data-handoff-id]");
        await expect(recoveredCards).toHaveCount(1, { timeout: 15_000 });
        await expect(recoveredCards.first()).toContainText(targetTurn.expected);
        await recoveredCards.first().click();
        await expect(page.getByTestId("handoff-rail-result")).toContainText(targetTurn.expected, {
          timeout: 15_000,
        });
        await page.screenshot({ path: testInfo.outputPath("handoff-recovered.png"), fullPage: true });
      });
    } finally {
      if (app !== electronApp) await app.close();
    }
  });
});
