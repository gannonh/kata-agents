import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { E2E_TAGS } from "../../src/config/tags.ts";
import { sendAgentPrompt, startNewSession } from "../../src/flows/agentChat.ts";
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

test.describe(`Worktree V2 handoff ${E2E_TAGS.worktreeV2}`, () => {
  test("previews and confirms Hand off to new worktree, then commits the session binding @worktree-v2 handoff", async ({
    authenticatedAppWindow: page,
  }) => {
    const repository = await createRepository();
    try {
      await useRepositoryAsWorkspaceDefault(page, repository);
      await startNewSession(page);
      // UI UAT (spec AC-15) drives a real session, so a valid provider
      // credential is required in the UAT environment: the agent is created
      // on first Send, and only then does the server advertise handoff
      // capability. The message content is irrelevant to the handoff flow.
      await sendAgentPrompt(page, "hello");
      // Open the Changes panel — the handoff action lives there.
      await page.getByTestId("git-changes-affordance").click();
      await page.getByTestId("handoff-open-button").waitFor({ timeout: 30_000 });
      await page.getByTestId("handoff-open-button").click();
      await page.getByTestId("handoff-direction-current-to-managed").click();

      const dialog = page.getByTestId("handoff-dialog");
      await expect(dialog).toBeVisible();
      await expect(page.getByTestId("handoff-loading")).toBeHidden({ timeout: 30_000 });
      await expect(dialog).toContainText("main");
      // Edit the generated name and re-preview.
      const nameInput = page.getByTestId("handoff-name-input");
      await nameInput.fill("e2e-handoff");
      await expect(page.getByTestId("handoff-confirm-button")).toBeEnabled({ timeout: 30_000 });
      await page.getByTestId("handoff-confirm-button").click();

      await expect(page.getByTestId("handoff-committed")).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId("handoff-committed")).toContainText("kata-agent/e2e-handoff");
      await expect(dialog).toContainText("transcript");
      // Close and verify the durable binding: the session now owns a managed
      // worktree and the current checkout is back on the original branch.
      await page.getByRole("button", { name: /Cancel/ }).click();
      const managed = await readManagedWorktreeSessions(page);
      expect(managed.length).toBe(1);
      expect(managed[0]?.checkout?.expectedBranch).toBe("kata-agent/e2e-handoff");
      expect(await git(repository, "branch", "--show-current")).toBe("main");
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  // AC-1 (controls appear only for capable providers) is covered by unit
  // tests (handoff-capability gate, HandoffButton gating, handoff-controls
  // state machine); the credential-free E2E tier cannot create an agent
  // without a provider send, so the unsupported-provider path stays a
  // unit-tested contract rather than a live UI assertion.
});
