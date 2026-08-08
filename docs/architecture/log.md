# Architecture Update Log

## 2026-08-08

* **Update**: [2026-08-08-isolated-conversation-forks.md](../adrs/2026-08-08-isolated-conversation-forks.md) — PR #50 review hardening records restart fence rehydration, strict execution-proof validation, source backend identity inheritance, and pre-persist first-Send concurrency fencing.

* **Update**: [system-overview.md](system-overview.md) — added the Phase 4 isolated conversation-fork bullet to the "Git & GitHub worktrees (preview)" section: server-owned eligibility previews with typed blockers, the journaled fork transaction with compensation, the durable pending provider-fork intent (no child provider ID claim before first Send), idempotency-keyed first-Send establishment, and checkout-strategy provenance for cleanup.

## 2026-07-29

* **Update**: [system-overview.md](system-overview.md) — added the "Git & GitHub worktrees (preview)" section documenting server-owned Git behavior, managed-worktree storage/lifecycle, remote-eligible RPCs and identity revalidation, and the `KATA_FEATURE_GIT_WORKSPACE_V1` flag (Phase 4 of the git-github-worktrees-v1 spec).

## 2026-06-19

* **Creation**: [system-overview.md](system-overview.md) — initial architecture note derived from README.
