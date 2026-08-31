import type { Page } from "@playwright/test";

import { E2E_TAGS } from "../../src/config/tags.ts";
import { agentSuiteTimeoutMs, runWithAgentProviderFallback } from "../../src/flows/agentChat.ts";
import { configureAgentConnection } from "../../src/flows/onboarding.ts";
import { waitForAppReady } from "../../src/flows/shell.ts";
import { expect, test } from "../../src/fixtures/testFixtures.ts";
import {
  formatMissingPrerequisiteError,
  readAgentProviderPrerequisite,
} from "../../src/harness/env.ts";

async function createBot(page: Page, name: string): Promise<void> {
  await page.getByTestId("bots-nav").scrollIntoViewIfNeeded();
  await page.getByTestId("bots-nav").click();
  await page.getByTestId("bots-create-button").click();
  await page.getByTestId("bots-name-input").fill(name);
  await page.getByTestId("bots-profile-input").fill("Runs short durable routines.");
  await page.getByTestId("bots-create-submit").click();
  await expect(page.locator("[data-testid^='bot-row-']").filter({ hasText: name }).first()).toBeVisible({ timeout: 15_000 });
  await page.locator("[data-testid^='bot-row-']").filter({ hasText: name }).first().click();
  await expect(page.getByTestId("bot-chat")).toBeVisible({ timeout: 15_000 });
}

async function workspaceId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const api = (window as unknown as { electronAPI: { getWorkspaces: () => Promise<Array<{ id: string }>> } }).electronAPI;
    const workspaces = await api.getWorkspaces();
    const id = workspaces[0]?.id;
    if (!id) throw new Error("No workspace available for routine test");
    return id;
  });
}

type RoutineRunView = {
  runId: string;
  state: { kind: string; result?: string };
};

async function listRoutineRuns(page: Page, workspaceId: string, routineId: string): Promise<RoutineRunView[]> {
  return page.evaluate(async ({ workspaceId, routineId }) => {
    const api = (window as unknown as {
      electronAPI: {
        listRoutineRuns: (id: string, routineId: string, limit?: number) => Promise<RoutineRunView[]>;
      };
    }).electronAPI;
    return api.listRoutineRuns(workspaceId, routineId, 10);
  }, { workspaceId, routineId });
}

async function ingestEvent(page: Page, workspaceId: string, source: string, eventId: string, value: string) {
  return page.evaluate(async ({ workspaceId, source, eventId, value }) => {
    const api = (window as unknown as {
      electronAPI: {
        ingestRoutineEvent: (workspaceId: string, event: { source: string; externalEventId: string; payload: unknown }) => Promise<unknown[]>
      }
    }).electronAPI;
    return api.ingestRoutineEvent(workspaceId, {
      source,
      externalEventId: eventId,
      payload: { value },
    });
  }, { workspaceId, source, eventId, value });
}

test.describe.configure({ mode: "serial", timeout: agentSuiteTimeoutMs() * 2 });

test.describe(`Bot routines ${E2E_TAGS.routines}`, () => {
  test("runs a scheduled routine while its renderer window is closed", async ({ appWindow, electronApp }) => {
    const prerequisite = readAgentProviderPrerequisite();
    if (!prerequisite.ok) {
      throw new Error(formatMissingPrerequisiteError("Bot routines", prerequisite.missing));
    }

    let activePage = appWindow;
    await runWithAgentProviderFallback(appWindow, "Bot routines offline schedule", async candidate => {
      const page = activePage;
      await configureAgentConnection(page, candidate);
      await waitForAppReady(page);
      const stamp = `${candidate.provider}-${Date.now()}`;
      const botName = `Offline Routine Bot ${stamp}`;
      const resultToken = `OFFLINE_ROUTINE_RESULT_${stamp}`;
      await createBot(page, botName);
      const workspace = await workspaceId(page);
      const bot = await page.evaluate(async ({ workspaceId, botName }) => {
        const api = (window as unknown as { electronAPI: { listBots: (id: string) => Promise<Array<{ name: string; directChatId: string; botId: string }>> } }).electronAPI;
        const bots = await api.listBots(workspaceId);
        const match = bots.find(entry => entry.name === botName);
        if (!match) throw new Error("Created routine Bot was not returned by the server");
        return match;
      }, { workspaceId: workspace, botName });
      const routine = await page.evaluate(async ({ workspaceId, bot, resultToken }) => {
        const api = (window as unknown as { electronAPI: { createRoutine: (id: string, input: unknown) => Promise<{ routineId: string }> } }).electronAPI;
        return api.createRoutine(workspaceId, {
          ownerBotId: bot.botId,
          name: `Offline schedule ${resultToken}`,
          trigger: { kind: "schedule", cron: "* * * * *", timezone: "UTC", dst: { gap: "skip", fold: "once" } },
          input: `Reply with exactly ${resultToken} and no other text.`,
          expectedResult: resultToken,
          approvalBoundary: "allow-all",
          failurePolicy: "stop",
          destination: { kind: "direct", chatId: bot.directChatId },
        });
      }, { workspaceId: workspace, bot, resultToken });

      await page.close();
      await expect.poll(() => electronApp.windows().length, { timeout: 15_000 }).toBe(0);
      // Keep every renderer closed through a scheduler boundary before reconnecting.
      await new Promise(resolve => setTimeout(resolve, 65_000));
      await expect.poll(() => electronApp.windows().length, { timeout: 15_000 }).toBe(0);
      const windowPromise = electronApp.waitForEvent("window");
      await electronApp.evaluate(({ app }) => { app.emit("activate"); });
      activePage = await windowPromise;
      await waitForAppReady(activePage);
      await expect.poll(async () => {
        const runs = await listRoutineRuns(activePage, workspace, routine.routineId);
        return runs.filter(run => run.state.kind === "succeeded");
      }, { timeout: 120_000, intervals: [1_000] }).not.toHaveLength(0);
      const runs = await listRoutineRuns(activePage, workspace, routine.routineId);
      const succeededRuns = runs.filter(run => run.state.kind === "succeeded");
      expect(succeededRuns.length).toBeGreaterThanOrEqual(1);
      expect(succeededRuns.length).toBeLessThanOrEqual(2);
      expect(succeededRuns[0]?.runId).toMatch(/^run_[A-Za-z0-9_-]+$/);
      expect(succeededRuns[0]?.state).toEqual({ kind: "succeeded", at: expect.any(String), result: expect.stringContaining(resultToken) });
    }, {
      recoverAfterFailure: async () => {
        const existing = electronApp.windows().find(page => !page.isClosed());
        if (existing) {
          activePage = existing;
          await waitForAppReady(activePage);
          return;
        }
        const windowPromise = electronApp.waitForEvent("window");
        await electronApp.evaluate(({ app }) => { app.emit("activate"); });
        activePage = await windowPromise;
        await waitForAppReady(activePage);
      },
    });
  });

  test("runs one matching event and ignores unrelated and duplicate events", async ({ appWindow }) => {
    const prerequisite = readAgentProviderPrerequisite();
    if (!prerequisite.ok) {
      throw new Error(formatMissingPrerequisiteError("Bot routines", prerequisite.missing));
    }

    await runWithAgentProviderFallback(appWindow, "Bot routines", async candidate => {
      await configureAgentConnection(appWindow, candidate);
      await waitForAppReady(appWindow);
      const stamp = `${candidate.provider}-${Date.now()}`;
      const botName = `Routine Bot ${stamp}`;
      const source = `routine-test-${stamp}`;
      const value = `run-${stamp}`;
      const resultToken = `ROUTINE_RESULT_${stamp}`;
      await createBot(appWindow, botName);

      await appWindow.getByTestId("routine-trigger-select").selectOption("event");
      await appWindow.getByTestId("routine-name-input").fill(`Event routine ${stamp}`);
      await appWindow.getByTestId("routine-input").fill(`Reply with exactly ${resultToken} and no other text.`);
      await appWindow.getByTestId("routine-expected-result-input").fill(resultToken);
      await appWindow.getByTestId("routine-event-source").fill(source);
      await appWindow.getByTestId("routine-event-field").fill("value");
      await appWindow.getByTestId("routine-event-value").fill(value);
      await appWindow.getByTestId("routine-create").click();
      const routine = appWindow.locator("[data-testid^='routine-']").filter({ hasText: `Event routine ${stamp}` }).first();
      await expect(routine).toBeVisible({ timeout: 15_000 });

      const workspace = await workspaceId(appWindow);
      const first = await ingestEvent(appWindow, workspace, source, `event-${stamp}`, value);
      expect(first).toHaveLength(1);
      const runId = (first[0] as { runId?: string }).runId;
      if (!runId) throw new Error("Matching routine event did not return a run ID");
      await expect(routine.locator(`[data-testid^='routine-latest-']`)).toContainText(resultToken, { timeout: 60_000 });

      const duplicate = await ingestEvent(appWindow, workspace, source, `event-${stamp}`, value);
      expect((duplicate[0] as { runId?: string }).runId).toBe(runId);
      const unrelated = await ingestEvent(appWindow, workspace, source, `unrelated-${stamp}`, "different");
      expect(unrelated).toHaveLength(0);
    });
  });
});
