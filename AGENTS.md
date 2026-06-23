# Agent Instructions — Kata Agents

## Open Knowledge Format docs

This repository maintains an OKF v0.1 bundle at `./docs`.

- Read `./docs/index.md` before substantial work to understand the documentation map.
- Follow cross-links into relevant specs, ADRs, architecture notes, and reference docs before changing related code.
- Keep `./docs/specs/index.md` current as the roadmap for active, planned, and completed work.
- Add or update ADRs in `./docs/adrs/` for durable architecture decisions.
- After substantial work, PRs, behavior changes, architecture decisions, or documentation moves, update the OKF bundle and add entries to the relevant `log.md` files.
- Every non-reserved Markdown file under `./docs` must have OKF frontmatter with at least a non-empty `type` field. `index.md` and `log.md` are reserved navigation/history files.

## Package-level context

Each package has its own agent context file — read it before modifying that package:

| Package | Context file |
|---------|-------------|
| `@kata-sh/shared` (business logic) | `packages/shared/CLAUDE.md` |
| `@kata-sh/core` (shared types) | `packages/core/CLAUDE.md` |
| Electron bundled resources | `apps/electron/resources/AGENTS.md` |

## Common commands

- Run the desktop app: `bun run electron:start`
- Dev mode with hot reload: `bun run electron:dev`
- Type-check a package: `cd packages/shared && bun run tsc --noEmit` or `cd apps/electron && bun run typecheck`
- Run tests: `bun test`
- Shared package tests: `cd packages/shared && bun test`

## Monorepo conventions

- Runtime: Bun. Type check: `bun run typecheck:all` (currently broken on base SHA due to missing root `tsconfig.base.json`; use per-package `tsc --noEmit` as a workaround).
- i18n: all user-facing strings go through `t()` / `i18n.t()`. Keys must exist in all 7 locale files (`en`, `de`, `es`, `hu`, `ja`, `pl`, `zh-Hans`), alphabetically sorted. Run `bun run lint:i18n:parity` and `bun run lint:i18n:sorted` to verify; `lint:i18n:coverage` is currently unavailable on base SHA due to missing `scripts/check-i18n-coverage.ts`.
- Credentials: keep all secret handling in `packages/shared/src/credentials/`. No ad-hoc storage elsewhere.
- Permission modes are fixed: `safe`, `ask`, `allow-all`. Source types are fixed: `mcp`, `api`, `local`.
- Release notes: append bullets to `apps/electron/resources/release-notes/next.md` for user-visible changes. Never pre-create `{version}.md` files in feature commits.
- Commits: Conventional Commits (`feat(scope): summary`). Commit after every logical unit of work.

## Active context

- **Complete Kata brand transition** is in progress on this branch. Canonical identity: `@kata-sh/*` packages, `KATA_*` env vars, `~/.kata-agents`, `kataagents://`, `sh.kata.agents`, and `agents.kata.sh`. See `./docs/specs/2026-06-22-complete-kata-brand-transition-design.md`. Quality review found and fixed migration residuals from boundary-blind substring replacement (broken server dist scopeDir, 2 failing tests, quoted-form pluralization of CLI binary name); full `packages/shared` test suite passes. Verify (packaged build UAT) still pending.
- **Rebrand Phase 1** (user-facing copy only) is complete. See `./docs/specs/rebrand-kata-agents-phase-1.md`.
