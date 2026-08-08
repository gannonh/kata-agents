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

// The credential-free UI UAT seam (spec AC-15): the deterministic strict fork
// adapter lets the real Electron app exercise preview/confirm and the first-
// Send native-fork establishment without claiming live provider continuity.
// Production adapters stay disabled without this.
process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = "1";
process.env.KATA_FEATURE_WORKTREE_V2 = "1";
process.env.KATA_FORK_DETERMINISTIC_ADAPTER = "1";

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
  readonly id: string;
  readonly forkPending?: boolean;
  readonly isolatedForkCapable?: boolean;
  readonly checkout: {
    readonly checkoutPath: string;
    readonly expectedBranch: string;
  };
}

/** The isolated fork child: the only managed-worktree session, plus its DTO facts. */
async function readForkChild(page: import("@playwright/test").Page): Promise<ForkChildSession | null> {
  const sessions = await readManagedWorktreeSessions(page);
  if (sessions.length !== 1) return null;
  const session = sessions[0];
  return await page.evaluate(async (id) => {
    const api = (window as unknown as {
      electronAPI: {
        getSessions(): Promise<
          Array<{
            id: string;
            forkPending?: boolean;
            isolatedForkCapable?: boolean;
          }>
        >;
      };
    }).electronAPI;
    const all = await api.getSessions();
    const dto = all.find((candidate) => candidate.id === id);
    return {
      id,
      forkPending: dto?.forkPending,
      isolatedForkCapable: dto?.isolatedForkCapable,
      checkout: {
        checkoutPath: session.checkout.checkoutPath,
        expectedBranch: session.checkout.expectedBranch ?? "",
      },
    };
  }, session.id);
}

// Real provider + shared state: the session agent is created on the first
// Send, and only then does the server advertise isolated fork capability. This
// is the credential-backed UI UAT tier (spec AC-15) — it drives the
// shared/isolated choice, preview, name edit, confirm, pending identity, and
// first-Send establishment with the real app; it does not claim live provider
// continuity for the fork proof itself (the deterministic adapter covers that
// seam).
test.describe.configure({ mode: "serial", timeout: E2E_TIMEOUTS.agentTestMs });

test.describe(`Worktree V2 conversation fork ${E2E_TAGS.worktreeV2}`, () => {
  test("forks the conversation head into an isolated worktree, establishes on first Send, and cleans up the child @worktree-v2 fork", async ({
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

      // First Send creates the source agent; the deterministic fork seam arms
      // the session's strict conversation-fork capability. Wait for the reply
      // so the runtime is idle (forking requires quiescence).
      const turn = buildDeterministicAgentTurn();
      await sendAgentPrompt(page, turn.prompt);
      await expectAssistantReply(page, turn, E2E_TIMEOUTS.agentReplyMs, { match: "contains" });

      // The reply can land before title generation finishes; fork requires a
      // fully idle session (runtime-active blocker otherwise).
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

      // Open the Branch action on the final assistant turn — Worktree V2
      // effective routes it through the fork dialog instead of the immediate
      // shared branch.
      await page.getByRole("button", { name: "Branch options" }).last().click();
      await page.getByRole("menuitem", { name: "Branch From This Message" }).click();
      const dialog = page.getByTestId("fork-dialog");
      await expect(dialog).toBeVisible();

      // Shared is the default strategy; isolated is offered (eligible) because
      // the deterministic strict fork adapter advertises the capability.
      await expect(page.getByTestId("fork-strategy-shared")).toBeVisible();
      await expect(page.getByTestId("fork-strategy-isolated")).toBeEnabled({ timeout: 30_000 });
      await expect(page.getByTestId("fork-loading")).toBeHidden({ timeout: 30_000 });
      await expect(dialog).toContainText("main");
      await expect(dialog).toContainText("deterministic-e2e");

      // Switch to isolated: the preview keeps rendering, the editable name
      // input appears, and confirm becomes available after the name edit.
      await page.getByTestId("fork-strategy-isolated").click();
      await expect(page.getByTestId("fork-loading")).toBeHidden({ timeout: 30_000 });
      const nameInput = page.getByTestId("fork-name-input");
      await nameInput.fill("e2e-fork");
      await expect(page.getByTestId("fork-confirm-button")).toBeEnabled({ timeout: 30_000 });

      // Confirm → durable child session bound to kata-agent/e2e-fork at the
      // source HEAD. The dialog reports the committed binding and navigates to
      // the child.
      await page.getByTestId("fork-confirm-button").click();
      await expect(page.getByTestId("fork-committed")).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId("fork-committed")).toContainText("kata-agent/e2e-fork");

      // The committed child is the only managed-worktree session, on the exact
      // named branch, and the source checkout is untouched on main.
      await expect
        .poll(async () => (await readManagedWorktreeSessions(page)).length, { timeout: 60_000 })
        .toBe(1);
      const child = await readForkChild(page);
      expect(child).not.toBeNull();
      if (!child) throw new Error("Worktree V2 fork E2E: the committed child session was not persisted.");
      expect(child.checkout.expectedBranch).toBe("kata-agent/e2e-fork");
      expect(await git(repository, "branch", "--show-current")).toBe("main");
      expect((await git(repository, "status", "--porcelain")).trim()).toBe("");

      // Before the first child Send the provider identity is PENDING: the DTO
      // reports forkPending and no agent-derived capability (no claimed child
      // provider ID).
      await expect
        .poll(async () => (await readForkChild(page))?.forkPending === true, { timeout: 30_000 })
        .toBe(true);
      expect(child.isolatedForkCapable).toBeUndefined();

      // First Send on the child establishes the native fork through the
      // deterministic strict adapter (persisted idempotency key, no duplicate
      // message), then the turn completes. forkPending retires afterwards.
      const childTurn = buildDeterministicAgentTurn();
      await sendAgentPrompt(page, childTurn.prompt);
      await expectAssistantReply(page, childTurn, E2E_TIMEOUTS.agentReplyMs, { match: "contains" });
      await expect
        .poll(async () => (await readForkChild(page))?.forkPending === false, { timeout: 60_000 })
        .toBe(true);

      // The established child still executes in its own checkout on the exact
      // branch; the source stays on main.
      const established = await readForkChild(page);
      expect(established?.checkout.checkoutPath).toBe(child.checkout.checkoutPath);
      expect(await git(established!.checkout.checkoutPath, "branch", "--show-current")).toBe(
        "kata-agent/e2e-fork",
      );
      expect(await git(repository, "branch", "--show-current")).toBe("main");

      // Cleanup: deleting the child removes only its own isolated worktree.
      await page.evaluate(async (id) => {
        const api = (window as unknown as {
          electronAPI: {
            deleteSession(id: string, options: { removeManagedWorktree: boolean }): Promise<unknown>;
          };
        }).electronAPI;
        await api.deleteSession(id, { removeManagedWorktree: true });
      }, established!.id);
      await expect
        .poll(async () => (await readManagedWorktreeSessions(page)).length, { timeout: 60_000 })
        .toBe(0);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  // AC-1 (controls appear only for capable providers) is covered by unit tests
  // (isolated-fork capability gate, fork-controls eligibility state machine,
  // ForkDialog gating); the unsupported-provider path stays a unit-tested
  // contract rather than a live UI assertion. The run tier needs a provider
  // credential to create the agent — exactly like the handoff spec — so it is
  // deferred to credentialed UAT (see the deferred-work issue).
});
