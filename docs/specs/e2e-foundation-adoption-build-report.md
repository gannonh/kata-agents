---
type: BuildReport
title: "Build report — Adopt the local Electron E2E foundation"
description: "Implementation, verification, deviations, and follow-ups for the Kata Agents local Playwright + real-Electron E2E foundation."
tags: [testing, e2e, electron, playwright, kata-agents, build-report]
timestamp: 2026-06-25T00:00:00Z
---

# Build report — Adopt the local Electron E2E foundation

## Source documents

- Plan/spec: [e2e-foundation-adoption-plan.md](e2e-foundation-adoption-plan.md) (status: Implemented)
- Decision record: [2026-06-24-e2e-testing-foundation-design.md](2026-06-24-e2e-testing-foundation-design.md)
- Adoption guide: [e2e-foundation-adoption.md](e2e-foundation-adoption.md)

## SHAs

- Base SHA: `84ceb0f033767d31f546b04e5dce5cfe061099d3`
- Head SHA (pre-report): `1f751bfea32e7d0e51d85ab2ef26fef3c0e6fb61`
- Branch: `feat/e2e-testing-foundation`

## Tasks completed

- **Pre-step**: committed an unrelated pre-existing `bun.lock` change separately (`d2d0ba0c`).
- **Spec fix**: added OKF frontmatter, `## Status`, and a formal `## Acceptance criteria` (13 criteria).
- **Phase 0**: OKF decision record; linked from `docs/specs/index.md`; `log.md` entry.
- **Phase 1**: `@playwright/test` devDep; root `e2e`/`e2e:headed`/`e2e:ui`/`e2e:release` scripts; `.gitignore`; `.env.example`; `e2e/src/config/{loadEnv,timeouts,tags}.ts`.
- **Phase 2**: harness — `ports`, `isolatedRun`, `devStack`, `desktopArtifacts`, `appLaunch`, `launchEnv`, `readiness`, `artifacts`, `processSpawn`, `log`, `env`, `testFixtures`.
- **Phase 3**: product id markers; flows `shell`/`onboarding`/`settings`/`agentChat`; assertion helper; `playwright.config.ts`; three specs; `e2e/README.md`; `e2e-test-author` skill; `AGENTS.md` link; `e2e/tsconfig.json`.
- **Phase 4**: verification, deferred-work issues, status update, this report.

## Files changed

New: `e2e/playwright.config.ts`, `e2e/tsconfig.json`, `e2e/README.md`,
`e2e/src/config/{loadEnv,timeouts,tags}.ts`,
`e2e/src/harness/{ports,isolatedRun,devStack,desktopArtifacts,appLaunch,launchEnv,readiness,artifacts,processSpawn,log,env,testFixtures}.ts`,
`e2e/src/flows/{shell,onboarding,settings,agentChat}.ts`,
`e2e/src/assertions/appAssertions.ts`,
`e2e/tests/{smoke/launch,settings/appearance,agent/reply}.spec.ts`,
`.agents/skills/e2e-test-author/SKILL.md`,
`docs/specs/2026-06-24-e2e-testing-foundation-design.md`, this report.

Modified (surgical): root `package.json` (devDep + 4 scripts), `.gitignore`,
`.env.example`, `AGENTS.md`, `docs/specs/{index,log}.md`,
`apps/electron/src/renderer/App.tsx` (`id="app-ready"`),
`apps/electron/src/renderer/components/onboarding/OnboardingWizard.tsx` (`id="onboarding-wizard"`),
`apps/electron/src/renderer/components/workspace/WorkspacePicker.tsx` (`id="workspace-picker"`).

## Verification (acceptance criteria)

All run on macOS (Darwin), provider key from root `.env`.

| AC | Result | Evidence |
|---|---|---|
| 1 Scaffolding | PASS | devDep + 4 scripts present; gitignore + `.env.example` updated |
| 2 Test listing | PASS | `bun run e2e --list` → 3 tagged specs, exit 0 |
| 3 Smoke + isolation | PASS | `@smoke` green; two runs → distinct ports (e.g. 65407 vs 65485) and distinct temp config dirs in manifests |
| 4 Build gate | PASS | Removing `dist/main.cjs` → loud error naming the artifact + `electron:build` |
| 5 Settings | PASS | `@settings` green; dark mode persists across reload (html `dark` class + localStorage) |
| 6 Agent | PASS | `@agent` green (18.4s real round-trip); deterministic token asserted ≥2 occurrences |
| 7 Release scaffold | PASS | `e2e:release` with no app path → exit 1, error names `KATA_E2E_RELEASE_APP` |
| 8 Prerequisite errors | PASS | Release + provider errors name the variable + point to `e2e/README.md` |
| 9 Static checks | PASS | `apps/electron` `tsc --noEmit` exit 0; `e2e` `tsc -p tsconfig.json` exit 0 |
| 10 No CI/pre-push | PASS | No `e2e`/`playwright` refs in `.github/workflows`; husky pre-push is the bootstrap stub |
| 11 Decision record + docs | PASS | Design doc + index/log links; `e2e/README.md` linked from `AGENTS.md` |
| 12 Surgical product edits | PASS | Only three added `id` attributes; no behavior changes |
| 13 Deferred work filed | PASS | Issues [#11](https://github.com/gannonh/kata-agents/issues/11), [#12](https://github.com/gannonh/kata-agents/issues/12), [#13](https://github.com/gannonh/kata-agents/issues/13) |

Full-suite run: `bun run e2e --project desktop-dev` → 3 passed.

## Approved deviations

1. **Provider key env name.** Plan assumed `ANTHROPIC_API_KEY`; the repo root `.env` uses `KATA_ANTHROPIC_API_KEY`. The reader accepts both, preferring the `KATA_`-prefixed name. User had pre-approved building Phases 0-4; this is a repo-fact correction consistent with the Kata brand cutover.
2. **Vite readiness host.** Probe `http://localhost:<port>` (not `127.0.0.1`) because Vite binds to `localhost`/IPv6, matching `VITE_DEV_SERVER_URL`.
3. **Benign console-error filter.** The dev `index.html` injects a React DevTools script (`localhost:8097`) absent under E2E, producing a benign `ERR_CONNECTION_REFUSED` resource error. The fatal-error collector ignores resource/DevTools console errors; uncaught `pageerror` exceptions remain fatal.
4. **@agent model selection.** Onboarding seeds an outdated default model (`Claude Haiku 3.5` / `claude-3-5-haiku-20241022`) that the live key 404s. The flow explicitly selects a current registry model (Haiku 4.5) in the composer before sending. The assertion requires the deterministic token to appear ≥2 times (prompt echo + reply) to prevent a false pass on the echoed prompt.
5. **Single Vite port model.** Kata Agents uses one Vite port over IPC (no server/web offset pair), so `ports.ts` is a minimal `findAvailablePort()` rather than the reference offset model. Subprocess server-port isolation is deferred (issue #11), and V1 stays `workers: 1`.

## Review gates

Single-agent path (no subagent dispatch used). Each phase was self-reviewed
against the spec and acceptance criteria, with live verification by running the
suite. TDD note: this is harness/test infrastructure; correctness was verified
by executing the tests themselves (red→green observed for each tier:
Vite-host, benign-error, settings-localStorage, agent-model selection). No
separate unit tests were added for harness modules in V1; `tsc` plus live runs
gate them. Independent subagent review was not used.

## Known follow-ups

- #11 parallel isolation (subprocess server ports, `workers > 1`).
- #12 macOS CI runner strategy.
- #13 real `desktop-release` validation against a packaged `.app`.
