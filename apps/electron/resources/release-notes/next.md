# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

## Improvements

- **CLI rename** — The terminal client package is now `@kata-sh/agents-cli` with binary `kata-agents-cli`. Bundled docs and reference guides were updated to match.

## Bug Fixes

## Breaking Changes

- **Terminal client binary renamed to `kata-agents-cli`** — Update scripts, PATH links, and CI invocations to use the new binary name.
- **Phantom workspace-commands CLI references removed** — Documentation and guardrails no longer reference a separate `kata-agent` commands binary. Config-domain access is via `kata-agents-cli invoke <channel>` or the desktop UI. A first-class commands CLI remains deferred ([#4](https://github.com/gannonh/kata-agents/issues/4)).
