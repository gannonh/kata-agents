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

test.describe.configure({ mode: "serial", timeout: agentSuiteTimeoutMs() });

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

test.describe(`Named bots durable chat ${E2E_TAGS.bots}`, () => {
  test("creates a Bot, completes one exchange, and reopens the same chat after restart", async ({
    appWindow,
    electronApp,
    runContext,
  }) => {
    const prerequisite = readAgentProviderPrerequisite();
    if (!prerequisite.ok) {
      throw new Error(
        formatMissingPrerequisiteError("Bots durable chat", prerequisite.missing),
      );
    }

    let page = appWindow;
    let app = electronApp;

    await runWithAgentProviderFallback(page, "Bots durable chat", async (candidate) => {
      const turn = buildDeterministicAgentTurn();
      const botName = `E2E Bot ${candidate.provider} ${Date.now()}`;

      await configureAgentConnection(page, candidate);
      await waitForAppReady(page);

      await page.getByTestId("bots-nav").scrollIntoViewIfNeeded();
      await page.getByTestId("bots-nav").click();
      await expect(page.getByTestId("bots-create-button")).toBeVisible({ timeout: 15_000 });
      await page.getByTestId("bots-create-button").click();
      await page.getByTestId("bots-name-input").fill(botName);
      await page.getByTestId("bots-create-submit").click();

      await expect(page.getByTestId("bot-chat")).toBeVisible({ timeout: 15_000 });
      const botRow = page.locator("[data-testid^='bot-row-']").filter({ hasText: botName }).first();
      await expect(botRow).toBeVisible({ timeout: 15_000 });

      await page.getByTestId("bot-chat-input").fill(turn.prompt);
      await page.getByTestId("bot-chat-send").click();

      const userEntry = page.locator('[data-testid^="bot-journal-entry-"][data-entry-kind="user"]').filter({
        hasText: turn.prompt,
      });
      const botEntry = page.locator('[data-testid^="bot-journal-entry-"][data-entry-kind="bot"]').filter({
        hasText: turn.expected,
      });
      await expect(userEntry).toBeVisible({ timeout: E2E_TIMEOUTS.agentReplyMs });
      await expect(botEntry).toBeVisible({ timeout: E2E_TIMEOUTS.agentReplyMs });

      const beforeRestart = await page.locator("[data-testid^='bot-journal-entry-']").allTextContents();
      const restarted = await restartElectron(app, runContext);
      app = restarted.app;
      page = restarted.page;
      await waitForAppReady(page);

      await page.getByTestId("bots-nav").scrollIntoViewIfNeeded();
      await page.getByTestId("bots-nav").click();
      const reopened = page.locator("[data-testid^='bot-row-']").filter({ hasText: botName }).first();
      await expect(reopened).toBeVisible({ timeout: 15_000 });
      await reopened.click();

      await expect(page.getByTestId("bot-chat")).toBeVisible();
      await expect(
        page.locator('[data-testid^="bot-journal-entry-"][data-entry-kind="user"]').filter({
          hasText: turn.prompt,
        }),
      ).toBeVisible();
      await expect(
        page.locator('[data-testid^="bot-journal-entry-"][data-entry-kind="bot"]').filter({
          hasText: turn.expected,
        }),
      ).toBeVisible();
      const afterRestart = await page.locator("[data-testid^='bot-journal-entry-']").allTextContents();
      expect(afterRestart).toEqual(beforeRestart);
    });
  });
});
