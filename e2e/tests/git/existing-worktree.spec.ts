import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { Page, TestInfo } from "@playwright/test";

import { E2E_TAGS } from "../../src/config/tags.ts";
import { startNewSession } from "../../src/flows/agentChat.ts";
import {
  readManagedWorktreeSessions,
  useRepositoryAsWorkspaceDefault,
} from "../../src/flows/gitWorkspace.ts";
import { expect, test } from "../../src/fixtures/testFixtures.ts";

process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = "1";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}

async function createDisposableRepository(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "kata-agents-git-e2e-"));
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Kata E2E");
  await git(repo, "config", "user.email", "kata-e2e@example.com");
  await writeFile(join(repo, "README.md"), "# Shared worktree fixture\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "fixture: initial commit");
  await git(
    repo,
    "remote",
    "add",
    "origin",
    "https://example.invalid/kata-agents.git",
  );
  return repo;
}

async function attachScreenshot(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
}

/** Prepare a managed worktree for the active empty session via the composer. */
async function prepareNewWorktree(page: Page): Promise<void> {
  const workspaceControl = page.getByTestId("git-workspace-control");
  await expect(workspaceControl).toBeVisible();
  await workspaceControl.locator("button").click();
  await page.getByTestId("git-workspace-new-worktree").click();
  await expect(page.getByTestId("git-workspace-ref-search")).toBeVisible();
  await page.getByTestId("git-workspace-create").click();
  const identity = page.getByTestId("git-workspace-identity");
  await expect(identity).toContainText(/kata-agent\/[0-9a-f]{8}/);
}

/**
 * Delete the session bound to `sessionId` through the session-title menu.
 * `removeWorktree` toggles the worktree-removal choice in the delete dialog.
 */
async function deleteSession(
  page: Page,
  sessionId: string,
  name: string,
  removeWorktree: boolean,
): Promise<void> {
  await page.evaluate(
    async ({ id, name }) => {
      const api = (
        window as unknown as {
          electronAPI: {
            sessionCommand(
              sessionId: string,
              command: { type: "rename"; name: string },
            ): Promise<void>;
          };
        }
      ).electronAPI;
      await api.sessionCommand(id, { type: "rename", name });
    },
    { id: sessionId, name },
  );

  const titleButton = page.getByRole("button", { name: new RegExp(name) }).first();
  if (await titleButton.isVisible().catch(() => false)) {
    await titleButton.click();
  } else {
    // The session is not the active one: navigate to it from the sidebar so
    // its title header becomes the visible button.
    const sessionOption = page.getByRole("option", { name: new RegExp(name) }).first();
    await expect(sessionOption).toBeVisible();
    await sessionOption.click();
    await expect(titleButton).toBeVisible();
    await titleButton.click();
  }
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();

  const deleteDialog = page.getByTestId("git-delete-session-dialog");
  await expect(deleteDialog).toBeVisible();
  if (removeWorktree) {
    await page.getByTestId("git-delete-remove-worktree").check();
  }
  await page.getByTestId("git-delete-confirm").click();
  await expect(deleteDialog).toBeHidden();
}

test.describe(`Existing managed worktree sharing ${E2E_TAGS.git}`, () => {
  test("starts a new session in an existing managed worktree and preserves shared ownership", async ({
    authenticatedAppWindow: page,
  }, testInfo) => {
    const repositoryPath = await createDisposableRepository();
    testInfo.annotations.push({
      type: "validation",
      description:
        "Real Electron + real Git repository: session 2 discovers and binds session 1's managed worktree; deleting session 1 keeps the shared checkout; deleting session 2 with removal cleans it up.",
    });

    try {
      await useRepositoryAsWorkspaceDefault(page, repositoryPath);

      // Session 1: create the managed worktree.
      await startNewSession(page);
      await prepareNewWorktree(page);
      const sessionsAfterFirst = await readManagedWorktreeSessions(page);
      expect(sessionsAfterFirst).toHaveLength(1);
      const owner = sessionsAfterFirst[0]!;
      if (!owner) {
        throw new Error("Git E2E: first session's managed worktree was not persisted.");
      }
      await access(owner.checkout.checkoutPath);
      await attachScreenshot(page, testInfo, "01-first-session-worktree-created");

      // Session 2: discover and bind the EXISTING worktree from the workspace
      // controls — never a recreated checkout.
      await startNewSession(page);
      const workspaceControl = page.getByTestId("git-workspace-control");
      await expect(workspaceControl).toBeVisible();
      // The trigger label shows the live branch only after Git context
      // resolved; the prepare gate waits for it, so assert it before acting.
      await expect(workspaceControl).toContainText("main");
      await workspaceControl.locator("button").click();
      await page.getByTestId("git-workspace-existing-worktree").click();
      await expect(page.getByTestId("git-workspace-worktree-search")).toBeVisible();
      const worktreeOption = page.getByText(owner.checkout.expectedBranch!, {
        exact: true,
      });
      await expect(worktreeOption).toBeVisible();
      await worktreeOption.click();
      await page.getByTestId("git-workspace-use-worktree").click();
      await attachScreenshot(page, testInfo, "02-existing-worktree-selected");

      // Persisted checkout identity: both sessions point at ONE worktree. The
      // badge shows the Shared worktree label because owner count is now 2.
      const identity = page.getByTestId("git-workspace-identity");
      await expect(identity).toContainText("Shared worktree");
      const sessions = await readManagedWorktreeSessions(page);
      expect(sessions).toHaveLength(2);
      const sharer = sessions.find((s) => s.id !== owner.id);
      expect(sharer).toBeDefined();
      if (!sharer) {
        throw new Error("Git E2E: second session was not persisted as managed-worktree.");
      }
      expect(sharer.checkout.checkoutPath).toBe(owner.checkout.checkoutPath);
      expect(sharer.checkout.managedWorktreeId).toBe(owner.checkout.managedWorktreeId);
      expect(sharer.checkout.expectedBranch).toBe(owner.checkout.expectedBranch);
      // Exactly one kata-agent branch exists — binding never recreates.
      expect(
        await git(repositoryPath, "branch", "--list", "kata-agent/*"),
      ).toContain(owner.checkout.expectedBranch ?? "");
      expect(
        (await git(repositoryPath, "branch", "--list", "kata-agent/*")).split("\n"),
      ).toHaveLength(1);

      // Ownership guard: deleting the FIRST owner without removal must NOT
      // remove the shared checkout (the second session still owns it).
      await deleteSession(page, owner.id, "Shared Worktree Owner", false);
      await expect
        .poll(async () => {
          try {
            await access(owner.checkout.checkoutPath);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(true);
      const remaining = await readManagedWorktreeSessions(page);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.id).toBe(sharer.id);
      await attachScreenshot(page, testInfo, "03-shared-worktree-kept-after-owner-delete");

      // The delete left the view on the removed session's route; navigate to
      // the remaining session so its composer (and checkout identity) render.
      const sharerOption = page.getByRole("option", { name: /New chat/ }).first();
      await expect(sharerOption).toBeVisible();
      await sharerOption.click();

      // The remaining session still runs in the shared worktree; with the peer
      // owner gone the badge reverts from Shared worktree to the branch label.
      const sharerIdentity = page.getByTestId("git-workspace-identity");
      await expect(sharerIdentity).toContainText(/kata-agent\/[0-9a-f]{8}/, {
        timeout: 7_000,
      });

      // Final owner deletes WITH removal → checkout is cleaned up.
      await deleteSession(page, sharer.id, "Shared Worktree Sharer", true);
      await expect
        .poll(async () => {
          try {
            await access(owner.checkout.checkoutPath);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(false);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });
});
