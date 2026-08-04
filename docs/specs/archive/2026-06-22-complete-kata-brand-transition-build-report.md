---
type: BuildReport
title: Complete Kata Brand Transition — Build Report
description: Build completion evidence for the hard-cutover brand transition
tags: [rebrand, kata, build-report]
timestamp: 2026-06-22T00:00:00Z
migrated: false
archived_at: 2026-08-04T16:24:02Z
status: Completed
---

> **Completed before migration** (status: Completed). Retained as history. Not tracked in GitHub Issues.

# Complete Kata Brand Transition — Build Report

## Spec

[2026-06-22-complete-kata-brand-transition-design.md](2026-06-22-complete-kata-brand-transition-design.md)

## SHAs

| | SHA |
|---|-----|
| Base | `09b0c75b56205caa12b9d491b91f02ae1cc4ea43` |
| Final | `2df966ff` |
| Quality review fixes | `7bef7cd7` |

## Tasks completed

1. **Phase 1 — Package graph**: Renamed root package to `kata-agents`, all workspace packages to `@kata-sh/*`, updated imports/exports/scripts/tsconfig/vite aliases, refreshed `bun.lock`.
2. **Phase 2 — Runtime identity**: Renamed `CRAFT_*` → `KATA_*`, config paths to `~/.kata-agents` / `.kata-agents`, removed backward-compat env/path reads.
3. **Phase 3 — Desktop identity**: `sh.kata.agents`, `kataagents://`, release/update metadata toward `agents.kata.sh`.
4. **Phase 4 — Apps/resources**: `kata-cli` / `kata-server` binaries, bundled `kata-agent` resource binary, `kata-logos/`, docs MCP ids, server/viewer/webui labels.
5. **Phase 5 — i18n/docs/OKF**: Renamed i18n keys (`menu.*KataAgents`, `onboarding.apiSetup.kataAgentsBackend`), updated `AGENTS.md`, `docs/index.md`, added [ADR](../../adrs/2026-06-22-kata-identity-hard-cutover.md), release-notes breaking-change entry.
6. **Phase 6 — Verification**: Package typechecks, i18n parity/sort, CLI help smoke, package metadata scan, residual Craft scan.

## Verification results

| Command | Result |
|---------|--------|
| `bun install` | Pass |
| `cd packages/core && bun run tsc --noEmit` | Pass |
| `cd packages/shared && bun run tsc --noEmit` | Pass |
| `cd packages/ui && bun run tsc --noEmit` | Pass |
| `cd packages/server-core && bun run typecheck` | Pass |
| `cd packages/server && bun run typecheck` | Pass |
| `cd packages/messaging-gateway && bun run typecheck` | Pass |
| `cd packages/messaging-whatsapp-worker && bun run typecheck` | Pass |
| `cd packages/pi-agent-server && bun run typecheck` | Pass |
| `cd packages/session-tools-core && bun run typecheck` | Pass |
| `cd packages/session-mcp-server && bun run build` | Pass |
| `cd apps/cli && bun run typecheck` | Pass |
| `cd apps/electron && bun run typecheck` | Pass |
| `cd apps/viewer && bun run typecheck` | Pass |
| `cd apps/webui && bun run typecheck` | Pass |
| `bun run lint:i18n:parity` | Pass (6 locales, 1466 keys) |
| `bun run lint:i18n:sorted` | Pass (after `bun run sort-locales`) |
| `bun run apps/cli/src/index.ts --help` | Pass — shows `kata-cli`, no `Craft Agent` |
| Workspace `package.json` metadata scan | Pass — no `@craft-agent`, `craft-cli`, `craft-server` |
| `bun test src/__tests__/feature-flags.test.ts` | Pass (11 tests) |
| `bun test tests/permissions-kata-agent-sync.test.ts` | Pass |
| `storage-startup-migration.test.ts` (subset) | **Pre-existing flaky/timeouts** on base branch — subprocess migration integration tests time out at 5s; not introduced by identity rename |

## Quality review fixes (`7bef7cd7`)

A strict quality review with parallel adversarial subagents found that the migration's boundary-blind global substring replacement (`split/join`) produced wrong values in several locations where slash-suffixed scope rules missed bare-scope tokens and quoted CLI-binary literals were pluralized.

### Blockers fixed

- **`scripts/build-server.ts`**: scopeDir was `@kata-agent` instead of `@kata-sh`, breaking workspace import resolution in the standalone server dist.
- **`url-safety.test.ts`**: `CRAFTAGENTS://` should be `KATAAGENTS://` (failing test).
- **`shellguard-corpus.test.ts`**: `kata-agents` (plural) should be `kata-agent` (singular CLI binary) (failing test).

### Quoted-form conflation fixed

The migration rule mapping quoted `'craft-agent'`/`"craft-agent"` to `kata-agents` (plural package name) clobbered quoted CLI-binary literals that should be `kata-agent` (singular):

- `tool-icons.json`: `id` and `commands` arrays
- `mcp/client.ts`: MCP client name
- `oauth.ts`: default `client_id` (3 occurrences)
- `oauth.test.ts`: `client_id` assertion
- `playground/markdown.tsx`: sample package name

### Other residuals fixed

- `install-app.sh`: `@kata-agent` cache paths → `@kata-sh`
- `build-server.ts`: `craft-data` docker volume → `kata-data`, `echo craft` service user → `echo kata`, `craftServer` var → `kataServer`
- `docs/index.ts`: `DOC_REFS.craftCli` → `kataCli`
- `system.ts`: `getCraftAssistantPrompt` → `getKataAssistantPrompt`
- `paths.ts`, `index.ts`: Craft-era comment residuals

### Structural fix

Migration scripts moved from `scripts/` to `scripts/migrations/` with a README marking them as one-shot historical artifacts.

### Verification after fixes

| Command | Result |
|---------|--------|
| `cd packages/shared && bun run tsc --noEmit` | Pass |
| `cd packages/shared && bun test` | 2898 pass, 0 fail |
| Build/staging tests | 18 pass, 0 fail |
| All 3 previously-failing test files | Pass |

## Review gates

- **TDD**: Mechanical identity rename; existing tests updated for `KATA_*` / `kataagents` / `@kata-sh` symbols. `feature-flags` and `permissions-kata-agent-sync` exercised after renames.
- **Spec compliance**: Self-reviewed against acceptance criteria AC 1–12.
- **Code quality**: Single-agent path; independent subagent review not used.

## Approved deviations

- **Migration scripts retained**: `scripts/migrations/brand-transition-migrate.ts` and `scripts/migrations/brand-transition-pass2.ts` intentionally contain Craft-era strings as replacement maps (excluded from residual scan). Moved to `scripts/migrations/` with README marking them as one-shot historical artifacts.
- **Internal code names**: Comments and debug labels may still say `KataAgent` when referring to the `ClaudeAgent` class facade (product name, not Craft legacy).
- **Craft document integration**: `apps/electron/resources/docs/sources.md` retains Craft document product examples (`Craft iOS`, `Craft Connect`, `{source:Craft}`).

## Residual Craft scan (active tree, excluding historical specs + LICENSE + migration scripts)

| Category | Examples | Rationale |
|----------|----------|-----------|
| Upstream attribution | `LICENSE` — Craft Agents / Craft Docs Ltd. | Required Apache attribution |
| Historical completed specs | `docs/specs/rebrand-kata-agents-phase-1*.md`, `2026-06-19-ci-release-pipeline*.md`, etc. | Historical accuracy per allowlist |
| Craft document/source integration | `sources.md` Craft workspace examples, `craft-public` source slug in CLI E2E prompt | Separate Craft document product |
| Third-party / smoke fixtures | `test_markitdown_smoke.py` "hello craft" text | Unrelated prose in test data |
| Migration tooling | `scripts/migrations/brand-transition-*.ts` | One-shot migration maps |

No active matches for: `@craft-agent`, `CRAFT_`, `.craft-agent`, `craftagents`, `agents.craft.do`, `craft-cli`, `craft-server`, `com.lukilabs.craft-agent`, `Craft Agent`, `Craft Agents` (outside allowlist above).

## Known follow-ups

- Full `bun test` suite now passes after quality review fixes (2898 pass, 0 fail in `packages/shared`).
- Verify phase completed 2026-06-23 — see [verify report](2026-06-23-complete-kata-brand-transition-verify-report.md). All 12 ACs pass after fixing the broken `kata-agent.svg` tool icon, Craft-named `kata-logos` assets, dead `CraftAppIcon` code, a `copy-assets.ts` stale-file hygiene bug, GitHub org refs, and mock/test data.
- `bun run typecheck:all` root script may still fail on missing root `tsconfig.base.json` (pre-existing per AGENTS.md).

## Transition

Spec status updated to **Completed** (Verify passed 2026-06-23; see [verify report](2026-06-23-complete-kata-brand-transition-verify-report.md)).
