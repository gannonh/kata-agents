import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { E2E_TAGS } from "../../src/config/tags.ts";
import { startNewSession } from "../../src/flows/agentChat.ts";
import { useRepositoryAsWorkspaceDefault } from "../../src/flows/gitWorkspace.ts";
import { expect, test } from "../../src/fixtures/testFixtures.ts";

process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = "1";

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
});
