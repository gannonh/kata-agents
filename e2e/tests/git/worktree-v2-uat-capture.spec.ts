/**
 * TEMPORARY UAT capture spec (issue #41 Verify). Not part of the suite:
 * created for acceptance evidence and deleted after the capture run.
 *
 * Drives the REAL Electron app window through the Worktree V2 management
 * surface and saves screenshots at each checkpoint into uat-evidence/.
 */
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
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

const SHOTS = process.env.KATA_UAT_SHOTS ?? "/tmp/kata-uat-shots";

async function shot(page: Page, name: string): Promise<void> {
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { execFile } = await import("node:child_process");
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
  const repository = await mkdtemp(join(tmpdir(), "kata-agents-worktree-v2-uat-"));
  await git(repository, "init", "-b", "main");
  await git(repository, "config", "user.name", "Kata UAT");
  await git(repository, "config", "user.email", "kata-uat@example.com");
  await writeFile(join(repository, "README.md"), "# Worktree V2 UAT fixture\n");
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
        deleteSession(id: string, options: { removeManagedWorktree: boolean }): Promise<unknown>;
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

test.describe(`Worktree V2 UAT capture ${E2E_TAGS.worktreeV2}`, () => {
  test("captures the management surface end to end @worktree-v2 uatcapture", async ({
    authenticatedAppWindow: page,
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
      await page.getByTestId("git-workspace-name").fill("uat-worktree");
      await page.getByTestId("git-workspace-create").click();
      await expect(page.getByTestId("git-workspace-identity")).toContainText("uat-worktree");
      await shot(page, "01-worktree-created");

      const created = (await readManagedWorktreeSessions(page)).find(
        (session) => session.checkout.displayName === "uat-worktree",
      );
      if (!created?.checkout.managedWorktreeId) throw new Error("no worktree created");
      worktreeId = created.checkout.managedWorktreeId;
      const originalCheckoutPath = created.checkout.checkoutPath;
      // Uncommitted work that only a snapshot can preserve.
      await writeFile(join(originalCheckoutPath, "staged.txt"), "staged work\n");
      await git(originalCheckoutPath, "add", "staged.txt");
      await writeFile(join(originalCheckoutPath, "untracked.txt"), "untracked work\n");

      await openWorktreesSettings(page);
      const row = page.getByTestId(`worktree-row-${worktreeId}`);
      await expect(row).toBeVisible();
      await expect(row).toContainText("uat-worktree");
      await expect(row).toContainText("kata-agent/uat-worktree");
      await expect(row.getByTestId("worktree-row-state")).toContainText("Ready");
      await shot(page, "02-inventory-ready");

      // AC1/AC2/AC21: the refresh control renders the translated label, not the
      // raw key, and policy controls are exposed.
      await expect(page.getByTestId("worktrees-inventory-refresh")).toContainText("Refresh");
      await expect(page.getByTestId("worktrees-auto-delete")).toBeVisible();
      await expect(page.getByTestId("worktrees-retention-limit")).toBeVisible();
      await shot(page, "03-policy-and-refresh");

      // Policy controls: set the retention limit and save.
      await page.getByTestId("worktrees-retention-limit").locator("input").fill("3");
      await page.getByTestId("worktrees-save").click();
      await expect(page.getByTestId("worktrees-retention-limit").locator("input")).toHaveValue("3");
      await shot(page, "04-cleanup-policy-saved");

      // Fresh preview + confirmation dialog (names owners, risk, ignored policy).
      await page.getByTestId(`worktree-delete-${worktreeId}`).click();
      await expect(page.getByTestId("worktrees-confirm-delete")).toBeVisible();
      await expect(page.getByTestId("worktrees-confirm-delete")).toContainText("Delete worktree");
      await shot(page, "05-delete-preview-confirmation");

      await page.getByTestId("worktrees-confirm-delete").click();
      await expect(row.getByTestId("worktree-row-state")).toContainText("Snapshotted", {
        timeout: 30_000,
      });
      await shot(page, "06-snapshotted-recovery-actions");

      // AC14: the owner session's composer shows the persisted lifecycle
      // recovery state (not a generic "missing") and names the worktree.
      await page.evaluate(() => {
        window.dispatchEvent(
          new CustomEvent("kata-agent-navigate", { detail: { route: "allSessions" } }),
        );
      });
      // Open the owning session directly so the composer mounts.
      const owningSessions = await readManagedWorktreeSessions(page);
      await writeFile(
        join(SHOTS, "debug-sessions.txt"),
        JSON.stringify(
          owningSessions.map((s) => ({
            id: s.id,
            checkout: s.checkout && {
              mode: s.checkout.mode,
              managedWorktreeId: s.checkout.managedWorktreeId,
              checkoutPath: s.checkout.checkoutPath,
              recoveryState: (s.checkout as { recoveryState?: string }).recoveryState ?? null,
            },
          })),
          null,
          2,
        ),
      );
      const ownerId = owningSessions[0]?.id;
      if (!ownerId) throw new Error("no owning session after snapshot-first delete");
      await page.evaluate((sessionId) => {
        window.dispatchEvent(
          new CustomEvent("kata-agent-navigate", {
            detail: { route: `allSessions/session/${sessionId}` },
          }),
        );
      }, ownerId);
      const recoveryBadge = page.getByTestId("git-workspace-recovery");
      await expect(recoveryBadge).toBeVisible({ timeout: 15_000 });
      await expect(recoveryBadge).toHaveAttribute("data-recovery-kind", "lifecycle");
      await expect(recoveryBadge).toContainText("Snapshotted");
      await recoveryBadge.hover();
      await shot(page, "07-owner-session-recovery-badge");

      await openWorktreesSettings(page);
      await page.getByTestId(`worktree-restore-${worktreeId}`).click();
      await expect(row.getByTestId("worktree-row-state")).toContainText("Ready", {
        timeout: 30_000,
      });
      await shot(page, "08-restored-ready");

      const restored = (await readManagedWorktreeSessions(page)).find(
        (session) => session.checkout.managedWorktreeId === worktreeId,
      );
      if (!restored) throw new Error("restore did not rebind the session");
      // Exact restore of uncommitted work, proven in the real app's checkout.
      const status = await git(restored.checkout.checkoutPath, "status", "--porcelain");
      expect(status).toContain("A  staged.txt");
      expect(status).toContain("?? untracked.txt");
      const branch = await git(
        restored.checkout.checkoutPath,
        "log",
        "--oneline",
        "-1",
      );
      expect(branch).toContain("fixture: initial commit");
      await writeFile(
        join(SHOTS, "restored-status.txt"),
        `checkout: ${restored.checkout.checkoutPath}\nstatus --porcelain:\n${status}\n`,
      );
    } finally {
      await deleteManagedSessions(page).catch(() => undefined);
      await rm(repository, { recursive: true, force: true });
    }
  });
});
