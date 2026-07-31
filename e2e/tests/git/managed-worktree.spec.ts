import { execFile } from "node:child_process";
import { access, appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { Page, TestInfo } from "@playwright/test";

import { E2E_TAGS } from "../../src/config/tags.ts";
import { startNewSession } from "../../src/flows/agentChat.ts";
import { expect, test } from "../../src/fixtures/testFixtures.ts";

process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = "1";

const execFileAsync = promisify(execFile);

interface PreparedSession {
  id: string;
  checkout: {
    checkoutPath: string;
    expectedBranch: string | null;
    mode: "managed-worktree";
  };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}

async function createDisposableRepository(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "kata-agents-git-e2e-"));
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "Kata E2E");
  await git(repo, "config", "user.email", "kata-e2e@example.com");
  await writeFile(join(repo, "README.md"), "# Managed worktree fixture\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "fixture: initial commit");
  await git(repo, "remote", "add", "origin", "https://github.com/gannonh/kata-agents.git");
  return repo;
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
}

async function useRepositoryAsWorkspaceDefault(page: Page, repositoryPath: string): Promise<void> {
  await page.evaluate(async (workingDirectory) => {
    const api = (
      window as unknown as {
        electronAPI: {
          getWindowWorkspace(): Promise<string | null>;
          updateWorkspaceSetting(
            workspaceId: string,
            key: "workingDirectory",
            value: string,
          ): Promise<void>;
        };
      }
    ).electronAPI;
    const workspaceId = await api.getWindowWorkspace();
    if (!workspaceId) {
      throw new Error("Git E2E setup: the ready shell has no active workspace.");
    }
    await api.updateWorkspaceSetting(workspaceId, "workingDirectory", workingDirectory);
  }, repositoryPath);
}

async function readPreparedSession(page: Page): Promise<PreparedSession | null> {
  return await page.evaluate(async () => {
    const api = (
      window as unknown as {
        electronAPI: {
          getSessions(): Promise<
            Array<{
              id: string;
              checkout?: {
                checkoutPath: string;
                expectedBranch: string | null;
                mode: string;
              };
            }>
          >;
        };
      }
    ).electronAPI;
    const sessions = await api.getSessions();
    const session = sessions.find((candidate) => candidate.checkout?.mode === "managed-worktree");
    return session
      ? {
          id: session.id,
          checkout: session.checkout,
        }
      : null;
  });
}

test.describe(`Managed worktree Git flow ${E2E_TAGS.git}`, () => {
  test("prepares, reviews, commits, and removes a managed worktree", async (
    { authenticatedAppWindow: page },
    testInfo,
  ) => {
    const repositoryPath = await createDisposableRepository();
    testInfo.annotations.push({
      type: "validation",
      description: "Real Electron + real Git repository; GitHub CLI intentionally absent.",
    });

    try {
      await useRepositoryAsWorkspaceDefault(page, repositoryPath);
      await startNewSession(page);

      const workspaceControl = page.getByTestId("git-workspace-control");
      await expect(workspaceControl).toBeVisible();
      await workspaceControl.locator("button").click();
      await page.getByTestId("git-workspace-new-worktree").click();
      await expect(page.getByTestId("git-workspace-ref-search")).toBeVisible();
      await expect(page.getByText("main", { exact: true })).toBeVisible();
      await page.getByTestId("git-workspace-create").click();

      const identity = page.getByTestId("git-workspace-identity");
      await expect(identity).toContainText(/kata-agent\/[0-9a-f]{8}/);

      const prepared = await readPreparedSession(page);
      expect(prepared).not.toBeNull();
      if (!prepared) {
        throw new Error("Git E2E: no managed-worktree session was persisted.");
      }
      expect(prepared.checkout.expectedBranch).toMatch(/^kata-agent\/[0-9a-f]{8}$/);
      await access(prepared.checkout.checkoutPath);
      await attachScreenshot(page, testInfo, "01-managed-worktree-created");

      const readmePath = join(prepared.checkout.checkoutPath, "README.md");
      await appendFile(readmePath, "\nValidated through the Changes panel.\n");

      const changesAffordance = page.getByTestId("git-changes-affordance");
      await expect(changesAffordance).toContainText("1 file", { timeout: 7_000 });

      const headBeforeGuidance = await git(prepared.checkout.checkoutPath, "rev-parse", "HEAD");
      const githubGuidance = page.locator("[data-git-github-setup]");
      await expect(githubGuidance).toHaveAccessibleName("Install GitHub CLI");
      expect(await git(prepared.checkout.checkoutPath, "rev-parse", "HEAD")).toBe(
        headBeforeGuidance,
      );
      expect(await readFile(readmePath, "utf8")).toContain("Validated through the Changes panel.");

      await changesAffordance.click();
      const changesPanel = page.getByTestId("git-changes-panel");
      await expect(changesPanel).toBeVisible();
      await changesPanel.locator('[data-testid="git-change-file"][data-git-path="README.md"]').click();
      await expect(changesPanel.getByText("Validated through the Changes panel.")).toBeVisible();
      await attachScreenshot(page, testInfo, "02-changes-review-and-github-guidance");

      await page.locator("[data-git-action-menu]").click();
      await page.getByRole("menuitem", { name: "Commit", exact: true }).click();
      const commitDialog = page.getByTestId("git-commit-dialog");
      await expect(commitDialog).toBeVisible();
      await page.getByTestId("git-commit-message").fill("test(git): validate managed worktree flow");
      await page.getByTestId("git-commit-submit").click();
      await expect(commitDialog).toBeHidden();
      await expect(changesAffordance).toContainText("No changes", { timeout: 7_000 });
      expect(await git(prepared.checkout.checkoutPath, "show", "--format=%s", "--no-patch")).toBe(
        "test(git): validate managed worktree flow",
      );
      expect(await git(prepared.checkout.checkoutPath, "status", "--porcelain")).toBe("");
      await attachScreenshot(page, testInfo, "03-commit-complete");

      await page.evaluate(async (sessionId) => {
        const api = (
          window as unknown as {
            electronAPI: {
              sessionCommand(
                id: string,
                command: { type: "rename"; name: string },
              ): Promise<void>;
            };
          }
        ).electronAPI;
        await api.sessionCommand(sessionId, { type: "rename", name: "Git Workspace UAT" });
      }, prepared.id);

      const titleButton = page.getByRole("button", { name: /Git Workspace UAT/ }).first();
      await expect(titleButton).toBeVisible();
      await titleButton.click();
      await page.getByRole("menuitem", { name: "Delete", exact: true }).click();

      const deleteDialog = page.getByTestId("git-delete-session-dialog");
      await expect(deleteDialog).toBeVisible();
      await page.getByTestId("git-delete-remove-worktree").check();
      const destructiveWarning = page.getByTestId("git-delete-destructive-warning");
      await expect(destructiveWarning).toContainText("1 unpushed commit");
      await attachScreenshot(page, testInfo, "04-destructive-removal-confirmation");
      await page.getByTestId("git-delete-confirm").click();
      await expect(deleteDialog).toBeHidden();

      await expect
        .poll(async () => {
          try {
            await access(prepared.checkout.checkoutPath);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(false);
      expect(
        await git(repositoryPath, "branch", "--list", prepared.checkout.expectedBranch ?? ""),
      ).toContain(prepared.checkout.expectedBranch ?? "");
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });
});
