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
| `@craft-agent/shared` (business logic) | `packages/shared/CLAUDE.md` |
| `@craft-agent/core` (shared types) | `packages/core/CLAUDE.md` |
| Electron bundled resources | `apps/electron/resources/AGENTS.md` |

## Monorepo conventions

- Runtime: Bun. Type check: `bun run typecheck:all`.
- i18n: all user-facing strings go through `t()` / `i18n.t()`. Keys must exist in all 7 locale files (`en`, `de`, `es`, `hu`, `ja`, `pl`, `zh-Hans`), alphabetically sorted. Run `bun run validate:ci` to check parity, sort order, and coverage.
- Credentials: keep all secret handling in `packages/shared/src/credentials/`. No ad-hoc storage elsewhere.
- Permission modes are fixed: `safe`, `ask`, `allow-all`. Source types are fixed: `mcp`, `api`, `local`.
- Release notes: append bullets to `apps/electron/resources/release-notes/next.md` for user-visible changes. Never pre-create `{version}.md` files in feature commits.
- Commits: Conventional Commits (`feat(scope): summary`). Commit after every logical unit of work.

## Active context

- **Rebrand Phase 1** is in progress: renaming all user-facing "Craft Agents" surfaces to "Kata Agents". See `./docs/specs/rebrand-kata-agents-phase-1.md` for the full scope, decisions, and change set. Identity infrastructure (`appId`, `craftagents://`, `~/.craft-agent`, `@craft-agent/*`, `CRAFT_*` env vars, `agents.craft.do`) is intentionally unchanged in Phase 1.
