import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { E2E_TAGS } from "../../src/config/tags.ts";
import { E2E_TIMEOUTS } from "../../src/config/timeouts.ts";
import {
  buildDeterministicAgentTurn,
  expectAssistantReply,
  selectModel,
  sendAgentPrompt,
  startNewSession,
} from "../../src/flows/agentChat.ts";
import {
  completeApiKeyOnboarding,
  completeConfiguredChatGptOnboarding,
} from "../../src/flows/onboarding.ts";
import { waitForAppReady } from "../../src/flows/shell.ts";
import {
  formatMissingPrerequisiteError,
  readAgentProviderConfig,
  readAgentProviderPrerequisite,
} from "../../src/harness/env.ts";
import {
  readManagedWorktreeSessions,
  useRepositoryAsWorkspaceDefault,
} from "../../src/flows/gitWorkspace.ts";
import { expect, test } from "../../src/fixtures/testFixtures.ts";

// The credential-free UI UAT seam (spec AC-15): the deterministic adapter lets
// the real Electron app exercise preview/confirm/recovery without claiming
// live provider continuity. Production adapters stay disabled without this.
process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = "1";
process.env.KATA_FEATURE_WORKTREE_V2 = "1";
process.env.KATA_HANDOFF_DETERMINISTIC_ADAPTER = "1";

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

// Real provider + shared state: the session agent is created on the first
// Send, and only then does the server advertise handoff capability. This is
// the credential-backed UI UAT tier (spec AC-15) — it drives preview/confirm/
// recovery with the real app; it does not claim live provider continuity for
// the handoff proof itself (the deterministic adapter covers that seam).
test.describe.configure({ mode: "serial", timeout: E2E_TIMEOUTS.agentTestMs });

test.describe(`Worktree V2 handoff ${E2E_TAGS.worktreeV2}`, () => {
  test("previews and confirms Hand off to new worktree, then commits the session binding @worktree-v2 handoff", async ({
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
    const { model, provider } = readAgentProviderConfig();
    const repository = await createRepository();
    try {
      const page = appWindow;
      if (provider === "openai-codex") {
        await completeConfiguredChatGptOnboarding(page, model);
      } else {
        await completeApiKeyOnboarding(page);
      }
      await waitForAppReady(page);
      await useRepositoryAsWorkspaceDefault(page, repository);
      await startNewSession(page);
      await selectModel(page, model);

      // First Send creates the agent; the deterministic adapter seam arms the
      // session's handoff capability. Wait for the reply so the runtime is
      // idle (handoff requires quiescence).
      const turn = buildDeterministicAgentTurn();
      await sendAgentPrompt(page, turn.prompt);
      // The handoff flow only needs the turn to complete (quiescence), not an
      // exact token echo, so match by containment within an assistant reply.
      await expectAssistantReply(page, turn, E2E_TIMEOUTS.agentReplyMs, { match: "contains" });

      // The reply can land before title generation finishes; handoff requires
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

      // Open the Changes panel — the handoff action lives there.
      await page.getByTestId("git-changes-affordance").click();
      await page.getByTestId("handoff-open-button").waitFor({ timeout: 30_000 });
      await page.getByTestId("handoff-open-button").click();
      await page.getByTestId("handoff-direction-current-to-managed").click();

      // Preview surfaces the exact source identity and lets the name be edited.
      const dialog = page.getByTestId("handoff-dialog");
      await expect(dialog).toBeVisible();
      await expect(page.getByTestId("handoff-loading")).toBeHidden({ timeout: 30_000 });
      await expect(dialog).toContainText("main");
      await expect(dialog).toContainText("Recovery behavior");
      const nameInput = page.getByTestId("handoff-name-input");
      await nameInput.fill("e2e-handoff");
      await expect(page.getByTestId("handoff-confirm-button")).toBeEnabled({ timeout: 30_000 });
      await page.getByTestId("handoff-confirm-button").click();

      // UI UAT outcome: the durable binding commits — the session owns a
      // managed worktree on the named branch, the composer rebinds to it, the
      // Changes panel shows the new checkout, and the current checkout is back
      // on the original branch with nothing transferred left behind.
      await expect
        .poll(async () => (await readManagedWorktreeSessions(page)).length, { timeout: 60_000 })
        .toBe(1);
      const managed = (await readManagedWorktreeSessions(page))[0];
      expect(managed?.checkout?.expectedBranch).toBe("kata-agent/e2e-handoff");
      await expect(page.getByTestId("git-changes-panel")).toContainText(
        "kata-agent/e2e-handoff",
        { timeout: 30_000 },
      );
      expect(await git(repository, "branch", "--show-current")).toBe("main");
      expect((await git(repository, "status", "--porcelain")).trim()).toBe("");
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  // AC-1 (controls appear only for capable providers) is covered by unit
  // tests (handoff-capability gate, HandoffButton gating, handoff-controls
  // state machine); the unsupported-provider path stays a unit-tested
  // contract rather than a live UI assertion.
});
