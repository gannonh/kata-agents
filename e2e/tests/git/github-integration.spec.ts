import { access, appendFile } from "node:fs/promises";
import { join } from "node:path";

import type { Page, TestInfo } from "@playwright/test";

import { E2E_TAGS } from "../../src/config/tags.ts";
import { startNewSession } from "../../src/flows/agentChat.ts";
import {
  readManagedWorktreeSession,
  useRepositoryAsWorkspaceDefault,
} from "../../src/flows/gitWorkspace.ts";
import { expect, test } from "../../src/fixtures/testFixtures.ts";
import {
  createGitHubE2ERepository,
  git,
  type GitHubE2ERepository,
} from "../../src/harness/githubFixture.ts";

process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = "1";

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

async function waitForRemoteBranch(
  repository: GitHubE2ERepository,
  branch: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          return await git(
            repository.checkoutPath,
            "ls-remote",
            "--heads",
            "origin",
            branch,
          );
        } catch {
          return "";
        }
      },
      { timeout: 45_000, intervals: [1_000, 2_000, 5_000] },
    )
    .toContain(`refs/heads/${branch}`);
}

async function removeSessionWorktree(
  page: Page,
  sessionId: string,
  checkoutPath: string,
): Promise<void> {
  await page.evaluate(
    async ({ id }) => {
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
      await api.sessionCommand(id, { type: "rename", name: "GitHub E2E UAT" });
    },
    { id: sessionId },
  );

  const titleButton = page
    .getByRole("button", { name: /GitHub E2E UAT/ })
    .first();
  await expect(titleButton).toBeVisible();
  await titleButton.click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();

  const deleteDialog = page.getByTestId("git-delete-session-dialog");
  await expect(deleteDialog).toBeVisible();
  await page.getByTestId("git-delete-remove-worktree").check();
  await page.getByTestId("git-delete-confirm").click();
  await expect(deleteDialog).toBeHidden();

  await expect
    .poll(
      async () => {
        try {
          await access(checkoutPath);
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 30_000 },
    )
    .toBe(false);
}

async function cleanupFixture(
  repository: GitHubE2ERepository,
  branch: string | undefined,
  pullRequestUrl: string | undefined,
  managedCheckoutPath: string | undefined,
): Promise<void> {
  if (managedCheckoutPath) {
    try {
      await git(
        repository.checkoutPath,
        "worktree",
        "remove",
        "--force",
        managedCheckoutPath,
      );
    } catch {
      // The product flow normally removes the worktree. Retry cleanup below if it remains.
    }
  }
  let discoveredPullRequestUrl = pullRequestUrl;
  if (!discoveredPullRequestUrl && branch) {
    try {
      discoveredPullRequestUrl = (await repository.findPullRequest(branch))
        ?.url;
    } catch {
      // The fixture cleanup still removes the local clone and attempts branch deletion.
    }
  }
  await repository.cleanup(branch, discoveredPullRequestUrl);
}

test.describe(`Authenticated GitHub V1 flow ${E2E_TAGS.git}`, () => {
  test("commits, pushes, creates a PR, and removes the managed worktree", async ({
    authenticatedAppWindow: page,
  }, testInfo) => {
    const repository = await createGitHubE2ERepository();
    let branch: string | undefined;
    let pullRequestUrl: string | undefined;
    let managedCheckoutPath: string | undefined;

    testInfo.annotations.push({
      type: "validation",
      description: `Real Electron + real Git + authenticated gh against ${repository.repoSlug}; cleanup closes the PR and deletes its branch.`,
    });

    try {
      await useRepositoryAsWorkspaceDefault(page, repository.checkoutPath);
      await startNewSession(page);

      const workspaceControl = page.getByTestId("git-workspace-control");
      await expect(workspaceControl).toBeVisible();
      await workspaceControl.locator("button").click();
      await page.getByTestId("git-workspace-new-worktree").click();
      await expect(page.getByTestId("git-workspace-ref-search")).toBeVisible();
      // Select the remote-tracking base ref — the UAT path that previously
      // left the worktree branch tracking origin/<base> and broke push.
      const remoteBaseRef = `origin/${repository.baseRef}`;
      await expect(
        page.getByText(remoteBaseRef, { exact: true }),
      ).toBeVisible();
      await page.getByText(remoteBaseRef, { exact: true }).click();
      await page.getByTestId("git-workspace-create").click();
      await expect(page.getByTestId("git-workspace-identity")).toContainText(
        /kata-agent\/[0-9a-f]{8}/,
      );

      const prepared = await readManagedWorktreeSession(page);
      expect(prepared).not.toBeNull();
      if (!prepared) {
        throw new Error(
          "GitHub E2E: no managed-worktree session was persisted.",
        );
      }
      branch = prepared.checkout.expectedBranch ?? undefined;
      managedCheckoutPath = prepared.checkout.checkoutPath;
      if (!branch) {
        throw new Error(
          "GitHub E2E: the managed-worktree session has no expected branch.",
        );
      }
      await access(prepared.checkout.checkoutPath);
      expect(branch).toMatch(/^kata-agent\/[0-9a-f]{8}$/);

      const uniqueToken = `KATA_GITHUB_E2E_${crypto.randomUUID().slice(0, 8)}`;
      const changedFile = join(prepared.checkout.checkoutPath, "hello.txt");
      await appendFile(changedFile, `\n${uniqueToken}\n`);
      await expect
        .poll(
          () =>
            page.evaluate(async (checkoutPath) => {
              const api = (
                window as unknown as {
                  electronAPI: {
                    getGitStatus(
                      path: string,
                    ): Promise<{ entries: Array<{ path: string }> }>;
                  };
                }
              ).electronAPI;
              const status = await api.getGitStatus(checkoutPath);
              return status.entries.map((entry) => entry.path);
            }, prepared.checkout.checkoutPath),
          { timeout: 10_000 },
        )
        .toContain("hello.txt");
      await expect(page.getByTestId("git-changes-affordance")).toContainText(
        "1 file",
        {
          timeout: 7_000,
        },
      );

      // Authenticated GitHub capability must expose PR actions and no setup warning.
      await expect(page.locator("[data-git-github-setup]")).toHaveCount(0);
      const primaryAction = page.locator("[data-git-action-primary]");
      await expect(primaryAction).toHaveAccessibleName("Commit, push & PR");
      await attachScreenshot(page, testInfo, "01-github-action-ready");

      await primaryAction.click();
      const commitDialog = page.getByTestId("git-commit-dialog");
      await expect(commitDialog).toBeVisible();
      const commitMessage = `test(e2e): GitHub V1 ${uniqueToken}`;
      await page.getByTestId("git-commit-message").fill(commitMessage);
      await page.getByTestId("git-commit-submit").click();

      // The compound action must push before it opens the PR dialog. This
      // catches a local commit that leaves create-pr without an upstream.
      await waitForRemoteBranch(repository, branch);
      const pullRequestDialog = page
        .locator('[role="dialog"]')
        .filter({ hasText: "Create pull request" });
      await expect(
        pullRequestDialog.getByRole("heading", { name: "Create pull request" }),
      ).toBeVisible();
      await pullRequestDialog
        .getByPlaceholder("Pull request title")
        .fill(commitMessage);
      await pullRequestDialog
        .getByPlaceholder("Describe your changes (optional)")
        .fill(`Automated Git V1 acceptance coverage for ${uniqueToken}.`);
      await pullRequestDialog
        .getByRole("button", { name: "Create pull request", exact: true })
        .click();
      await expect(pullRequestDialog).toBeHidden();

      await expect
        .poll(() => repository.findPullRequest(branch!), { timeout: 45_000 })
        .not.toBeNull();
      const pullRequest = await repository.findPullRequest(branch);
      expect(pullRequest).not.toBeNull();
      if (!pullRequest) {
        throw new Error(`GitHub E2E: no pull request found for ${branch}.`);
      }
      pullRequestUrl = pullRequest.url;
      expect(pullRequest.state).toBe("OPEN");
      expect(pullRequest.baseRefName).toBe(repository.baseRef);
      expect(pullRequest.headRefName).toBe(branch);
      expect(pullRequest.title).toBe(commitMessage);
      await expect(primaryAction).toHaveAccessibleName("View PR", {
        timeout: 15_000,
      });
      await attachScreenshot(page, testInfo, "02-github-pull-request-created");

      await removeSessionWorktree(
        page,
        prepared.id,
        prepared.checkout.checkoutPath,
      );
    } finally {
      await cleanupFixture(
        repository,
        branch,
        pullRequestUrl,
        managedCheckoutPath,
      );
    }
  });
});
