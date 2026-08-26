import { join } from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";

import { E2E_TAGS } from "../../src/config/tags.ts";
import { E2E_TIMEOUTS } from "../../src/config/timeouts.ts";
import {
  agentSuiteTimeoutMs,
  buildDeterministicAgentTurn,
  expectAssistantReply,
  runWithAgentProviderFallback,
  selectModel,
  sendAgentPrompt,
  startNewSession,
} from "../../src/flows/agentChat.ts";
import { configureAgentConnection, completeDeferredSetup } from "../../src/flows/onboarding.ts";
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
  await completeDeferredSetup(page);
  await expect(page.locator("body")).toContainText(/New Session|Bots/i, {
    timeout: 30_000,
  });
  return { app, page };
}

type ConvertResult = {
  botId: string;
  chatId: string;
  entryIds: string[];
  bodies: string[];
};

async function convertFocusedSession(
  page: Page,
  name: string,
  idempotencyKey: string,
): Promise<ConvertResult> {
  return page.evaluate(
    async ({ botName, key }) => {
      const api = (window as unknown as {
        electronAPI: {
          getSessions(): Promise<Array<{ id: string; workspaceId?: string; hidden?: boolean }>>;
          getWorkspaces(): Promise<Array<{ id: string }>>;
          convertSessionToBot(
            workspaceId: string,
            input: {
              sessionId: string;
              name: string;
              permissionMode: "ask";
              providerConfig: { providerId: string; modelId: string };
              idempotencyKey: string;
            },
          ): Promise<{
            bot: { botId: string; directChatId: string };
            chatId: string;
            entries: Array<{ entryId: string; body: string }>;
          }>;
        };
      }).electronAPI;

      const workspaces = await api.getWorkspaces();
      const workspaceId = workspaces[0]?.id;
      if (!workspaceId) throw new Error("No workspace for convert");

      const sessions = await api.getSessions();
      const session = sessions.find((entry) => !entry.hidden);
      if (!session) throw new Error("No legacy session to convert");

      const result = await api.convertSessionToBot(workspaceId, {
        sessionId: session.id,
        name: botName,
        permissionMode: "ask",
        providerConfig: { providerId: "openai-codex", modelId: "gpt-5" },
        idempotencyKey: key,
      });

      return {
        botId: result.bot.botId,
        chatId: result.chatId,
        entryIds: result.entries.map((entry) => entry.entryId),
        bodies: result.entries.map((entry) => entry.body),
      };
    },
    { botName: name, key: idempotencyKey },
  );
}

test.describe(`Named bots session convert ${E2E_TAGS.bots}`, () => {
  test("converts a legacy Session once and stays idempotent across restart", async ({
    appWindow,
    electronApp,
    runContext,
  }) => {
    const prerequisite = readAgentProviderPrerequisite();
    if (!prerequisite.ok) {
      throw new Error(
        formatMissingPrerequisiteError("Bots session convert", prerequisite.missing),
      );
    }

    let page = appWindow;
    let app = electronApp;
    const turn = buildDeterministicAgentTurn();
    const botName = `Converted Bot ${Date.now()}`;
    const idempotencyKey = `e2e.convert.${Date.now()}`;

    await runWithAgentProviderFallback(page, "Bots session convert", async (candidate) => {
      await configureAgentConnection(page, candidate);
      await waitForAppReady(page);
      await startNewSession(page);
      await selectModel(page, candidate.model);
      await sendAgentPrompt(page, turn.prompt);
      await expectAssistantReply(page, turn, E2E_TIMEOUTS.agentReplyMs, { match: "contains" });

      const first = await convertFocusedSession(page, botName, idempotencyKey);
      expect(first.entryIds.length).toBeGreaterThanOrEqual(2);
      expect(first.bodies.some((body) => body.includes(turn.prompt))).toBe(true);
      expect(first.bodies.some((body) => body.includes(turn.expected))).toBe(true);

      await page.getByTestId("bots-nav").click();
      const botRow = page.locator(`[data-testid='bot-row-${first.botId}']`);
      await expect(botRow).toBeVisible({ timeout: 15_000 });
      await botRow.click();
      await expect(page.getByTestId("bot-chat")).toBeVisible();
      await expect(page.locator("[data-testid^='bot-journal-entry-']")).toHaveCount(first.entryIds.length);

      const restarted = await restartElectron(app, runContext);
      app = restarted.app;
      page = restarted.page;
      await waitForAppReady(page);

      const second = await convertFocusedSession(page, botName, idempotencyKey);
      expect(second.botId).toBe(first.botId);
      expect(second.chatId).toBe(first.chatId);
      expect(second.entryIds).toEqual(first.entryIds);
      expect(second.bodies).toEqual(first.bodies);

      await page.getByTestId("bots-nav").click();
      await page.locator(`[data-testid='bot-row-${first.botId}']`).click();
      await expect(page.locator("[data-testid^='bot-journal-entry-']")).toHaveCount(first.entryIds.length);
    });
  });
});
