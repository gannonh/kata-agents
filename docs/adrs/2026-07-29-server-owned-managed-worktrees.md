---
type: ADR
title: Server-owned managed Git worktrees
description: The workspace-owning server owns all managed-worktree lifecycle and Git mutation for Git/GitHub V1
tags: [git, worktrees, sessions, architecture]
timestamp: 2026-07-29T00:00:00Z
---

# ADR: Server-owned managed Git worktrees

## Status

Accepted

## Context

Git/GitHub V1 (see [design spec](../specs/2026-07-26-git-github-worktrees-v1-design.md)) lets a
session run against an isolated **managed worktree** instead of the Current checkout. A managed
worktree is a real `git worktree` plus a temporary `kata-agent/<8-hex>` working branch. This raises
questions the fork must answer once: who creates and owns worktrees, where they live, how ownership
is tracked across conversation branches and session import, and how concurrent Git mutations on the
same repository are serialized.

Kata runs in both embedded (Electron) and headless (remote) hosts. Only the host that owns the
workspace filesystem can safely run Git. Clients (renderer, WebUI, CLI) never hold a mutation path.

## Decision

The **workspace-owning server owns all managed-worktree lifecycle and Git behavior.** Concretely:

- A single server Git domain (`packages/server-core/src/git/`) provides `RepositoryService`
  (read-only discovery/refs/status via an `execFile`-based command runner — never shell strings),
  `ManagedWorktreeService` + `WorktreeRegistry` (create, `.worktreeinclude`, ownership, removal
  risk), and a `MutationLock`.
- **Mutations serialize by Git common directory.** All worktree add/remove and future
  commit/pull/push for a repository funnel through one lock keyed on the real
  `git rev-parse --git-common-dir`, because worktrees of one repository share branch/ref metadata.
- **Worktrees live under Kata config data**, not inside the user's repository:
  `<CONFIG_DIR>/worktrees/<workspace-id>/<repo-key>/<token>/`. `repo-key` is 16 hex chars of
  SHA-256 over the normalized Git common-directory path; `token` is 8 hex chars shared by the path
  and the `kata-agent/<token>` branch.
- **Checkout preparation is an empty-session gate** on `SessionManager`. It runs only when a session
  has no messages, no SDK session ID, and no live agent, and binds `checkout` metadata,
  `workingDirectory`, and initial `sdkCwd` atomically. A New worktree/ref intent stays renderer state
  until preparation succeeds; it is never persisted as a promised worktree on an unprepared session.
- **Ownership is a set of session IDs in the registry.** Conversation branches (SDK forks) inherit
  the parent's checkout and add themselves as owners of the same managed worktree; V1 does not claim
  filesystem isolation between conversation branches. Removal is blocked until the final owner is
  deleted.
- **Session import/bundle clears managed-worktree ownership.** Worktrees are host-specific paths and
  are not portable, so imported sessions start without a `checkout` and derive live Git context from
  their `workingDirectory`.
- The feature is gated end-to-end by `KATA_FEATURE_GIT_WORKSPACE_V1` / `FEATURE_FLAGS.gitWorkspaceV1`
  (disabled by default). Read-only repository/ref discovery is always available; mutation handlers
  reject while the flag is off.

### Deletion and removal are one ordered server operation

Session deletion and managed-worktree removal are **two irreversible steps that the client may not
sequence itself**. `SessionManager.deleteSession(sessionId, { removeManagedWorktree,
forceWorktreeRemoval })` performs them in a fixed order:

1. quiesce the agent (`forceAbort`) — a live turn writes into the checkout, so nothing may inspect or
   remove it while one is running;
2. dry-run every removal guard (ownership, `force` requirement, identity revalidation) while the
   session still resolves its own checkout identity;
3. delete the session durably;
4. only then remove the checkout.

A blocked removal is **atomic in the caller's favour**: nothing is deleted and nothing is removed, so
the client can report why and the user retries or drops the removal choice. A removal that fails
*after* step 3 leaves an unowned worktree, which is a recoverable state, whereas the reverse order
could leave a persisted session pointing at a checkout that no longer exists — an unusable state.

Removal is therefore requested *through* deletion. The standalone `git:removeWorktree` channel
remains for removing a checkout without deleting its session.

Corollary for **unattended** deletes (auto-delete of an empty session, the `delete-session` deep
link): they request removal without `force`. Nothing removes an unowned checkout later —
reconciliation only drops dead owner references and records state — so leaving one behind is a leak,
while forcing would discard work no human confirmed. Non-forced removal resolves both: a clean
provisional checkout is discarded with its session, and one holding uncommitted or unique work blocks
the removal and therefore the deletion, keeping the session as the route to that work. Because such
callers cannot inspect the session first, `removeManagedWorktree` distinguishes *nothing to remove*
(no managed checkout, no registry record, not an owner, feature disabled → deletion proceeds) from
*blocked by a guard* (→ abort).

### A bound checkout owns the session's working directory

Once `session.checkout` is bound, the checkout — not the composer — is authoritative for where the
session works. `updateWorkingDirectory` rejects any change for a bound session, because Git actions,
the Changes surface, and `sdkCwd` all resolve from the persisted checkout: repointing
`workingDirectory` would have the agent edit one tree while Kata inspects and commits another. The
server rejects it rather than relying on the UI, since hiding a control does not close the channel;
the composer additionally withdraws its directory selectors in favour of the checkout identity.

### The Changes surface is HEAD→working-tree, and status must agree

V1 shows no staged/unstaged sections, and the selected-file commit stages from the working tree
(`git add -A -- <paths>`). Status entries must therefore describe the same HEAD→working-tree delta the
diff renders and the commit would write: an entry whose index differs from HEAD while its working
tree matches HEAD has nothing to show and nothing to commit, and is omitted. Index state remains
available to action safety logic, which reads it directly. Absence of a HEAD→working-tree diff is
only meaningful when a diff could be taken at all — on an unborn branch it means "unknown", not "no
delta".

## Consequences

- Clients refer to a session or workspace plus typed operation input, never a client-provided
  mutation path — the same contract works for embedded and remote hosts.
- Managed worktrees never pollute the user's repository working tree and survive session archival.
- The common-directory mutation lock prevents ref/branch races but serializes unrelated mutations on
  the same repository; this is acceptable for V1 interactivity.
- Because worktree paths are host-specific, moving a session between machines drops managed-worktree
  binding by design; the conversation JSONL remains inspectable.
- Every Git capability channel is declared and classified in `protocol/routing.ts` now (Phases 1–4)
  so routing exhaustiveness stays green even though later-phase handlers stub with
  feature/not-implemented rejections.

## References

- [Git and GitHub worktrees V1 design](../specs/2026-07-26-git-github-worktrees-v1-design.md)
- Server Git domain: `packages/server-core/src/git/`
- Checkout gate: `packages/server-core/src/sessions/SessionManager.ts` (`prepareCheckout`)
