import type { Page } from "@playwright/test";

export interface PreparedManagedWorktreeSession {
  readonly id: string;
  readonly checkout: {
    readonly checkoutPath: string;
    readonly expectedBranch: string | null;
    readonly mode: "managed-worktree";
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
    const session = sessions.find(
      (candidate) => candidate.checkout?.mode === "managed-worktree",
    );
    return session
      ? {
          id: session.id,
          checkout:
            session.checkout as PreparedManagedWorktreeSession["checkout"],
        }
      : null;
  });
}
