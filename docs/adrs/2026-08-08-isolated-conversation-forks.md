---
type: ADR
title: Isolated conversation forks
description: The workspace-owning server forks an idle source conversation's current head into a separately named managed worktree, Git branch, Kata session, and execution runtime with a durable pending provider-fork intent, strict cross-CWD native-fork establishment on first Send, and journaled fork transactions with compensation and an orphan ledger
tags: [git, worktrees, forks, sessions, snapshots, provider, architecture]
timestamp: 2026-08-08T00:00:00Z
---

# ADR: Isolated conversation forks

## Status

Accepted

## Context

Worktree V2 Phases 1–3 ([#40](https://github.com/gannonh/kata-agents/issues/40), [server-owned managed worktrees ADR](2026-07-29-server-owned-managed-worktrees.md); [#41](https://github.com/gannonh/kata-agents/issues/41), [snapshot-backed worktree lifecycle ADR](2026-08-05-snapshot-backed-worktree-lifecycle.md); [#42](https://github.com/gannonh/kata-agents/issues/42), [conflict-safe checkout handoff ADR](2026-08-07-conflict-safe-checkout-handoff.md)) give a session an isolated managed checkout with verified snapshots, lifecycle ownership, path leases, and provider CWD capability contracts. V1 conversation branching preserves provider-native context by adding another session owner to the **same** managed worktree ([#33](https://github.com/gannonh/kata-agents/issues/33)); that shared checkout is useful for alternate conversation paths that edit one working tree, but it cannot provide filesystem or branch isolation.

Phase 4 ([#43](https://github.com/gannonh/kata-agents/issues/43)) must let a user fork the **current head** of a provider-native conversation into a separately named managed worktree, Git branch, Kata session, and execution runtime while leaving the source conversation and checkout unchanged. Two properties make a naive fork unsafe:

- **The provider creates native forks on first Send.** Current Claude branching establishes the native fork on the child's first Send from the parent's SDK session, so a fork cannot claim a child provider ID at session creation. The design must persist a pending fork intent and prove destination execution instead.
- **A provider child ID must be created exactly once.** A retried first Send must reuse the persisted idempotency key and never duplicate the provider child or the user message, and a provider artifact created without a persisted link must never be silently attached.

The server owns all Git mutations and all checkout paths, so forking must stay server-side: clients submit a session ID, a strategy, and (for isolated) an editable worktree name suffix — never paths or patches.

## Decision

**`IsolatedConversationForkService` (server-core) is the single owner of fork eligibility previews, seed capture, confirmation, recovery, and cancellation, and every enabled provider adapter must establish a strict cross-CWD native fork with an idempotency key before the child's first Send unlocks.**

### Shared default, isolated when eligible

- The Branch action offers two strategies. **Shared worktree** remains the default and preserves #33 behavior byte-for-byte (its confirmation reuses the existing branch flow; the server throws a typed `FORK_NOT_IMPLEMENTED` for shared confirmation).
- **New isolated worktree** is offered only when Worktree V2 is effective, the branch point is the current conversation head, the source session is idle at a supported Git state, and the provider adapter advertises **and** structurally implements the strict cross-CWD native fork (`resolveIsolatedForkCapability` gate). Unsupported providers and non-head source turns receive a typed blocker (`unsupported-provider`, `non-head-source`) with **no fallback** to shared/full-history/fresh behavior.

### Fingerprint-bound previews and typed blockers

- A preview is side-effect free beyond registering an in-memory transaction and a durable PENDING journal entry. It binds every decision-relevant fact — source conversation head and turn, session/checkout/branch/HEAD, Git-state summary, all path owners and leases, destination server/root/branch, provider capability, and ignored-file policy — into a `previewFingerprint`.
- Confirmation revalidates the fingerprint under the common-directory mutation lock + registry lock; any drift returns a typed `identity-drift` blocker and claims no mutation. Typed blockers cover `flags-disabled`, `unsupported-provider`, `fork-in-progress`, `cleanup-in-progress`, `missing-source`, `non-head-source`, `source-active`, `path-unleased`, `git-operation-in-progress`, `unsupported-snapshot`, `oversized-capture`, `invalid-name`, `name-collision`, and `identity-drift`.

### Journaled fork transaction with compensation and an orphan ledger

- A durable append-only journal records the transaction before any mutation and every idempotent step (locks-acquired, source-quiesced, target-reserved, seed-captured, destination-leased, target-materialized, target-restored, target-verified, child-created, binding-committed). Metadata carries the source HEAD OID, seed snapshot id, reserved name/path/branch, managed worktree id, and child session id. A pure PENDING preview can be cancelled (recovered `preview-cancelled`); any journaled confirm step makes the transaction non-resumable-failed on error and recovery-required on child-created-without-commit, so a restarted server classifies interrupted forks from journal evidence — never from a missing-path heuristic — and reconciles a lost `established` marker from the durable child session record.
- Pre-publication failures compensate **only transaction-owned artifacts** with CAS proof (a removed target/branch only while it still points at the captured OID, the captured seed, and an unpublished child session); the source is never edited. Failed transactions are never resumable on any path.
- After publication, a provider-fork failure does not delete the child or target: the child stays pending with exactly one persisted user message and a retryable typed error. A provider artifact created without a persisted link is recorded in a durable **fork orphan ledger** and never silently attached.

### Pending provider-fork intent (no child provider ID claim before first Send)

- The child session stores a durable `pendingFork` intent containing the strict parent conversation/turn identity, the immutable transcript lookup CWD, the destination execution CWD, the reserved idempotency key, and the target checkout binding. Before first Send the session DTO reports `forkPending` and the UI displays provider identity as **Pending** — no child provider ID is claimed.
- First Send runs `SessionManager.establishPendingFork`: it creates the child agent, resolves the strict fork adapter, and calls `establishNativeFork` with the **persisted** idempotency key and parent identity. Success persists the child provider ID exactly once, retires the pending metadata (checkout `checkoutStrategy` stays `'isolated'` as provenance), and records the establishment in the fork journal (metadata-only on the committed entry; the child session record is authoritative if the marker is lost). Missing/malformed anchors, absent adapters, throwing establishes, and malformed results are typed retryable errors — no fallback, no duplicate message, no duplicate provider child, and no execution in the source. Concurrent first-sends on the same pending child are serialized before message persistence.
- Review hardening keeps isolated confirmation fail-closed: a missing parent session/turn anchor is a typed `missing-parent-anchor` blocker before child creation, and a first-Send proof must identify the selected adapter, resolve to the exact destination execution CWD, carry a fresh bounded verification timestamp, and cover file, shell, MCP, and provider execution before the provider ID is persisted. Unresolved in-progress or recovery-required journal entries are rehydrated into session/path fences after restart, and fork children inherit the source session's locked LLM connection/model identity.

### Checkout-strategy provenance for cleanup

- Session branch cleanup uses the durable `checkoutStrategy` provenance: shared-child deletion drops one owner of the shared record; isolated-child deletion uses only the child's own lifecycle and never mutates the source record. The source session, checkout, owners, registry, and runtime remain untouched by the fork.

### Client contract and credential-free coverage

- Local Electron and headless/remote clients share the same capability, preview, confirm, status, recover, and cancel RPC channels (`git:forkPreview`, `git:forkConfirm`, `git:forkStatus`, `git:forkRecover`, `git:forkCancel`), all remote-eligible. Clients submit only a session ID, strategy, transaction ID, preview fingerprint, and name suffix; server-derived previews label remote servers and expose no local reveal.
- Isolated actions render only when the server-derived session `isolatedForkCapable` flag is true; the server's typed blockers remain the authoritative backstop.
- Credential-free state-machine and UI-UAT coverage uses a deterministic strict fork adapter factory (`createDeterministicStrictForkAdapter`) with explicit failure injection and a stable child SDK session ID per adapter, wired through the `KATA_FORK_DETERMINISTIC_ADAPTER=1` seam (non-production only, mirroring the handoff seam). It exercises preview, confirm, pending identity, first-Send establishment, failure points, and the destination-execution proof gate without a live provider.

## Consequences

- A user can fork the current head of a provider-native conversation into a dedicated managed worktree, `kata-agent/<name>` branch, Kata session, and execution runtime while the source conversation, checkout, owners, and runtime stay byte-identical.
- The child is durable and independently lifecycle-managed from the moment it is visible; a crash between target materialization and the commit marker resolves to either a committed child or explicit recovery-required — never a silent source edit or a fabricated child.
- The pending-fork intent makes first-Send establishment idempotent: retries reuse the persisted key, so the provider child and the user message are each created exactly once, and unlinkable provider artifacts land in the orphan ledger.
- Historical conversation points, cross-repository forks, merge/PR from a fork, arbitrary ignored copying, provider emulation, and non-Git checkout isolation remain out of scope by decision; older turns keep the shared strategy only.
- Providers that cannot establish a strict cross-CWD native fork simply do not offer the isolated strategy (shared preserved); enabling a production adapter is a future, credentialed, per-provider decision gated by live dev and packaged UAT — not part of this Build phase.

## Links

- Spec: [#43](https://github.com/gannonh/kata-agents/issues/43) (Worktree V2 Phase 4)
- Parent epic: [#17](https://github.com/gannonh/kata-agents/issues/17)
- Phase 1: [#40](https://github.com/gannonh/kata-agents/issues/40), [server-owned managed worktrees ADR](2026-07-29-server-owned-managed-worktrees.md)
- Phase 2: [#41](https://github.com/gannonh/kata-agents/issues/41), [snapshot-backed worktree lifecycle ADR](2026-08-05-snapshot-backed-worktree-lifecycle.md)
- Phase 3: [#42](https://github.com/gannonh/kata-agents/issues/42), [conflict-safe checkout handoff ADR](2026-08-07-conflict-safe-checkout-handoff.md)
- Deferred credentialed UAT: [#47](https://github.com/gannonh/kata-agents/issues/47) model (handoff)
