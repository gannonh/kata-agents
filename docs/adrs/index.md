# Architecture Decision Records

Durable architecture decisions for this fork are recorded here. See the Accepted list below; add new ADRs for any durable architecture decisions made during development.

## Proposed

*(none)*

## Accepted

* [2026-06-22-kata-identity-hard-cutover.md](2026-06-22-kata-identity-hard-cutover.md) — Canonical Kata identity graph (`@kata-sh/*`, `KATA_*`, `~/.kata-agents`, `kataagents://`, `sh.kata.agents`, `agents.kata.sh`) with zero Craft-era compatibility shims.
* [2026-07-29-server-owned-managed-worktrees.md](2026-07-29-server-owned-managed-worktrees.md) — The workspace-owning server owns all managed-worktree lifecycle and Git mutation; worktrees live under Kata config data, mutations serialize by Git common directory, and checkout preparation is an atomic empty-session gate.

## Superseded

*(none)*
