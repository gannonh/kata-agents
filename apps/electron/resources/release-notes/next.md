# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

- **Share managed worktrees across sessions** — The workspace checkout control now offers **Existing worktree** for a new empty session: any ready managed worktree of the current workspace + repository can be selected, and the session binds to it as a shared owner without recreating or mutating the checkout. Every session bound to a worktree shows the same branch label; shared ownership shows as a Users icon and tooltip, and the existing deletion guards keep the checkout while any other session owns it ([#33](https://github.com/gannonh/kata-agents/issues/33), commit [ac0dd3b4](https://github.com/gannonh/kata-agents/commit/ac0dd3b4a41d81bef3c8c20353bc8b4cc2b3a4b1)).
- **Simplified managed worktree settings** — Worktrees settings now uses a compact delete-only list for active checkouts, labels the location **Worktree root**, and defaults **Automatically delete old worktrees** to off. The configurable **Auto-delete limit** still uses snapshot-first pruning so older worktrees remain recoverable on the owning server ([#41](https://github.com/gannonh/kata-agents/issues/41)).
- **Named managed worktrees and server-owned roots** — With Worktree V2 enabled, new worktrees accept a human-readable name that is normalized to lowercase kebab-case for the exact branch suffix and display name, while the Worktrees settings page configures a server-local materialization root without moving existing checkouts ([#40](https://github.com/gannonh/kata-agents/issues/40)).
## Improvements

## Bug Fixes

- **Worktree V2 recovery and protection accuracy** — Sessions bound to a removed worktree now show the exact lifecycle recovery state (Snapshotted, Restoring, …) with the worktree name instead of a generic “missing” badge; manual deletion is rejected server-side while any owner is active or flagged; retries of failed removals are governed by the verified snapshot when the checkout is no longer inspectable; the inventory refresh control renders a translated label ([#41](https://github.com/gannonh/kata-agents/issues/41)).

- **Git branch badge refresh** — Workspace badges now rediscover the live branch when switching sessions that share a working directory, instead of retaining the previously selected session's branch ([#32](https://github.com/gannonh/kata-agents/pull/32), commit [ddd37f03](https://github.com/gannonh/kata-agents/commit/ddd37f03b6292595c5409cae91b2249d88cd8337)).

## Breaking Changes
