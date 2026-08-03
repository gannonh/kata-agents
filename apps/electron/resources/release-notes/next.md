# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

- **Share managed worktrees across sessions** — The workspace checkout control now offers **Existing worktree** for a new empty session: any ready managed worktree of the current workspace + repository can be selected, and the session binds to it as a shared owner without recreating or mutating the checkout. Shared worktrees keep the existing ownership model — accurate owner counts, the Shared worktree label, and deletion guards that keep the checkout while any other session owns it ([#33](https://github.com/gannonh/kata-agents/issues/33)).
## Improvements

## Bug Fixes

- **Git branch badge refresh** — Workspace badges now rediscover the live branch when switching sessions that share a working directory, instead of retaining the previously selected session's branch ([#32](https://github.com/gannonh/kata-agents/pull/32), commit [ddd37f03](https://github.com/gannonh/kata-agents/commit/ddd37f03b6292595c5409cae91b2249d88cd8337)).

## Breaking Changes
