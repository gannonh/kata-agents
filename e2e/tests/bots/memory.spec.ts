import { join } from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { E2E_TAGS } from "../../src/config/tags.ts";
import { agentSuiteTimeoutMs, runWithAgentProviderFallback } from "../../src/flows/agentChat.ts";
import { configureAgentConnection, resumeAfterAppRestart } from "../../src/flows/onboarding.ts";
import { waitForAppReady } from "../../src/flows/shell.ts";
import { expect, test } from "../../src/fixtures/testFixtures.ts";
import { buildElectronLaunchEnv } from "../../src/harness/launchEnv.ts";
import { formatMissingPrerequisiteError, readAgentProviderPrerequisite } from "../../src/harness/env.ts";

test.describe.configure({ mode: "serial", timeout: agentSuiteTimeoutMs() });

async function restart(current: ElectronApplication, context: { repoRoot: string }): Promise<{ app: ElectronApplication; page: Page }> {
  await current.close();
  const env = Object.fromEntries(Object.entries(buildElectronLaunchEnv(context)).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const app = await electron.launch({ args: [join(context.repoRoot, "apps/electron")], cwd: context.repoRoot, env });
  const page = await app.firstWindow();
  await resumeAfterAppRestart(page);
  await expect(page.locator("body")).toContainText(/New Session|Bots/i, { timeout: 30_000 });
  return { app, page };
}

test.describe(`Bot memory and compaction ${E2E_TAGS.memory}`, () => {
  test("establishes, edits, forgets, compacts, and recovers Bot context", async ({ appWindow, electronApp, runContext }) => {
    const prerequisite = readAgentProviderPrerequisite();
    if (!prerequisite.ok) throw new Error(formatMissingPrerequisiteError("Bot memory", prerequisite.missing));
    let page = appWindow;
    let app = electronApp;
    await runWithAgentProviderFallback(page, "Bot memory", async candidate => {
      await configureAgentConnection(page, candidate);
      await waitForAppReady(page);
      await page.getByTestId("bots-nav").click();
      await page.getByTestId("bots-create-button").click();
      const botName = `Memory Bot ${Date.now()}`;
      await page.getByTestId("bots-name-input").fill(botName);
      await page.getByTestId("bots-create-submit").click();
      await expect(page.getByTestId("bot-chat")).toBeVisible();

      const preference = "Please remember for future chats: I prefer violet replies.";
      await page.getByTestId("bot-chat-input").fill(preference);
      await page.getByTestId("bot-chat-send").click();
      await expect(page.locator('[data-testid^="bot-journal-entry-"][data-entry-kind="user"]').filter({ hasText: preference })).toBeVisible();
      const memory = page.locator('[data-testid^="bot-memory-"][data-memory-state="active"]').first();
      await expect(memory).toBeVisible();
      await expect(memory).toHaveAttribute("data-memory-provenance", /chat_|entry_/);
      await expect(page.getByTestId("bot-memory-context")).toHaveAttribute("data-memory-ids", /memory_/);
      await page.screenshot({ path: test.info().outputPath("memory-before-edit.png") });

      const memoryId = (await memory.getAttribute("data-testid"))!.replace("bot-memory-", "");
      const input = page.getByTestId(`bot-memory-input-${memoryId}`);
      await input.fill("I prefer short violet replies.");
      await page.getByTestId(`bot-memory-save-${memoryId}`).click();
      await expect(page.getByTestId(`bot-memory-${memoryId}`)).toHaveAttribute("data-memory-state", "edited");
      await page.getByTestId(`bot-memory-forget-${memoryId}`).click();
      await expect(page.getByTestId(`bot-memory-${memoryId}`)).toHaveAttribute("data-memory-state", "forgotten");
      await expect(page.getByTestId("bot-memory-context")).toHaveAttribute("data-memory-ids", "");
      await page.screenshot({ path: test.info().outputPath("memory-forgotten.png") });

      for (let index = 0; index < 12; index += 1) {
        await page.getByTestId("bot-chat-input").fill(`Compaction continuity turn ${index}`);
        await page.getByTestId("bot-chat-send").click();
        await expect(page.locator('[data-testid^="bot-journal-entry-"][data-entry-kind="user"]').filter({ hasText: `Compaction continuity turn ${index}` })).toBeVisible();
      }
      await expect(page.getByTestId("bot-memory-context")).toContainText(/checkpoint/i);
      const beforeRestart = await page.locator('[data-testid^="bot-journal-entry-"]').count();
      const restarted = await restart(app, runContext);
      app = restarted.app;
      page = restarted.page;
      await page.getByTestId("bots-nav").click();
      await page.locator("[data-testid^='bot-row-']").filter({ hasText: botName }).click();
      await expect(page.getByTestId("bot-chat")).toBeVisible();
      await expect(page.locator('[data-testid^="bot-journal-entry-"]')).toHaveCount(beforeRestart);
      await expect(page.getByTestId(`bot-memory-${memoryId}`)).toHaveAttribute("data-memory-state", "forgotten");
      await expect(page.getByTestId("bot-memory-context")).toHaveAttribute("data-memory-ids", "");
      await page.screenshot({ path: test.info().outputPath("memory-forgotten-after-restart.png") });
    });
  });
});
