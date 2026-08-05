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

Git/GitHub V1 (see [design spec](../specs/archive/2026-07-26-git-github-worktrees-v1-design.md)) lets a
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
  (enabled by default since 0.10.8, with `KATA_FEATURE_GIT_WORKSPACE_V1=0` as an override).
  Read-only repository/ref discovery is always available; mutation handlers reject while the flag
  is off.

### Worktree V2 identity and roots

Phase 1 extends the server-owned V1 domain without changing V1 behavior:

- `KATA_FEATURE_WORKTREE_V2` is default-false and effective only when
  `KATA_FEATURE_GIT_WORKSPACE_V1` is enabled. Capabilities advertise the effective
  combination, and clients send the versioned V2 name intent only when the selected
  owning server supports it. Disabled or incapable V2 requests fail with a typed
  capability error rather than being interpreted as V1.
- A V2 name is an exact branch suffix. The server validates `kata-agent/<name>`
  under the common-directory mutation lock, keeps nested valid suffixes, and
  rejects empty, padded, Git-invalid, occupied, exact-colliding, and
  case-colliding names without sanitizing or changing the requested identity.
  The checkout leaf is derived from a safe display fragment plus a cryptographically
  random internal ID; the client never supplies the path.
- The materialization root is a per-server setting. The default remains
  `<CONFIG_DIR>/worktrees`; a saved root is expanded, canonicalized, writability-
  checked, and rejected when it overlaps protected server storage, a registered
  repository, or a managed checkout. An immutable versioned snapshot is captured
  and revalidated for each creation, so a root update affects only new checkouts.
  Existing records retain their recorded canonical `materializationRoot`.
- The registry remains authoritative at the fixed
  `<CONFIG_DIR>/worktrees/registry.json` path, independent of the configurable
  materialization root. Its versioned in-place upgrade is atomic and fail-closed
  under the cross-process lock; unreadable, unsupported, or conflicting data is
  preserved and blocks V2 mutation rather than being replaced with an empty file.
  V1 records retain their IDs, paths, branches, base refs, owners, and state while
  deriving a display name from the existing branch suffix.
- Creation compensation records whether the request created the branch and its
  original OID. Cleanup can delete that branch only after compare-and-swap proof
  that the ref is still unchanged and request-owned; pre-existing or externally
  changed refs remain intact.

The Settings page selects a local or connected capable server and labels the
selected server's root. A directory picker is local-only; remote roots are never
sent to or resolved by the Electron filesystem. This preserves the same typed
settings, preparation, session metadata, and Git-action contracts for embedded
and headless clients.

### Deletion and removal are one ordered server operation

Session deletion and managed-worktree removal are **two irreversible steps that the client may not
sequence itself**. `SessionManager.deleteSession(sessionId, { removeManagedWorktree,
forceWorktreeRemoval })` performs them in a fixed order:

1. await `agent.quiesceForTeardown(AbortReason.UserStop)` before inspecting or removing the
   checkout whenever an agent exists and managed-worktree removal was requested. Plain session
   deletion uses the same contract when the session is processing. The required backend contract
   requests the existing hard abort, waits for every active and nested `BaseAgent.chat()` generator
   to leave its `finally` block, and then waits for provider-owned processes that could still write
   into the checkout. Claude reaches this boundary when its SDK `Query` iteration completes; Pi
   additionally shuts down the captured persistent child and requires its operating-system `exit`
   event, escalating from `SIGTERM` to `SIGKILL` and rejecting if exit remains unconfirmed. The
   synchronous `forceAbort` method remains unchanged for ordinary stop, redirect, and handoff paths.
   SessionManager bounds the await at five seconds and attaches rejection handling before racing the
   timeout. A rejection or timeout refuses managed-worktree removal and restores any staged session;
   plain deletion remains available because it never removes the checkout. Idle agents are still
   quiesced for explicit worktree removal so a persistent Pi child cannot outlive its session;
2. flush persistence and atomically rename the complete session directory to a reversible
   tombstone;
3. perform strict status inspection, the authoritative fingerprint/ownership comparison, and
   checkout removal under the repository mutation lock while the runtime session still exists;
4. if removal blocks, rename the tombstone back; if removal succeeds, remove the runtime session
   and finalize the tombstone.

The deletion transaction lives outside the normal `sessions/` discovery tree.
On startup, a transaction whose registry record and checkout still exist is
restored before sessions are loaded; if checkout removal completed, the hidden
transaction is purged. A crash or finalization failure therefore cannot
resurrect a session that points at a removed checkout.

For a destructive removal, `forceWorktreeRemoval` is bound to an opaque
server-issued fingerprint of the checkout identity (including the HEAD OID),
dirty paths, exact index entries, file modes and working-tree contents, and
unique commit identities inspected for the confirmation dialog. Ignored files
are inventoried separately because `git status` omits them even though forced
worktree removal would destroy them; their paths, modes, and contents contribute
to the fingerprint and displayed file count. The file and commit counts remain
user-facing copy, but they are not the authorization: different work can have
identical counts. The server validates static checkout identity first, then
takes its authoritative snapshot as the final awaited guard under the
repository mutation lock and rechecks ownership synchronously before removal
starts. Status failures close the operation. Any changed fingerprint blocks the
whole deletion, restores the staged session directory, keeps the session and
checkout reachable, and makes the client refresh before a person can confirm
the current state. A stale Boolean `force` flag or count-only summary is never
sufficient.

After checkout removal succeeds, browser, agent, and pool-server teardown is
best-effort. A synchronous cleanup exception is logged and contained so runtime
session removal and staged-storage finalization still complete; cleanup cannot
interrupt the deletion transaction after its irreversible step.

A blocked removal is **atomic in the caller's favour**: nothing is deleted and nothing is removed, so
the client can report why and the user retries or drops the removal choice. There is no
dry-run-to-final-removal gap in which a mismatch can be found only after the session was deleted.

Reclamation works from registry records, so a removal that fails must **keep its record**. Both the
git removal and the manual directory fallback can fail without throwing; dropping the record then
would leave a directory on disk that no recovery path can see. A failed removal therefore reports
`removed: false`, marks the record `blocked`, and leaves the temporary branch alone (it is still
checked out in the surviving worktree).

An unowned worktree is recoverable because **reconciliation reclaims it**, not because it is
harmless. Startup reconciliation removes unowned checkouts that are clean — reusing
`removeWorktree`'s guards, never with `force` — and retains unowned checkouts that hold work,
marking them `blocked` so crash residue or older registry state remains visible rather than inferred
from a directory nobody can reach.

A destructive confirmation authorizes **only the exact work it displayed**. Added, removed, or
substituted dirty work, a different unique commit with the same count, or changed checkout identity
all invalidate the fingerprint and require a fresh confirmation.

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

- [Git and GitHub worktrees V1 design](../specs/archive/2026-07-26-git-github-worktrees-v1-design.md)
- Server Git domain: `packages/server-core/src/git/`
- Checkout gate: `packages/server-core/src/sessions/SessionManager.ts` (`prepareCheckout`)
