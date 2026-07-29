import { E2E_TAGS } from "../../src/config/tags.ts";
import { test } from "../../src/fixtures/testFixtures.ts";

/**
 * Managed-worktree Git flow (@git) — DEFERRED to macOS UAT/Verify.
 *
 * The full slice (choose New worktree → prepare → agent edits → review Changes →
 * commit → push → open PR → delete session with worktree removal) drives the
 * real Electron GUI and, for the PR leg, a disposable real GitHub repository
 * plus an authenticated `gh`. Neither the GUI nor `gh` auth is available in the
 * Linux cloud build environment, so these are authored as `test.fixme`
 * placeholders and executed during the macOS Verify/UAT pass.
 *
 * Runnable-in-CI coverage for the same behavior lives server-side as a serial
 * headless-server flow that proves remote-ownership parity without a GUI:
 * `packages/server-core/src/handlers/rpc/headless-server-flow.test.ts`.
 *
 * Authoring guide: `.agents/skills/e2e-test-author/SKILL.md`. Before enabling,
 * add stable id selectors to the composer Workspace control, the Changes panel,
 * the header Git action control, and the delete-session dialog.
 */
test.describe(`Managed worktree Git flow ${E2E_TAGS.git}`, () => {
  test.fixme(
    "prepares a worktree, reviews changes, and commits from the app",
    async ({ authenticatedAppWindow }) => {
      // Deferred to macOS Verify/UAT. Intended steps:
      // 1. New session in a Git repo → open the composer Workspace control.
      // 2. Select "New worktree", pick a base ref, and send the first message.
      // 3. After an agent edit, open the Changes panel and select a file.
      // 4. Commit the selected file; assert the header control returns to clean.
      void authenticatedAppWindow;
    },
  );

  test.fixme(
    "removes a managed worktree as a separate confirmed choice when deleting a session",
    async ({ authenticatedAppWindow }) => {
      // Deferred to macOS Verify/UAT. Intended steps:
      // 1. Delete a managed-worktree session → the delete dialog offers removal.
      // 2. With uncommitted work, assert the destructive confirmation names counts.
      // 3. Confirm; assert the session is gone and the worktree is removed.
      void authenticatedAppWindow;
    },
  );

  test.fixme(
    "surfaces gh setup guidance without changing repository state when gh is unavailable",
    async ({ authenticatedAppWindow }) => {
      // Deferred to macOS Verify/UAT (needs controlled gh absence/auth state).
      void authenticatedAppWindow;
    },
  );
});
