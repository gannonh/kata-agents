import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { platform } from "node:os";
import { _electron as electron, type ElectronApplication, type Page, test as playwrightTest } from "@playwright/test";

import { E2E_TAGS } from "../../src/config/tags.ts";
import { E2E_TIMEOUTS } from "../../src/config/timeouts.ts";
import {
  agentSuiteTimeoutMs,
  buildDeterministicAgentTurn,
  runWithAgentProviderFallback,
} from "../../src/flows/agentChat.ts";
import { configureAgentConnection, resumeAfterAppRestart } from "../../src/flows/onboarding.ts";
import { useRepositoryAsWorkspaceDefault } from "../../src/flows/gitWorkspace.ts";
import { waitForAppReady } from "../../src/flows/shell.ts";
import { expect, test } from "../../src/fixtures/testFixtures.ts";
import { buildElectronLaunchEnv } from "../../src/harness/launchEnv.ts";
import type { E2ERunContext } from "../../src/harness/isolatedRun.ts";
import {
  formatMissingPrerequisiteError,
  readAgentProviderPrerequisite,
  readKatacodePrerequisite,
  readKatacodeToken,
} from "../../src/harness/env.ts";

const KATACODE_SUITE_TIMEOUT_MS = Math.max(E2E_TIMEOUTS.katacodeTestMs, agentSuiteTimeoutMs() * 2);

playwrightTest.describe(`Katacode prerequisites ${E2E_TAGS.katacode}`, () => {
  playwrightTest("requires a Katacode endpoint, credential, and agent provider", () => {
    const katacode = readKatacodePrerequisite();
    if (!katacode.ok) {
      throw new Error(formatMissingPrerequisiteError("Katacode E2E", katacode.missing));
    }
    const agent = readAgentProviderPrerequisite();
    if (!agent.ok) {
      throw new Error(formatMissingPrerequisiteError("Katacode E2E", agent.missing));
    }
  });
});

test.describe.configure({ mode: "serial", timeout: KATACODE_SUITE_TIMEOUT_MS });

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

async function workspaceIdFromPage(page: Page): Promise<string> {
  const workspaceId = await page.evaluate(async () => {
    const api = (window as unknown as { electronAPI: { getWindowWorkspace(): Promise<string | null> } }).electronAPI;
    return api.getWindowWorkspace();
  });
  if (!workspaceId) throw new Error("Katacode E2E: the ready shell has no active workspace");
  return workspaceId;
}

async function bootstrapKatacodeCredential(
  repoRoot: string,
  workspaceId: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const token = readKatacodeToken();
  if (!token) {
    throw new Error(formatMissingPrerequisiteError("Katacode E2E", ["KATA_E2E_KATACODE_TOKEN"]));
  }
  execFileSync("bun", ["e2e/scripts/bootstrap-katacode-credential.ts", workspaceId], {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
}

async function createDisposableRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kata-katacode-e2e-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "e2e@kata.local"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Kata E2E"], { cwd: root });
  await writeFile(join(root, "README.md"), "# Katacode disposable repository\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "-m", "seed"], { cwd: root });
  return root;
}

test.describe(`Katacode dispatch ${E2E_TAGS.katacode}`, () => {
  test("dispatches one isolated task, opens the rail, and recovers the card after restart", async ({
    appWindow,
    electronApp,
    runContext,
  }, testInfo) => {
    const katacode = readKatacodePrerequisite();
    if (!katacode.ok) {
      throw new Error(formatMissingPrerequisiteError("Katacode E2E", katacode.missing));
    }
    const prerequisite = readAgentProviderPrerequisite();
    if (!prerequisite.ok) {
      throw new Error(formatMissingPrerequisiteError("Katacode E2E", prerequisite.missing));
    }
    if (platform() !== "darwin") {
      throw new Error(
        "Katacode desktop E2E requires macOS. Run `bun run e2e --grep @katacode` on a macOS GUI session. See e2e/README.md.",
      );
    }

    let page = appWindow;
    let app = electronApp;
    const repo = await createDisposableRepo();

    try {
      await runWithAgentProviderFallback(page, "Katacode dispatch", async candidate => {
        await configureAgentConnection(page, candidate);
        await waitForAppReady(page);
        await useRepositoryAsWorkspaceDefault(page, repo);
        const workspaceId = await workspaceIdFromPage(page);
        await bootstrapKatacodeCredential(runContext.repoRoot, workspaceId, runContext.baseEnv);

        const stamp = `${candidate.provider} ${Date.now()}`;
        const botName = `Katacode Owner ${stamp}`;
        const turn = buildDeterministicAgentTurn();

        await createBot(page, botName, "Dispatches isolated Katacode development tasks and reports the task id.");
        await openBot(page, botName);

        const prompt = [
          "Use dispatch_katacode exactly once now.",
          `Set repository to ${repo.split("/").pop()}.`,
          `Set prompt to: Add a passing test file that prints ${turn.token} and keep the change on an isolated worktree.`,
          `Set acceptanceCriteria to: tests pass and the unique token ${turn.token} is present.`,
          "Do not pass workspace, bot, path, credential, or recipient fields.",
          "Wait for the tool result, then reply with only the returned taskId.",
        ].join(" ");
        await page.getByTestId("bot-chat-input").fill(prompt);
        await page.getByTestId("bot-chat-send").click();

        const pendingApproval = page.locator("[data-testid^='approval-card-'][data-approval-status='pending']");
        const taskCards = page.locator("[data-testid^='task-card-'][data-task-id]");
        await expect(pendingApproval.or(taskCards).first()).toBeVisible({ timeout: E2E_TIMEOUTS.katacodeTestMs });
        if (await pendingApproval.count()) {
          const approvalId = await pendingApproval.first().getAttribute("data-approval-id");
          if (!approvalId) throw new Error("Pending Katacode approval is missing its approval ID");
          await page.getByTestId(`approval-allow-once-${approvalId}`).click();
        }

        await expect(taskCards).toHaveCount(1, { timeout: E2E_TIMEOUTS.katacodeTestMs });
        const taskId = await taskCards.first().getAttribute("data-task-id");
        if (!taskId) throw new Error("Katacode card is missing its task ID");
        await expect(taskCards.first()).toContainText(botName);
        await page.screenshot({ path: testInfo.outputPath("katacode-card.png"), fullPage: true });
        await taskCards.first().click();

        await expect(page.getByTestId(`task-rail-${taskId}`)).toBeVisible({ timeout: 15_000 });
        await expect(page.getByTestId("task-rail-repo")).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("katacode-rail.png"), fullPage: true });
        await expect(page.getByTestId("task-rail-state")).toHaveText(/Completed/, {
          timeout: E2E_TIMEOUTS.katacodeTestMs,
        });
        await expect(page.getByTestId("task-rail-pr")).toBeVisible();
        await expect(page.getByTestId("task-open")).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("katacode-completed-rail.png"), fullPage: true });

        const restarted = await restartElectron(app, runContext);
        app = restarted.app;
        page = restarted.page;
        await openBot(page, botName);
        await expect(page.locator("[data-testid^='task-card-'][data-task-id]")).toHaveCount(1, { timeout: 15_000 });
        await expect(page.locator(`[data-testid='task-card-${taskId}']`)).toBeVisible();
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("gives concurrent dispatches distinct isolated worktrees", async ({
    appWindow,
    runContext,
  }) => {
    const katacode = readKatacodePrerequisite();
    if (!katacode.ok) {
      throw new Error(formatMissingPrerequisiteError("Katacode E2E", katacode.missing));
    }
    const prerequisite = readAgentProviderPrerequisite();
    if (!prerequisite.ok) {
      throw new Error(formatMissingPrerequisiteError("Katacode E2E", prerequisite.missing));
    }
    if (platform() !== "darwin") {
      throw new Error(
        "Katacode desktop E2E requires macOS. Run `bun run e2e --grep @katacode` on a macOS GUI session. See e2e/README.md.",
      );
    }

    const page = appWindow;
    const repo = await createDisposableRepo();
    try {
      await runWithAgentProviderFallback(page, "Katacode concurrent dispatch", async candidate => {
        await configureAgentConnection(page, candidate);
        await waitForAppReady(page);
        await useRepositoryAsWorkspaceDefault(page, repo);
        const workspaceId = await workspaceIdFromPage(page);
        await bootstrapKatacodeCredential(runContext.repoRoot, workspaceId, runContext.baseEnv);

        const stamp = `${candidate.provider} ${Date.now()}`;
        const botName = `Katacode Concurrent ${stamp}`;
        const turn = buildDeterministicAgentTurn();
        await createBot(page, botName, "Dispatches two isolated Katacode tasks without sharing a checkout.");
        await openBot(page, botName);

        const prompt = [
          "Use dispatch_katacode exactly twice now, with two different prompts.",
          `Set repository to ${repo.split("/").pop()} both times.`,
          `First prompt: Add file one-${turn.token}.txt on an isolated worktree.`,
          `Second prompt: Add file two-${turn.token}.txt on a different isolated worktree.`,
          "Use acceptanceCriteria: each task writes only its own file.",
          "Do not pass workspace, bot, path, credential, or recipient fields.",
          "Reply with both taskIds.",
        ].join(" ");
        await page.getByTestId("bot-chat-input").fill(prompt);
        await page.getByTestId("bot-chat-send").click();

        const pendingApproval = page.locator("[data-testid^='approval-card-'][data-approval-status='pending']");
        const taskCards = page.locator("[data-testid^='task-card-'][data-task-id]");
        await expect(pendingApproval.or(taskCards).first()).toBeVisible({ timeout: E2E_TIMEOUTS.katacodeTestMs });
        for (let i = 0; i < 4 && await pendingApproval.count(); i += 1) {
          const approvalId = await pendingApproval.first().getAttribute("data-approval-id");
          if (!approvalId) break;
          await page.getByTestId(`approval-allow-once-${approvalId}`).click();
        }

        await expect(taskCards).toHaveCount(2, { timeout: E2E_TIMEOUTS.katacodeTestMs });
        const firstId = await taskCards.nth(0).getAttribute("data-task-id");
        const secondId = await taskCards.nth(1).getAttribute("data-task-id");
        if (!firstId || !secondId || firstId === secondId) {
          throw new Error("Concurrent Katacode cards must have distinct task IDs");
        }
        await taskCards.nth(0).click();
        const firstBranch = await page.getByTestId("task-rail-repo").innerText();
        await taskCards.nth(1).click();
        const secondBranch = await page.getByTestId("task-rail-repo").innerText();
        expect(firstBranch).not.toBe(secondBranch);
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
