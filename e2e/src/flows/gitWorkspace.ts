import type { Page } from "@playwright/test";

export interface PreparedManagedWorktreeSession {
  readonly id: string;
  readonly checkout: {
    readonly checkoutPath: string;
    readonly expectedBranch: string | null;
    readonly mode: "managed-worktree";
    readonly managedWorktreeId: string | null;
  };
}

export async function useRepositoryAsWorkspaceDefault(
  page: Page,
  repositoryPath: string,
): Promise<void> {
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
      throw new Error(
        "Git E2E setup: the ready shell has no active workspace.",
      );
    }
    await api.updateWorkspaceSetting(
      workspaceId,
      "workingDirectory",
      workingDirectory,
    );
  }, repositoryPath);
}

export async function readManagedWorktreeSession(
  page: Page,
): Promise<PreparedManagedWorktreeSession | null> {
  const sessions = await readManagedWorktreeSessions(page);
  return sessions[0] ?? null;
}

/**
 * All persisted sessions bound to a managed-worktree checkout. Used by the
 * existing-worktree flow to assert that two sessions share ONE worktree
 * identity (same checkout path + managed worktree ID).
 */
export async function readManagedWorktreeSessions(
  page: Page,
): Promise<PreparedManagedWorktreeSession[]> {
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
                managedWorktreeId: string | null;
              };
            }>
          >;
        };
      }
    ).electronAPI;
    const sessions = await api.getSessions();
    return sessions
      .filter((candidate) => candidate.checkout?.mode === "managed-worktree")
      .map((session) => ({
        id: session.id,
        checkout: session.checkout as PreparedManagedWorktreeSession["checkout"],
      }));
  });
}
