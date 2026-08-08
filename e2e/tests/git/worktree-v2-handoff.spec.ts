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
  useRepositoryAsWorkspaceDefault,
} from "../../src/flows/gitWorkspace.ts";
import { expect, test } from "../../src/fixtures/testFixtures.ts";

// Real provider + shared state: the session agent is created on the first
// Send, and only then does the server resolve provider capabilities. The
// handoff control is offered only for adapters that prove safe execution-CWD
// rebinding — no production provider adapter implements that capability yet,
// so this spec asserts the REAL surface: a working provider turn with real
// credentials (walking the fallback chain), and the handoff control absent
// for the unsupported provider. The full handoff UI flow is unit-tested with
// test-only doubles and becomes E2E-exercisable once a production adapter
// proves the capability.
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
  const repository = await mkdtemp(join(tmpdir(), "kata-agents-handoff-e2e-"));
  await git(repository, "init", "-b", "main");
  await git(repository, "config", "user.name", "Kata E2E");
  await git(repository, "config", "user.email", "kata-e2e@example.com");
  await writeFile(join(repository, "README.md"), "# Handoff fixture\n");
  await git(repository, "add", "README.md");
  await git(repository, "commit", "-m", "fixture: initial commit");
  return repository;
}

test.describe.configure({ mode: "serial", timeout: agentSuiteTimeoutMs() });

test.describe(`Worktree V2 handoff ${E2E_TAGS.worktreeV2}`, () => {
  test("completes a real provider turn and keeps the handoff surface blocked for unsupported providers @worktree-v2 handoff", async ({
    appWindow,
  }) => {
    const prerequisite = readAgentProviderPrerequisite();
    if (!prerequisite.ok) {
      throw new Error(
        formatMissingPrerequisiteError(
          "Worktree V2 handoff",
          prerequisite.missing,
        ),
      );
    }

    const repository = await createRepository();
    try {
      const page = appWindow;
      // Real provider prologue through the fallback chain: codex OAuth first,
      // then every numbered .env fallback. The turn creates the session agent.
      await runWithAgentProviderFallback(page, "Worktree V2 handoff", async (candidate) => {
        await configureAgentConnection(page, candidate);
        await waitForAppReady(page);
        await useRepositoryAsWorkspaceDefault(page, repository);
        await startNewSession(page);
        await selectModel(page, candidate.model);

        // The handoff flow only needs the turn to complete, not an exact
        // token echo, so match by containment within an assistant reply.
        const turn = buildDeterministicAgentTurn();
        await sendAgentPrompt(page, turn.prompt);
        await expectAssistantReply(page, turn, E2E_TIMEOUTS.agentReplyMs, { match: "contains" });
      });

      // The reply can land before title generation finishes.
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

      // The handoff control is NOT offered: no production provider adapter
      // advertises safe execution-CWD rebinding, so the real surface is the
      // typed-blocked state (unit-tested contract; live UI asserts absence).
      await page.getByTestId("git-changes-affordance").click();
      await page.getByTestId("git-changes-panel").waitFor({ timeout: 30_000 });
      await expect(page.getByTestId("handoff-open-button")).toHaveCount(0);

      // The provider turn itself is untouched: repo on main, clean index.
      expect(await git(repository, "branch", "--show-current")).toBe("main");
      expect((await git(repository, "status", "--porcelain")).trim()).toBe("");
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  // The handoff preview/confirm UI flow (direction choice, preview, name
  // edit, committed binding, recovery) is covered by unit tests with
  // test-only doubles and becomes E2E-exercisable once a production provider
  // adapter proves safe execution-CWD rebinding (credentialed UAT).
});
