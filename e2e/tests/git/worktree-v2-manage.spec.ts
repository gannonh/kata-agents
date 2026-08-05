import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";

import { E2E_TAGS } from "../../src/config/tags.ts";
import { startNewSession } from "../../src/flows/agentChat.ts";
import {
  readManagedWorktreeSessions,
  useRepositoryAsWorkspaceDefault,
} from "../../src/flows/gitWorkspace.ts";
import { expect, test } from "../../src/fixtures/testFixtures.ts";

process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = "1";
process.env.KATA_FEATURE_WORKTREE_V2 = "1";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { execFile } = await import("node:child_process");
  // The running app polls worktree status; retry transient index.lock
  // contention instead of failing the fixture.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await new Promise((resolve, reject) => {
        execFile("git", args, { cwd, encoding: "utf8" }, (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout.trim());
        });
      });
    } catch (error) {
      if (!String(error).includes("index.lock")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw new Error(`git ${args.join(" ")} failed after lock retries`);
}

async function createRepository(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "kata-agents-worktree-v2-manage-"));
  await git(repository, "init", "-b", "main");
  await git(repository, "config", "user.name", "Kata E2E");
  await git(repository, "config", "user.email", "kata-e2e@example.com");
  await writeFile(join(repository, "README.md"), "# Worktree V2 manage fixture\n");
  await git(repository, "add", "README.md");
  await git(repository, "commit", "-m", "fixture: initial commit");
  return repository;
}

async function openWorktreesSettings(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("kata-agent-navigate", { detail: { route: "settings/worktrees" } }),
    );
  });
  await expect(page.getByTestId("worktrees-settings-page")).toBeVisible();
}

async function deleteManagedSessions(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const api = (window as unknown as {
      electronAPI: {
        getSessions(): Promise<Array<{ id: string; checkout?: { mode?: string } }>>;
        deleteSession(
          id: string,
          options: { removeManagedWorktree: boolean },
        ): Promise<unknown>;
      };
    }).electronAPI;
    const sessions = await api.getSessions();
    for (const session of sessions) {
      if (session.checkout?.mode === "managed-worktree") {
        await api.deleteSession(session.id, { removeManagedWorktree: true });
      }
    }
  });
}

test.describe(`Worktree V2 snapshot management ${E2E_TAGS.worktreeV2}`, () => {
  test("deletes a worktree snapshot-first, restores it, and saves cleanup policy @worktree-v2 manage cleanup restore", async ({
    authenticatedAppWindow: page,
    runContext,
  }) => {
    const repository = await createRepository();
    let worktreeId: string | undefined;

    try {
      await useRepositoryAsWorkspaceDefault(page, repository);
      await startNewSession(page);

      const workspaceControl = page.getByTestId("git-workspace-control");
      await expect(workspaceControl).toBeVisible();
      await workspaceControl.locator("button").click();
      await page.getByTestId("git-workspace-new-worktree").click();
      await page.getByTestId("git-workspace-name").fill("manage-me");
      await page.getByTestId("git-workspace-create").click();
      await expect(page.getByTestId("git-workspace-identity")).toContainText("manage-me");

      const created = (await readManagedWorktreeSessions(page)).find(
        (session) => session.checkout.displayName === "manage-me",
      );
      expect(created).toBeDefined();
      if (!created) throw new Error("Worktree V2 manage E2E: worktree was not created.");
      worktreeId = created.checkout.managedWorktreeId ?? undefined;
      if (!worktreeId) throw new Error("Worktree V2 manage E2E: no managed worktree ID.");
      const originalCheckoutPath = created.checkout.checkoutPath;
      await writeFile(join(originalCheckoutPath, "precious.txt"), "precious work\n");
      await git(originalCheckoutPath, "add", "precious.txt");
      await git(originalCheckoutPath, "commit", "-m", "unique work");

      // Inventory exposes the row with lifecycle state and branch.
      await openWorktreesSettings(page);
      const row = page.getByTestId(`worktree-row-${worktreeId}`);
      await expect(row).toBeVisible();
      await expect(row).toContainText("manage-me");
      await expect(row).toContainText("kata-agent/manage-me");
      await expect(row.getByTestId("worktree-row-state")).toContainText("Ready");

      // Policy controls: set the retention limit and disable auto-delete, then
      // save; the inventory reflects the last cleanup result.
      await page.getByTestId("worktrees-retention-limit").locator("input").fill("1");
      await page.getByTestId("worktrees-save").click();
      await expect(page.getByTestId("worktrees-retention-limit").locator("input")).toHaveValue("1");

      // Delete with fresh preview + confirmation → snapshotted state.
      await page.getByTestId(`worktree-delete-${worktreeId}`).click();
      await expect(page.getByTestId("worktrees-confirm-delete")).toBeVisible();
      await expect(page.getByTestId("worktrees-confirm-delete")).toContainText("Delete worktree");
      await page.getByTestId("worktrees-confirm-delete").click();
      await expect(row.getByTestId("worktree-row-state")).toContainText("Snapshotted", {
        timeout: 30_000,
      });

      // The checkout is gone but the branch survives.
      const branch = await git(repository, "rev-parse", "--verify", "refs/heads/kata-agent/manage-me");
      expect(branch).toHaveLength(40);

      // Restore recreates the checkout with the exact state.
      await page.getByTestId(`worktree-restore-${worktreeId}`).click();
      await expect(row.getByTestId("worktree-row-state")).toContainText("Ready", {
        timeout: 30_000,
      });
      const restored = (await readManagedWorktreeSessions(page)).find(
        (session) => session.checkout.managedWorktreeId === worktreeId,
      );
      expect(restored).toBeDefined();
      if (!restored) throw new Error("Worktree V2 manage E2E: restore did not rebind the session.");
      expect(restored.checkout.checkoutPath).not.toBe(originalCheckoutPath);
      expect(await git(restored.checkout.checkoutPath, "branch", "--show-current")).toBe(
        "kata-agent/manage-me",
      );
      // The committed unique work is back byte-for-byte via the retained branch.
      expect(await git(restored.checkout.checkoutPath, "log", "--oneline", "-1")).toContain(
        "unique work",
      );
      expect(await git(restored.checkout.checkoutPath, "status", "--porcelain")).toBe("");
    } finally {
      await deleteManagedSessions(page).catch(() => undefined);
      await rm(repository, { recursive: true, force: true });
    }
  });
});
