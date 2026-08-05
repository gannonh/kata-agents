---
type: ADR
title: Snapshot-backed worktree lifecycle and automatic cleanup
description: Every destructive V2 path routes through one lifecycle service with verified snapshots, path fences, a durable journal, and event-driven retention cleanup
tags: [git, worktrees, lifecycle, snapshots, architecture]
timestamp: 2026-08-05T00:00:00Z
---

# ADR: Snapshot-backed worktree lifecycle and automatic cleanup

## Status

Accepted

## Context

Worktree V2 Phase 1 ([#40](https://github.com/gannonh/kata-agents/issues/40), [server-owned managed worktrees ADR](2026-07-29-server-owned-managed-worktrees.md)) established custom identity, per-server roots, and a fail-closed registry. The remaining V1 removal path can prune a branch and registry record without a restorable payload: destructive removal could silently lose staged, unstaged, untracked, or `.worktreeinclude`-selected work.

Phase 2 ([#41](https://github.com/gannonh/kata-agents/issues/41)) must make every removal recoverable and add automatic cleanup without a background daemon. Shared ownership ([#33](https://github.com/gannonh/kata-agents/issues/33)) means lifecycle decisions must fence one record, all owner sessions, and every live runtime using its path.

## Decision

**Every V2 destructive path enters one `WorktreeLifecycleService`; a verified snapshot is mandatory before any materialized checkout is released.**

### Snapshot fidelity

- `WorktreeSnapshotService` captures the staged projection (`git diff --cached --binary`), the unstaged projection (`git diff --binary`), untracked regular files, non-dereferenced symlink nodes, and `.worktreeinclude` regular files into a versioned manifest with per-component SHA-256 hashes. Deletions, renames, and binary changes ride in Git's own patch format.
- Capture excludes `.git`, ignored files outside `.worktreeinclude`, submodule working trees, and unsupported sparse/unmerged/operation state. Unsupported or unreadable state blocks deletion instead of producing a partial snapshot. Payloads are preflight-bounded (10,000 files, 100 MiB) and streamed to an owner-only temporary directory, verified, and atomically published.
- A hidden `refs/kata/worktree-snapshots/<snapshot-id>` ref is compare-and-swap created only when absent and pins the captured HEAD. Restore recreates only an absent branch at the captured OID and never force-resets a differently advanced branch. Ref deletion is compare-and-swap, limited to the owned OID. Every removal retains the local branch.
- Restore revalidates repository identity, payload hashes, hidden-ref ownership, branch/worktree occupancy, and snapshot version, then restores byte-for-byte and mode-for-mode. Only after the registry + owner-session commit is journaled may the payload be removed and the hidden ref CAS-deleted.

### One lifecycle entry

- Management delete, session deletion ("Delete session and worktree"), archive/retention sweeps, and reconciliation all call `WorktreeLifecycleService`. The V1 prune/remove implementation became an internal low-level operation (`removeCheckoutFiles`) with a required preserve-branch mode; V2 never calls branch-pruning V1 removal and never treats a missing path as successful deletion.
- Before capture the transaction acquires the cross-process registry lock (exclusive registry transaction), the host lifecycle lock, the common-directory lock, and every owner/path fence; quiesces every owning runtime; and records a durable journal entry. Failure to obtain any boundary leaves the checkout unchanged.
- Manual deletion binds the complete owner/path/Git/content/policy state into a preview fingerprint and revalidates it immediately before capture and again immediately before source release.
- States: `ready`, `snapshotting`, `snapshotted`, `restoring`, `cleanup-failed`, `restore-failed`, `missing`, `unowned` (plus Phase 1 `preparing`/`removing`/`blocked`). Owners stay attached through `snapshotted`; permanent deletion requires zero owner sessions. Plain session deletion removes one owner; final-owner deletion leaves an `unowned` record and enqueues cleanup.
- A durable append-only journal records intent, idempotent steps, and a commit marker. Startup reconciliation classifies interrupted transactions from journal/registry/ref/path evidence, resumes only idempotent safe work, and marks lifecycle readiness before lifecycle RPCs, Send, agent creation, or Git access for affected sessions.

### Automatic cleanup

- Policy is per server: `autoDeleteEnabled` (default true) and `retentionLimit` (default 15, accepted 1–1000). Cleanup is event-driven after awaited startup reconciliation, successful materialization/restore, policy change, final-owner archive, and final-owner deletion — no background daemon, no age/disk policy.
- Archive cleanup requires every owner archived with none active, flagged, or unquiesceable. Retention cleanup may select idle unarchived records, ordered by `lastUsedAt` (created at creation/restore/owner-attach/unarchive/accepted message), then creation time, then opaque ID. Each candidate is tried at most once per sweep; candidate-specific blocks are skipped and failures persisted. Disabling auto-delete fences new candidates at the policy-version boundary; an in-flight source release completes its journaled transaction.
- The materialized-worktree limit excludes snapshots; snapshot payloads are removed after verified restore or by explicit permanent deletion with a second irreversibility confirmation.

## Consequences

- Removal can no longer lose supported work: every released checkout has a verified restorable payload, and interrupted transactions are classified or resumed at startup.
- Lifecycle operations hold the registry lock across capture, so concurrent owner binds serialize against removal rather than racing it; long captures briefly block registry writers.
- External (non-Kata) writers remain a detected-but-not-serialized residual race: the final post-quiescence fingerprint is recomputed immediately before source release and a changed fingerprint refuses release.
- Snapshot payloads are server-local, owner-only, and never cross into renderers; the inventory exposes metadata and sanitized failure text only.
- Repository reconstruction, cloud/cross-host restore, branch deletion, external-worktree adoption, snapshot disk quotas, and background age/disk policies are out of scope by decision.

## Links

- Spec: [#41](https://github.com/gannonh/kata-agents/issues/41) (Worktree V2 Phase 2)
- Parent epic: [#17](https://github.com/gannonh/kata-agents/issues/17)
- Phase 1: [#40](https://github.com/gannonh/kata-agents/issues/40), [server-owned managed worktrees ADR](2026-07-29-server-owned-managed-worktrees.md)
- Later phases: [#42](https://github.com/gannonh/kata-agents/issues/42) (handoff), [#43](https://github.com/gannonh/kata-agents/issues/43) (isolated forks)
