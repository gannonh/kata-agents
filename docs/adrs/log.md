# ADR Update Log

## 2026-08-08

* **Isolated conversation forks ADR hardened**: [2026-08-08-isolated-conversation-forks.md](2026-08-08-isolated-conversation-forks.md) records PR #50 review invariants for restart fence rehydration, authoritative journal-attempt lookup, source backend identity inheritance, missing-anchor blocking, complete execution proofs, and pre-persist first-Send serialization.

* **Isolated conversation forks ADR accepted**: [2026-08-08-isolated-conversation-forks.md](2026-08-08-isolated-conversation-forks.md) records the server-owned fork engine for Worktree V2 Phase 4 ([#43](https://github.com/gannonh/kata-agents/issues/43)): shared stays the default while isolated is offered only for current-head idle sources with a strict cross-CWD native fork adapter, fingerprint-bound previews with typed blockers and no fallback, the journaled fork transaction (PENDING preview cancel, compensation with CAS proof, recovery-required classification, startup reconciliation), the durable pending provider-fork intent with no child provider ID claim before first Send, idempotency-keyed first-Send establishment with exactly-once provider/message creation and the orphan ledger, checkout-strategy provenance for cleanup, and the `KATA_FORK_DETERMINISTIC_ADAPTER=1` seam for credential-free coverage while production adapters stay disabled until credentialed UAT.

## 2026-08-07

* **Conflict-safe handoff ADR accepted**: [2026-08-07-conflict-safe-checkout-handoff.md](2026-08-07-conflict-safe-checkout-handoff.md) records the server-owned handoff engine for Worktree V2 Phase 3 ([#42](https://github.com/gannonh/kata-agents/issues/42)): fingerprint-bound previews with typed blockers, journal-first durability with idempotent steps, direction-specific snapshot-backed rollback, managed-to-current release retaining the `snapshotted` record as the hand-back target, immutable transcript vs. execution-CWD separation, the provider capability gate with production adapters disabled until credentialed UAT, the session runtime reconstruction proof gate, and the deterministic adapter for credential-free state-machine coverage.

## 2026-08-05

* **Worktree lifecycle presentation simplified**: the accepted Phase 2 decision now defaults automatic cleanup off and keeps snapshot/recovery records server-side while the settings inventory exposes only active checkouts with a single Delete action.

* **Snapshot-backed lifecycle ADR accepted**: [2026-08-05-snapshot-backed-worktree-lifecycle.md](2026-08-05-snapshot-backed-worktree-lifecycle.md) records the single lifecycle entry for every destructive V2 path, verified snapshot-before-release, CAS-owned hidden refs, path leases and runtime quiescence, the durable journal with awaited startup classification, event-driven LRU retention, and the second-confirmation permanent snapshot deletion.
* **Verify-phase findings appended**: [2026-08-05-snapshot-backed-worktree-lifecycle.md](2026-08-05-snapshot-backed-worktree-lifecycle.md) gains the Verify-phase findings from offline UAT (136 checks): dynamic active/flagged protections are enforced inside the removal transaction, retry of partially released checkouts is governed by the verified snapshot, and the renderer surfaces the persisted lifecycle `recoveryState` with translated inventory refresh labels (all seven locales).
## 2026-08-04

* **ADR extended for Worktree V2 Phase 1**: [2026-07-29-server-owned-managed-worktrees.md](2026-07-29-server-owned-managed-worktrees.md) records exact named branch identity, default-false capability gating, server-owned canonical roots, fixed-registry authority, immutable creation snapshots, and compare-and-swap compensation.

## 2026-07-31

* **ADR implemented quiescence guarantee**: [2026-07-29-server-owned-managed-worktrees.md](2026-07-29-server-owned-managed-worktrees.md) now records the required `quiesceForTeardown(reason)` contract, Claude query completion boundary, strict Pi child exit, SessionManager's bounded await, and the plain-deletion fallback when teardown cannot be confirmed.

## 2026-07-29

* **ADR hardened (complete destructive inventory and transaction finalization)**: [2026-07-29-server-owned-managed-worktrees.md](2026-07-29-server-owned-managed-worktrees.md) — ignored files now contribute to the removal count and exact fingerprint, static identity validation precedes the final awaited checkout snapshot, and synchronous browser/agent/pool cleanup failures cannot interrupt session-storage finalization after checkout removal.

* **ADR hardened (stale destructive confirmation)**: [2026-07-29-server-owned-managed-worktrees.md](2026-07-29-server-owned-managed-worktrees.md) — `forceWorktreeRemoval` now carries a server-issued fingerprint of the exact checkout identity, HEAD OID, index entries, file modes, working-tree contents, and unique commit identities inspected for the dialog. Session storage is staged by atomic rename, then strict inspection, final ownership comparison, and removal complete under the repository mutation lock while the runtime session still exists; a block restores the session directory and refreshes the dialog without losing the session.

* **ADR revised (reclamation)**: [2026-07-29-server-owned-managed-worktrees.md](2026-07-29-server-owned-managed-worktrees.md) — an unowned worktree is recoverable *because* startup reconciliation reclaims it, not by assumption. Reconciliation removes unowned checkouts that are clean (reusing `removeWorktree`'s guards, never forcing) and retains unowned checkouts holding work, marking them `blocked`, including crash residue and older registry state ([#22](https://github.com/gannonh/kata-agents/issues/22)).

* **ADR extended**: [2026-07-29-server-owned-managed-worktrees.md](2026-07-29-server-owned-managed-worktrees.md) — recorded three decisions that came out of the PR #20 review: session deletion and managed-worktree removal are one ordered server operation (quiesce → authoritative locked removal → delete, with a blocked removal changing nothing); a bound checkout owns the session's working directory and `updateWorkingDirectory` rejects changes for it; and the Changes surface is a single HEAD→working-tree view that status entries must agree with, with an unborn branch treated as "unknown" rather than "no delta".

* **ADR accepted**: [2026-07-29-server-owned-managed-worktrees.md](2026-07-29-server-owned-managed-worktrees.md) — server-owned managed Git worktrees for Git/GitHub V1 (Phase 1 build).

## 2026-06-22

* **ADR accepted**: [2026-06-22-kata-identity-hard-cutover.md](2026-06-22-kata-identity-hard-cutover.md) — hard-cutover Kata identity contract.

## 2026-06-19

* **Initialization**: Created ADR section. No decisions recorded yet.
