import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";

import { E2E_TAGS } from "../../src/config/tags.ts";
import { completeDeferredSetup } from "../../src/flows/onboarding.ts";
import { startNewSession } from "../../src/flows/agentChat.ts";
import {
  readManagedWorktreeSessions,
  useRepositoryAsWorkspaceDefault,
} from "../../src/flows/gitWorkspace.ts";
import { expect, test } from "../../src/fixtures/testFixtures.ts";
import { buildElectronLaunchEnv } from "../../src/harness/launchEnv.ts";
import type { E2ERunContext } from "../../src/harness/isolatedRun.ts";

process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = "1";
process.env.KATA_FEATURE_WORKTREE_V2 = "1";

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
  const repository = await mkdtemp(join(tmpdir(), "kata-agents-worktree-v2-e2e-"));
  await git(repository, "init", "-b", "main");
  await git(repository, "config", "user.name", "Kata E2E");
  await git(repository, "config", "user.email", "kata-e2e@example.com");
  await writeFile(join(repository, "README.md"), "# Worktree V2 fixture\n");
  await git(repository, "add", "README.md");
  await git(repository, "commit", "-m", "fixture: initial commit");
  return repository;
}

/** Restart the Electron process while retaining the fixture's Vite server/config. */
async function restartElectron(
  current: ElectronApplication,
  context: E2ERunContext,
): Promise<{ app: ElectronApplication; page: Page }> {
  await current.close();
  const env = Object.fromEntries(
    Object.entries(buildElectronLaunchEnv(context)).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string",
    ),
  );
  const app = await electron.launch({
    args: [join(context.repoRoot, "apps/electron")],
    cwd: context.repoRoot,
    env,
  });
  const page = await app.firstWindow();
  await completeDeferredSetup(page);
  // The renderer can retain a completed splash transition across a process
  // restart, so assert the ready shell's stable New Session control instead of
  // relying on the one-shot #app-ready marker.
  await expect(page.locator("body")).toContainText("New Session", {
    timeout: 30_000,
  });
  return { app, page };
}

async function deleteManagedSessions(page: import("@playwright/test").Page): Promise<void> {
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

test.describe(`Worktree V2 name and root ${E2E_TAGS.worktreeV2}`, () => {
  test("creates a named worktree, changes the server root, and recovers both paths after restart @worktree-v2 name root", async ({
    authenticatedAppWindow: initialPage,
    launchedApp,
    runContext,
  }) => {
    let page = initialPage;
    let restartedApp: ElectronApplication | undefined;
    const repository = await createRepository();
    const customRoot = await mkdtemp(join(tmpdir(), "kata-agents-worktree-v2-root-"));

    try {
      await useRepositoryAsWorkspaceDefault(page, repository);
      await startNewSession(page);

      const workspaceControl = page.getByTestId("git-workspace-control");
      await expect(workspaceControl).toBeVisible();
      await workspaceControl.locator("button").click();
      await page.getByTestId("git-workspace-new-worktree").click();
      await expect(page.getByTestId("git-workspace-name")).toBeVisible();
      await page.getByTestId("git-workspace-name").fill("Auth Refresh");
      await expect(page.getByTestId("git-workspace-name")).toHaveValue("auth-refresh");
      await page.getByTestId("git-workspace-create").click();

      await expect(page.getByTestId("git-workspace-identity")).toContainText("auth-refresh");
      const first = (await readManagedWorktreeSessions(page)).find(
        (session) => session.checkout.displayName === "auth-refresh",
      );
      expect(first).toBeDefined();
      if (!first) throw new Error("Worktree V2 E2E: named session was not persisted.");
      expect(first.checkout.expectedBranch).toBe("kata-agent/auth-refresh");
      expect(first.checkout.materializationRoot).toBeDefined();
      await access(first.checkout.checkoutPath);
      // The live checkout must be on the exact named branch, not just persisted metadata.
      expect(await git(first.checkout.checkoutPath, "branch", "--show-current")).toBe(
        "kata-agent/auth-refresh",
      );

      await page.evaluate(() => {
        window.dispatchEvent(
          new CustomEvent("kata-agent-navigate", { detail: { route: "settings/worktrees" } }),
        );
      });
      await expect(page.getByTestId("worktrees-settings-page")).toBeVisible();
      await page.getByTestId("worktrees-root-input").locator("input").fill(customRoot);
      await page.getByTestId("worktrees-save").click();
      const canonicalRoot = await realpath(customRoot);
      await expect(page.getByTestId("worktrees-root-input").locator("input")).toHaveValue(canonicalRoot);

      await page.evaluate(() => {
        window.dispatchEvent(
          new CustomEvent("kata-agent-navigate", { detail: { route: "allSessions" } }),
        );
      });
      await startNewSession(page);
      await page.getByTestId("git-workspace-control").locator("button").click();
      await page.getByTestId("git-workspace-new-worktree").click();
      await page.getByTestId("git-workspace-name").fill("custom-root");
      await page.getByTestId("git-workspace-create").click();
      await expect(page.getByTestId("git-workspace-identity")).toContainText("custom-root");

      const sessions = await readManagedWorktreeSessions(page);
      const second = sessions.find((session) => session.checkout.displayName === "custom-root");
      expect(second).toBeDefined();
      if (!second) throw new Error("Worktree V2 E2E: custom-root session was not persisted.");
      expect(second.checkout.expectedBranch).toBe("kata-agent/custom-root");
      expect(second.checkout.materializationRoot).toBe(canonicalRoot);
      // Path-aware containment: the checkout must be a direct descendant of the
      // configured root, never a sibling or an escaped path.
      const rootRelative = relative(canonicalRoot, second.checkout.checkoutPath);
      expect(rootRelative).not.toBe("");
      expect(isAbsolute(rootRelative)).toBe(false);
      expect(rootRelative.startsWith(`..${sep}`) || rootRelative === "..").toBe(false);
      await access(second.checkout.checkoutPath);
      expect(await git(second.checkout.checkoutPath, "branch", "--show-current")).toBe(
        "kata-agent/custom-root",
      );

      const restarted = await restartElectron(launchedApp.electronApp, runContext);
      restartedApp = restarted.app;
      page = restarted.page;

      const recovered = await readManagedWorktreeSessions(page);
      expect(recovered).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            checkout: expect.objectContaining({
              displayName: "auth-refresh",
              expectedBranch: "kata-agent/auth-refresh",
            }),
          }),
          expect.objectContaining({
            checkout: expect.objectContaining({
              displayName: "custom-root",
              expectedBranch: "kata-agent/custom-root",
              materializationRoot: canonicalRoot,
            }),
          }),
        ]),
      );

      // After restart both live checkouts must still sit on their exact branches.
      for (const session of recovered) {
        await access(session.checkout.checkoutPath);
        expect(await git(session.checkout.checkoutPath, "branch", "--show-current")).toBe(
          session.checkout.expectedBranch,
        );
      }

      const statusPaths = await page.evaluate(async (paths) => {
        const api = (window as unknown as {
          electronAPI: { getGitStatus(path: string): Promise<{ checkoutPath: string }> };
        }).electronAPI;
        return await Promise.all(paths.map(async (path) => (await api.getGitStatus(path)).checkoutPath));
      }, recovered.map((session) => session.checkout.checkoutPath));
      expect(statusPaths).toEqual(expect.arrayContaining(recovered.map((session) => session.checkout.checkoutPath)));
    } finally {
      await deleteManagedSessions(page).catch(() => undefined);
      await restartedApp?.close().catch(() => undefined);
      await rm(repository, { recursive: true, force: true });
      await rm(customRoot, { recursive: true, force: true });
    }
  });
});
