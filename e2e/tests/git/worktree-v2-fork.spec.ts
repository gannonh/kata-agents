import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import { configureAgentConnection } from "../../src/flows/onboarding.ts";
import { waitForAppReady } from "../../src/flows/shell.ts";
import {
  formatMissingPrerequisiteError,
  readAgentProviderPrerequisite,
} from "../../src/harness/env.ts";
import {
  readManagedWorktreeSessions,
  useRepositoryAsWorkspaceDefault,
} from "../../src/flows/gitWorkspace.ts";
import { expect, test } from "../../src/fixtures/testFixtures.ts";

// Real provider + shared state. The source session agent is created on the
// first Send; the fork dialog then exercises the REAL surface: shared stays
// the default and works through the existing branch flow, and the isolated
// strategy is offered but typed-blocked (unsupported-provider) because no
// production provider adapter implements the strict cross-CWD native fork yet.
// The provider itself walks the full credential fallback chain.
process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = "1";
process.env.KATA_FEATURE_WORKTREE_V2 = "1";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { execFile } = await import("node:child_process");
  return await new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "kata-agents-fork-e2e-"));
  await git(repository, "init", "-b", "main");
  await git(repository, "config", "user.name", "Kata E2E");
  await git(repository, "config", "user.email", "kata-e2e@example.com");
  await writeFile(join(repository, "README.md"), "# Fork fixture\n");
  await git(repository, "add", "README.md");
  await git(repository, "commit", "-m", "fixture: initial commit");
  return repository;
}

interface ForkChildSession {
  id: string;
  name?: string;
  workingDirectory?: string;
  checkout?: { checkoutPath?: string } | null;
}

async function readSessions(page: import("@playwright/test").Page): Promise<
  Array<{
    id: string;
    name?: string;
    workingDirectory?: string;
    checkout?: { checkoutPath?: string } | null;
  }>
> {
  return page.evaluate(async () => {
    const api = (window as unknown as {
      electronAPI: {
        getSessions(): Promise<
          Array<{
            id: string;
            name?: string;
            workingDirectory?: string;
            checkout?: { checkoutPath?: string } | null;
          }>
        >;
      };
    }).electronAPI;
    return api.getSessions();
  });
}

async function readSourceSessionId(page: import("@playwright/test").Page): Promise<string> {
  const sessions = await readSessions(page);
  if (sessions.length !== 1) {
    throw new Error(`Expected exactly one session before branching, got ${sessions.length}.`);
  }
  return sessions[0]!.id;
}

test.describe.configure({ mode: "serial", timeout: agentSuiteTimeoutMs() });

test.describe(`Worktree V2 conversation fork ${E2E_TAGS.worktreeV2}`, () => {
  test("branches via the fork dialog with real credentials: shared default works, isolated is typed-blocked without a strict provider adapter @worktree-v2 fork", async ({
    appWindow,
  }) => {
    const prerequisite = readAgentProviderPrerequisite();
    if (!prerequisite.ok) {
      throw new Error(
        formatMissingPrerequisiteError(
          "Worktree V2 conversation fork",
          prerequisite.missing,
        ),
      );
    }

    const repository = await createRepository();
    try {
      const page = appWindow;
      // Real provider prologue through the fallback chain: codex OAuth first,
      // then every numbered .env fallback. The turn creates the source agent.
      await runWithAgentProviderFallback(page, "Worktree V2 conversation fork", async (candidate) => {
        await configureAgentConnection(page, candidate);
        await waitForAppReady(page);
        await useRepositoryAsWorkspaceDefault(page, repository);
        await startNewSession(page);
        await selectModel(page, candidate.model);

        const turn = buildDeterministicAgentTurn();
        await sendAgentPrompt(page, turn.prompt);
        await expectAssistantReply(page, turn, E2E_TIMEOUTS.agentReplyMs, { match: "contains" });
      });

      // The reply can land before title generation finishes; branching requires
      // a fully idle session (runtime-active blocker otherwise).
      await expect
        .poll(
          async () =>
            page.evaluate(async () => {
              const api = (window as unknown as {
                electronAPI: { getSessions(): Promise<Array<{ isProcessing?: boolean }>> };
              }).electronAPI;
              const sessions = await api.getSessions();
              return sessions.every((session) => !session.isProcessing);
            }),
          { timeout: 60_000 },
        )
        .toBe(true);

      const sourceSessionId = await readSourceSessionId(page);
      const sourceCheckoutPath = (
        await readSessions(page)
      )[0]?.workingDirectory;
      expect(sourceCheckoutPath).toBeTruthy();

      // Open the Branch action on the final assistant turn — Worktree V2
      // effective routes it through the fork dialog instead of the immediate
      // shared branch.
      await page.getByRole("button", { name: "Branch options" }).last().click();
      await page.getByRole("menuitem", { name: "Branch From This Message" }).click();
      const dialog = page.getByTestId("fork-dialog");
      await expect(dialog).toBeVisible();

      // Shared is the default strategy and the preview renders the real source
      // identity. Isolated is offered but disabled: no production provider
      // adapter advertises the strict cross-CWD native fork, so the server
      // returns the typed unsupported-provider blocker.
      await expect(page.getByTestId("fork-strategy-shared")).toBeVisible();
      await expect(page.getByTestId("fork-strategy-isolated")).toBeVisible();
      await expect(page.getByTestId("fork-strategy-isolated")).toBeDisabled();
      await expect(dialog).toContainText("This provider can't establish an isolated fork yet.");
      await expect(page.getByTestId("fork-loading")).toBeHidden({ timeout: 30_000 });
      await expect(dialog).toContainText("main");

      // Confirm the shared strategy: the existing branch flow creates the
      // shared child and navigates to it; no managed worktree is created.
      await page.getByTestId("fork-confirm-button").click();
      await expect(page.getByTestId("fork-dialog")).toHaveCount(0, { timeout: 30_000 });
      await expect
        .poll(async () => (await readSessions(page)).length, { timeout: 60_000 })
        .toBe(2);
      expect(await readManagedWorktreeSessions(page)).toHaveLength(0);

      // The shared child mirrors the source checkout (same working directory)
      // and the source stays untouched on main with a clean index.
      const sessions = await readSessions(page);
      const child = sessions.find((session) => session.id !== sourceSessionId);
      expect(child).toBeDefined();
      expect(child?.workingDirectory).toBe(sourceCheckoutPath);
      expect(await git(repository, "branch", "--show-current")).toBe("main");
      expect((await git(repository, "status", "--porcelain")).trim()).toBe("");

      // Cleanup: deleting the shared child drops its owner without touching
      // the source (no managed worktree exists to remove).
      if (child) {
        await page.evaluate(async (id) => {
          const api = (window as unknown as {
            electronAPI: {
              deleteSession(id: string, options: { removeManagedWorktree: boolean }): Promise<unknown>;
            };
          }).electronAPI;
          await api.deleteSession(id, { removeManagedWorktree: true });
        }, child.id);
        await expect
          .poll(async () => (await readSessions(page)).length, { timeout: 60_000 })
          .toBe(1);
      }
      expect(await git(repository, "branch", "--show-current")).toBe("main");
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  // The isolated strategy's full UI flow (preview facts, name edit, confirm,
  // pending identity, first-Send establishment) is covered by unit tests with
  // test-only doubles and becomes E2E-exercisable once a production provider
  // adapter implements the strict cross-CWD native fork (credentialed UAT).
});
