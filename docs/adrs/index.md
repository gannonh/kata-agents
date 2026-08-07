# Architecture Decision Records

Durable architecture decisions for this fork are recorded here. See the Accepted list below; add new ADRs for any durable architecture decisions made during development.

## Proposed

*(none)*

## Accepted

* [2026-06-22-kata-identity-hard-cutover.md](2026-06-22-kata-identity-hard-cutover.md) — Canonical Kata identity graph (`@kata-sh/*`, `KATA_*`, `~/.kata-agents`, `kataagents://`, `sh.kata.agents`, `agents.kata.sh`) with zero Craft-era compatibility shims.
* [2026-07-29-server-owned-managed-worktrees.md](2026-07-29-server-owned-managed-worktrees.md) — The workspace-owning server owns all managed-worktree lifecycle and Git mutation; worktrees live under Kata config data, mutations serialize by Git common directory, and checkout preparation is an atomic empty-session gate.
* [2026-08-05-snapshot-backed-worktree-lifecycle.md](2026-08-05-snapshot-backed-worktree-lifecycle.md) — Every destructive V2 path routes through one lifecycle service with verified snapshots, path leases, a durable journal, and event-driven retention cleanup.
* [2026-08-07-conflict-safe-checkout-handoff.md](2026-08-07-conflict-safe-checkout-handoff.md) — The server moves a single-owner idle session between current and managed checkouts with fingerprint-bound previews, journaled idempotent steps, snapshot-backed rollback, and provider-proven execution-CWD rebinding.

## Superseded

*(none)*
