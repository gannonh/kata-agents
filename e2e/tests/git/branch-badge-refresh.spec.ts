import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { E2E_TAGS } from "../../src/config/tags.ts";
import { startNewSession } from "../../src/flows/agentChat.ts";
import { useRepositoryAsWorkspaceDefault } from "../../src/flows/gitWorkspace.ts";
import { expect, test } from "../../src/fixtures/testFixtures.ts";

// Scope the feature flag to this spec file instead of mutating the
// worker-global environment at import time, so it cannot leak into specs that
// load later in the same worker. Preserve and restore any previous value.
const WORKSPACE_FLAG = "KATA_FEATURE_GIT_WORKSPACE_V1";
const previousWorkspaceFlag = process.env[WORKSPACE_FLAG];

test.beforeAll(() => {
  process.env[WORKSPACE_FLAG] = "1";
});

test.afterAll(() => {
  if (previousWorkspaceFlag === undefined) {
    delete process.env[WORKSPACE_FLAG];
  } else {
    process.env[WORKSPACE_FLAG] = previousWorkspaceFlag;
  }
});

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}

async function createBranchFixture(): Promise<string> {
  const repositoryPath = await mkdtemp(join(tmpdir(), "kata-agents-git-badge-e2e-"));
  await git(repositoryPath, "init", "-b", "main");
  await git(repositoryPath, "config", "user.name", "Kata E2E");
  await git(repositoryPath, "config", "user.email", "kata-e2e@example.com");
  await writeFile(join(repositoryPath, "README.md"), "# Git badge refresh fixture\n");
  await git(repositoryPath, "add", "README.md");
  await git(repositoryPath, "commit", "-m", "fixture: initial commit");
  await git(repositoryPath, "switch", "-c", "feature/badge-refresh");
  return repositoryPath;
}

test.describe(`Git branch badge refresh ${E2E_TAGS.git}`, () => {
  test("refreshes the live branch when selecting another session", async ({
    authenticatedAppWindow: page,
  }) => {
    const repositoryPath = await createBranchFixture();

    try {
      await useRepositoryAsWorkspaceDefault(page, repositoryPath);
      await startNewSession(page);

      const badge = page.getByTestId("git-workspace-control").locator("button");
      await expect(badge).toHaveAttribute("aria-label", "feature/badge-refresh");

      // Change Git outside the app while the first session remains selected.
      await git(repositoryPath, "switch", "main");
      await startNewSession(page);

      const refreshedBadge = page.getByTestId("git-workspace-control").locator("button");
      await expect(refreshedBadge).toHaveAttribute("aria-label", "main");

      const sessionCheckoutState = await page.evaluate(async (workingDirectory) => {
        const api = (
          window as unknown as {
            electronAPI: {
              getSessions(): Promise<
                Array<{
                  workingDirectory?: string;
                  checkout?: unknown;
                }>
              >;
            };
          }
        ).electronAPI;
        const sessions = await api.getSessions();
        return sessions
          .filter((session) => session.workingDirectory === workingDirectory)
          .map((session) => ({
            workingDirectory: session.workingDirectory,
            hasCheckout: session.checkout != null,
          }));
      }, repositoryPath);

      expect(sessionCheckoutState).toHaveLength(2);
      expect(sessionCheckoutState.every((session) => !session.hasCheckout)).toBe(true);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  test("refreshes an already-open panel when it gains focus", async ({
    authenticatedAppWindow: page,
  }) => {
    const repositoryPath = await createBranchFixture();

    try {
      await useRepositoryAsWorkspaceDefault(page, repositoryPath);
      await startNewSession(page);
      await page.keyboard.press("Meta+t");

      const panels = page.locator('[data-panel-role="content"]');
      await expect(panels).toHaveCount(2);
      const firstPanel = panels.nth(0);
      const secondPanel = panels.nth(1);
      // Meta+t must move focus to the new panel; without it, clicking
      // firstBadge below would not exercise the panel-regaining-focus path.
      await expect(secondPanel).toHaveClass(/shadow-panel-focused/);
      const firstBadge = firstPanel
        .getByTestId("git-workspace-control")
        .locator("button");
      const secondBadge = secondPanel
        .getByTestId("git-workspace-control")
        .locator("button");
      await expect(firstBadge).toHaveAttribute(
        "aria-label",
        "feature/badge-refresh",
      );
      await expect(secondBadge).toHaveAttribute(
        "aria-label",
        "feature/badge-refresh",
      );

      // Change Git outside the app while the second panel remains focused.
      await git(repositoryPath, "switch", "main");

      // Clicking the existing first panel changes focus without changing its
      // sessionId or workingDirectory, which is the regression path.
      await firstBadge.click();
      await page.keyboard.press("Escape");
      await expect(firstPanel).toHaveClass(/shadow-panel-focused/);
      await expect(firstBadge).toHaveAttribute("aria-label", "main");
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });
});
