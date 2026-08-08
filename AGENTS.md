# Agent Instructions — Kata Agents

## Specs live in GitHub Issues

Specs for this repository are GitHub Issues, not files. `docs/specs/` holds only an index pointer and an archive of pre-migration specs.

- Read the roadmap with `gh issue list --label kind:spec --state open`.
- Read a spec with `gh issue view <N>`; read an epic's phases with `gh sub-issue list <N>`.
- Do not create spec files under `docs/specs/`. Use the `plan-build-verify-github` skill, which publishes specs as issues.
- Never build an issue that is not labeled `status:approved` without explicit maintainer approval.
- Post build reports and acceptance evidence as comments on the spec issue.
- ADRs remain files under `docs/adrs/`. Cross-link them with the issues they constrain.

## Open Knowledge Format docs

This repository maintains an OKF v0.1 bundle at `./docs`.

- Read `./docs/index.md` before substantial work to understand the documentation map.
- Follow cross-links into relevant specs, ADRs, architecture notes, and reference docs before changing related code.
- Keep `./docs/specs/index.md` current as the roadmap pointer for GitHub Issues and the pre-migration archive.
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
- Local E2E (real Electron, macOS-only): `bun run e2e` — see [`e2e/README.md`](e2e/README.md). Authoring guide: [`.agents/skills/e2e-test-author/SKILL.md`](.agents/skills/e2e-test-author/SKILL.md).

## Monorepo conventions

- Runtime: Bun. Type check: `bun run typecheck:all` (currently broken on base SHA due to missing root `tsconfig.base.json`; use per-package `tsc --noEmit` as a workaround).
- i18n: all user-facing strings go through `t()` / `i18n.t()`. Keys must exist in all 7 locale files (`en`, `de`, `es`, `hu`, `ja`, `pl`, `zh-Hans`), alphabetically sorted. Run `bun run lint:i18n:parity` and `bun run lint:i18n:sorted` to verify; `lint:i18n:coverage` is currently unavailable on base SHA due to missing `scripts/check-i18n-coverage.ts`.
- Credentials: keep all secret handling in `packages/shared/src/credentials/`. No ad-hoc storage elsewhere.
- Permission modes are fixed: `safe`, `ask`, `allow-all`. Source types are fixed: `mcp`, `api`, `local`.
- Release notes: append bullets to `apps/electron/resources/release-notes/next.md` for user-visible changes. Never pre-create `{version}.md` files in feature commits.
- Commits: Conventional Commits (`feat(scope): summary`). Commit after every logical unit of work.
- Deferred work: any work deferred during planning, implementation, verification, or testing must be filed as a GitHub issue immediately using the `.github/ISSUE_TEMPLATE/deferred_work.yml` template. Do not leave deferrals only in code comments, chat, or memory.

## Credentials and E2E provider UAT

**This environment is credentialed by default.** Provider-requiring E2E tests run here — never assume "no credentials", never defer UAT to a later issue, and never wire a fake provider seam without asking the user first.

- **Primary credential: codex OAuth.** The app is already authenticated against the codex harness (credentials in `dotfiles/pi/.pi/agent/auth.json`); the `chatgpt-plus` connection is reused without entering a key.
- **Fallback chain: root `.env`.** `KATA_E2E_AGENT_PROVIDER[_NN]` + `KATA_E2E_AGENT_MODEL[_NN]` select the provider; the matching `KATA_*_API_KEY` supplies the key (`openai-codex` → `KATA_OPENAI_API_KEY`, `opencode-go` → `KATA_OPENCODE_GO_API_KEY`, `openrouter` → `KATA_OPENROUTER_API_KEY`, `deepseek` → `KATA_DEEPSEEK_API_KEY`, `anthropic` → `KATA_ANTHROPIC_API_KEY` — avoid, expensive).
- The agent E2E specs (`@agent`, `@worktree-v2 fork`, `@worktree-v2 handoff`) walk the whole chain via `runWithAgentProviderFallback` (`e2e/src/flows/agentChat.ts`) and only fail after every option is exhausted, with each attempt logged and the aggregated failure naming every option.
- Before deferring any UAT tier or claiming credentials are unavailable: check the chain above and **ask the user**. Deterministic adapters (`@kata-sh/shared/agent/testing`) are test doubles only — never import them from production code, and never add `KATA_*_DETERMINISTIC_ADAPTER`-style env seams to production paths.

## Active context

- **Complete Kata brand transition** is complete. Canonical identity: `@kata-sh/*` packages, `KATA_*` env vars, `~/.kata-agents`, `kataagents://`, `sh.kata.agents`, and `agents.kata.sh`. See `./docs/specs/archive/2026-06-22-complete-kata-brand-transition-design.md` and the verify report `./docs/specs/archive/2026-06-23-complete-kata-brand-transition-verify-report.md`. Verify passed 2026-06-23 (all 12 ACs); fixes included a broken `kata-agent.svg` tool icon, Craft-named `kata-logos` assets, dead `CraftAppIcon` code, a `copy-assets.ts` stale-file hygiene fix, and GitHub org ref reconciliation.
- **Rebrand Phase 1** (user-facing copy only) is complete. See `./docs/specs/archive/rebrand-kata-agents-phase-1.md`.
