---
type: BuildReport
title: CLI Rename and Phantom Removal — Build Report
description: Build completion evidence for renaming apps/cli to kata-agents-cli and removing phantom kata-agent commands-CLI infrastructure
tags: [cli, rename, branding, build-report]
timestamp: 2026-06-24T00:00:00Z
---

# CLI Rename and Phantom Removal — Build Report

## Spec

[2026-06-24-cli-rename-and-phantom-removal-design.md](2026-06-24-cli-rename-and-phantom-removal-design.md)

## Summary

Renamed the WebSocket terminal client to `@kata-sh/agents-cli` / `kata-agents-cli`, removed the `kataAgentsCli` feature flag and all gated redirect/guardrail code, slimmed `cli-domains.ts` to path-scope metadata, rewrote bash allowlist patterns to `kata-agents-cli invoke <channel>`, updated bundled and reference docs, removed orphaned phantom env vars and wrapper scripts, and refreshed release workflow comments and pending release notes.

## Tasks completed

1. **Package + CLI source** — `apps/cli/package.json`, help/usage strings, example source slugs; `bun.lock` refreshed.
2. **Reference docs + README** — `docs/reference/cli.md`, `docs/reference/index.md`, `README.md`, migration script string updates.
3. **Bundled docs** — `kata-cli.md` → `kata-agents-cli.md`; domain docs updated; `packages/shared/src/docs/index.ts` path updated.
4. **Feature flag + redirects** — Removed from `feature-flags.ts`, `pre-tool-use.ts`, `permissions-config.ts`, `system.ts`.
5. **Permission policies** — Slim `cli-domains.ts`; `getAgentsCliReadOnlyInvokeBashPatterns()`; sync script + `default.json` regenerated.
6. **Tests** — Updated shellguard corpus, pre-tool-use checks, sync test; deleted flag-only test files.
7. **Orphaned env vars** — Removed from `apps/electron/src/main/index.ts`; deleted phantom `resources/bin/kata-agent*` wrappers.
8. **Closeout** — `release.yml` comment, `release-notes/next.md`, OKF log/index updates.

## Verification results

| Check | Result |
|-------|--------|
| `bun run apps/cli/src/index.ts --help` | Pass — shows `kata-agents-cli`, no `craft` strings |
| `cd apps/cli && bun run tsc --noEmit` | Pass |
| `cd packages/shared && bun test` (targeted) | Pass — permissions sync, shellguard Group 27, feature-flags, pre-tool-use-checks |
| `kata-cli` grep gate (`apps/ docs/reference README scripts .github`) | Pass (excludes historical `release-notes/0.10.7.md` per spec) |
| Feature-flag grep gate | Pass |
| Env-var grep gate | Pass |
| Phantom CLI-command grep gate (`packages/ apps/`) | Pass |

Full `packages/shared` suite: 8 pre-existing failures unrelated to this change (`config-defaults.json` missing in test env, system-prompt co-author tests). Targeted tests for all touched behavior pass.

## Deferred

- Full desktop UAT demo (AC 11) requires interactive Electron; not run in this cloud build environment.
- Building the `kata-agent` workspace-commands CLI — tracked in [#4](https://github.com/gannonh/kata-agents/issues/4).
