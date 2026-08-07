---
type: ADR
title: Conflict-safe checkout handoff
description: The workspace-owning server moves a single-owner idle session between the current checkout and a managed worktree with fingerprint-bound previews, journaled idempotent steps, snapshot-backed rollback, and provider-proven execution-CWD rebinding
tags: [git, worktrees, handoff, sessions, snapshots, provider, architecture]
timestamp: 2026-08-07T00:00:00Z
---

# ADR: Conflict-safe checkout handoff

## Status

Accepted

## Context

Worktree V2 Phases 1 and 2 ([#40](https://github.com/gannonh/kata-agents/issues/40), [server-owned managed worktrees ADR](2026-07-29-server-owned-managed-worktrees.md); [#41](https://github.com/gannonh/kata-agents/issues/41), [snapshot-backed worktree lifecycle ADR](2026-08-05-snapshot-backed-worktree-lifecycle.md)) give a session an isolated managed checkout with verified snapshot-before-release and durable recovery. A session is still bound to one checkout for its whole life, and V1 rejects bound-session directory changes.

Phase 3 ([#42](https://github.com/gannonh/kata-agents/issues/42)) must move a single-owner idle session — and its exact supported Git work state — between the repository's current checkout and a managed worktree without overwriting destination work or breaking provider conversation continuity. Two properties make this unsafe to do naively:

- **Git cannot check out one branch twice.** A managed branch is checked out in its worktree; the current checkout cannot hold the same branch until the worktree is released, and the released copy is the only copy of that branch's state until it is re-materialized.
- **Transcript identity and execution directory are coupled today.** `sdkCwd` serves as both transcript lookup and SDK process CWD for some providers; changing session metadata alone is unsafe without a provider seam that separates immutable transcript storage from mutable execution checkout.

The server owns all Git mutations and all checkout paths, so handoff must stay server-side: clients submit a transaction ID and an expected preview fingerprint, never paths or patches.

## Decision

**`WorktreeHandoffService` (server-core) is the single owner of handoff previews, confirmation, recovery, and fencing, and every enabled provider adapter must prove destination execution before Send unlocks.**

### Fingerprint-bound previews and typed blockers

- A preview is side-effect free beyond registering an in-memory transaction. It binds every decision-relevant fact — source/destination identity, canonical path leases and all live sessions, branch/worktree occupancy, HEAD/index/worktree/untracked/`.worktreeinclude` state, cleanup counts, return ref, provider capability, transcript CWD, and recovery behavior — into a `previewFingerprint`.
- Confirmation revalidates the fingerprint under the common-directory mutation lock; any drift returns a typed `identity-drift` blocker and claims no mutation. Clients confirm by transaction ID + preview fingerprint only.
- Every precondition failure returns a typed blocker (`unsupported-provider`, `unsupported-snapshot`, `destination-dirty`, `destination-missing`, `destination-detached`, `branch-occupied-outside-journal`, `another-path-user`, `shared-owners`, `runtime-active`, `cleanup-in-progress`, `git-operation-in-progress`, `oversized-capture`, `identity-drift`, `flags-disabled`, `handoff-in-progress`, `invalid-name`, `handoff-rolled-back`) before any mutation.

### Three directions, one ordering rule

- **current-to-managed** (destination-authoritative): snapshot current, create `kata-agent/<name>` at source HEAD (pinned by a preview-issued path token so the destination path never drifts from the fingerprint), restore/verify the unoccupied target, then remove only captured tracked/index/eligible-untracked state from current. Included and other ignored files remain in current; `.worktreeinclude` files transfer by copy and a differing target file blocks rather than overwrites.
- **managed-to-current** (source-authoritative): snapshot/verify the managed source, keep the record as `snapshotted` with the snapshot attached (so hand-back always has a durable target), release the managed materialization (Git cannot check out one branch twice), switch current to the branch, restore/verify, commit the binding. Destination-first verification is impossible in this direction and is not claimed; the retained snapshot is the rollback authority.
- **hand-back**: snapshot current, remove only captured transferable state, return current to the recorded return ref to free the branch, materialize/restore/verify the managed target from the retained `snapshotted` record, commit the binding. A branch still checked out elsewhere is never materialized again.

### Journal-first durability and snapshot-backed rollback

- A durable append-only journal records the transaction before any mutation and every idempotent step (quiesced, captured, target-created, source-released, branch-switched, target-verified, runtime-rebound, binding-committed). Metadata carries direction, leases, source/destination fingerprints, retained snapshot, return ref, branch ownership, provider capability, transcript CWD, and runtime proof.
- The durable session binding changes only at the commit point; the immutable `transcriptCwd` never changes. Failed or interrupted transactions are restored at startup and fence Send, agent creation, Git mutations, session deletion, auto-cleanup, and another handoff for both paths.
- `recover()` performs an idempotent snapshot-backed rollback per direction: remove transaction-owned targets and branches (only while they still point at the captured OID), restore cleaned sources from the retained snapshot, re-materialize released managed records, and return current to the recorded ref — resolving to the typed `handoff-rolled-back` blocker. `binding-committed` without a journal commit marker stays explicit recovery-required. Orphan snapshot GC treats journal-referenced snapshots as referenced so the recovery authority survives a released record.

### Transcript identity vs. execution CWD

- `ExecutionCwdRebindCapability` (shared agent/backend) is the provider seam: `handoffCapability()` advertises the sanitized capability, `rebindExecutionCwd(destination)` recreates or rebinds execution without touching transcript identity, and `verifyExecutionCwd(destination)` returns a proof covering file, shell, MCP, and provider tool resolution of the exact destination.
- Handoff is exposed only when the session's provider advertises **and** structurally implements the full rebind + verify surface (`resolveHandoffCapability` gate). Unsupported adapters return a typed blocker and preserve V1 behavior. Claude's current use of `sdkCwd` for both transcript lookup and process CWD is the explicit implementation gate: **every production adapter remains disabled until credentialed dev and packaged UAT proves context continuity and exact tool CWD through current → managed → current → managed.** No fallback, fresh-conversation reset, or transcript migration is allowed.
- The session runtime reconstruction gate (`SessionManager.verifyHandoffRuntimeBeforeSend`) arms a committed handoff as `unverified` and requires the live adapter to re-prove the destination before the first Send after a commit — and after every restart, because a verified proof is never persisted. Failure persists `recovery-required` and blocks Send; a later Send re-attempts the proof so a fixed runtime resumes without re-running the handoff.
- Credential-free state-machine coverage uses a deterministic adapter factory (`createDeterministicHandoffAdapter`) with explicit failure injection; it exercises every direction, blocker, proof gate, and rollback without a live provider.

### Client contract

- Local Electron and headless/remote clients share the same preview/confirm/status/recover RPC channels (`git:handoffPreview`, `git:handoffConfirm`, `git:handoffStatus`, `git:handoffRecover`), all remote-eligible. Remote-owned previews are labeled with the owning server and expose no local reveal.
- Handoff actions render only when the server-derived session `handoffCapable` flag is true (AC-1); the server's typed blocker remains the authoritative backstop.

## Consequences

- A single-owner idle session can move between current and managed checkouts with its exact supported work state, preserving commits, staged/unstaged state, renames/deletions, binary data, modes, eligible untracked state, copied `.worktreeinclude` files, session/tool history, provider identity, and immutable transcript CWD.
- Every destructive step has a journaled intent and a verified snapshot authority; interrupted transactions are rolled back or exposed as explicit recovery-required — no outcome loses the snapshot or hides duplicate work.
- Managed-to-current release keeps the registry record `snapshotted` instead of deleting it, so hand-back always has a durable target; this mirrors the lifecycle phase's snapshot-first removal ordering.
- Clients never hold paths or patches; the same contracts work for embedded and remote hosts, and remote paths stay server-labeled.
- Providers that cannot separate transcript storage from destination execution simply do not expose handoff (V1 preserved); enabling a production adapter is a future, credentialed, per-provider decision gated by live UAT — not part of this Build phase.
- Cross-repository apply, arbitrary destination paths, shared-worktree handoff, merge/rebase/conflict resolution, dirty or differing-included overwrite, and ignored-file movement outside `.worktreeinclude` remain out of scope by decision.

## Links

- Spec: [#42](https://github.com/gannonh/kata-agents/issues/42) (Worktree V2 Phase 3)
- Parent epic: [#17](https://github.com/gannonh/kata-agents/issues/17)
- Phase 1: [#40](https://github.com/gannonh/kata-agents/issues/40), [server-owned managed worktrees ADR](2026-07-29-server-owned-managed-worktrees.md)
- Phase 2: [#41](https://github.com/gannonh/kata-agents/issues/41), [snapshot-backed worktree lifecycle ADR](2026-08-05-snapshot-backed-worktree-lifecycle.md)
- Later phase: [#43](https://github.com/gannonh/kata-agents/issues/43) (isolated conversation forks)
