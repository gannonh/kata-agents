# Git workspaces

Git workspace controls let a user keep a session in the current checkout or create a named managed worktree with a matching branch and persisted checkout identity.

## Sub-features

- `git-current` selects the current checkout.
- `git-new-worktree` opens the managed-worktree form.
- `git-name` normalizes a user-supplied worktree name.
- `git-branch` creates and persists the expected `kata-agent/<name>` branch.
- `git-root` uses the configured worktree materialization root.
- `git-cleanup` removes fixture worktrees, branches, sessions, and temporary repositories.

## How to get to it (user POV)

- Start a new session in a Git repository workspace.
- Open the workspace badge beside the composer.
- Choose `New worktree`, name it, and choose `Create worktree`.
- Continue chatting in the new session; use Settings → Worktrees to configure the root when needed.

## Driving it with Playwright + real Electron

Preconditions:

- Use a disposable Git repository created by the test fixture, not the repository containing this skill.
- For offline identity/root coverage, use the `@worktree-v2` tests. For GitHub push/PR coverage, authenticated `gh`, a configured `KATA_E2E_GIT_REPO`, and `KATA_E2E_WORKERS=1` are required.

- **Select the workspace.** Start a new session, click `[data-testid="git-workspace-control"]`, and choose `[data-testid="git-workspace-new-worktree"]`.
- **Name and create.** Fill `[data-testid="git-workspace-name"]` with a human name such as `Auth Refresh`; assert the normalized value `auth-refresh`; click `[data-testid="git-workspace-create"]`.
- **Read the result.** Assert `[data-testid="git-workspace-identity"]` contains `auth-refresh`, read the persisted session metadata through the existing test flow, run `git branch --show-current` in the reported checkout path, and require `kata-agent/auth-refresh`.
- **Configure a root.** Navigate to Settings → Worktrees, fill `[data-testid="worktrees-root-input"]`, click `[data-testid="worktrees-save"]`, and assert the canonical path read back before creating a second worktree.
- **Checked-in coverage.** Run `bun run e2e --grep @worktree-v2 --trace on` for offline state/identity/root proof. Run `bun run e2e --grep @git --trace on` only for authenticated GitHub UAT.
- **Proof.** Keep the UI identity, persisted metadata, `git branch --show-current`, checkout existence, root containment check, and cleanup log together. A branch label without checking the real checkout is insufficient.

## Gotchas

- Never create a managed worktree in the user's current checkout or use the repository root as a disposable fixture.
- The worktree form can be capability-gated; wait for `[data-testid="git-workspace-create"]` to be enabled before clicking.
- Worktree names are normalized; assert the normalized field and branch, not only the text typed into the input.
- Managed worktrees are owned by sessions. Delete fixture sessions with `removeManagedWorktree: true` and verify the checkout is gone.
- GitHub integration creates remote state. Its cleanup closes the created PR and deletes the remote branch; retain the report but never skip cleanup.
