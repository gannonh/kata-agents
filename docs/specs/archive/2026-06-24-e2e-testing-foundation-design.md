---
type: Spec
title: "Local Electron E2E testing foundation (design + decision record)"
description: "V1 constraints, environment contract, and verification matrix for the local-only macOS-first Playwright + real-Electron E2E foundation in Kata Agents."
tags: [testing, e2e, electron, playwright, kata-agents, decision-record]
status: Completed
timestamp: 2026-06-24T00:00:00Z
migrated: false
archived_at: 2026-08-04T16:24:02Z
---

> **Completed before migration** (status: Completed). Retained as history. Not tracked in GitHub Issues.

# Local Electron E2E testing foundation

Decision record for the Kata Agents E2E foundation. The implementation plan lives in
[e2e-foundation-adoption-plan.md](e2e-foundation-adoption-plan.md); the cross-repo adoption guide is
[e2e-foundation-adoption.md](e2e-foundation-adoption.md). This document records the durable V1
decisions, the environment contract, and the verification matrix.

> The adoption guide predates the Kata brand cutover and uses `CRAFT_*` env names. Those are
> **superseded by `KATA_*`** here (`KATA_CONFIG_DIR`, `KATA_VITE_PORT`, `KATA_E2E_RELEASE_APP`).

## V1 constraints

- **Local-only.** No CI and no pre-push coupling. Maintainer/nightly validation on a macOS GUI host.
- **macOS-first.** The harness throws on non-darwin hosts.
- **Real services, no mocks.** No Playwright `route().fulfill()`, MSW, or fake backends in specs.
  The `@agent` tier uses a real provider key from root `.env`.
- **Run isolation.** Each run gets a temp `KATA_CONFIG_DIR`, an allocated Vite port, and a per-run
  artifact directory with a `manifest.json`.
- **Playwright owns Electron.** The harness spawns **Vite only**; it never runs `electron:dev`
  (which would launch a second Electron and duplicate backends).
- **id-based selectors.** Stable DOM `id`s (`#root`, `#onboarding-wizard`, `#app-ready`,
  optional `#workspace-picker`). No `data-testid`.
- **Starter tiers.** `@smoke` (offline launch + onboarding wizard), `@settings` (deferred-setup →
  ready → persist a setting), `@agent` (real provider reply, `workers: 1`).
- **Release supported.** The `desktop-release` project launches a packaged `.app` (renderer from
  `file://`) and runs the same specs as `desktop-dev`. Build an E2E-ready app with
  `bun run e2e:build-release` (stages the SDK + ripgrep, ad-hoc re-signs with a debugger
  entitlement). `KATA_E2E_RELEASE_APP` unset → loud error.
- **Node runner.** The `e2e:*` scripts invoke the Playwright CLI under Node. Bun's WebSocket
  client cannot complete the Node-inspector handshake `_electron.launch` uses to attach to a
  packaged Electron app, so release launches hang under Bun.

## Reaching app states deterministically

`getSetupNeeds()` (`packages/shared/src/auth/state.ts:332`) drives boot
(`apps/electron/src/renderer/App.tsx`):

| State | Condition | E2E entry point |
|---|---|---|
| `onboarding` | not configured | `@smoke` — fresh temp config dir, assert wizard renders |
| `workspace-picker` | configured, no workspace | auth fixture picks/creates first workspace |
| `ready` | configured + workspace | `@settings` / `@agent` after deferred-setup or real key |

`isFullyConfigured` returns true when **setup is deferred** (`setupDeferred` flag in
`config.json`, read by `isSetupDeferred()` at `packages/shared/src/config/storage.ts:2975`). The
auth fixture writes this flag into the temp config dir to reach `ready` credential-free for
`@settings`.

## Environment contract (KATA_*)

| Variable | Owner | Purpose |
|---|---|---|
| `KATA_CONFIG_DIR` | harness (per run) | Per-run temp config dir created via `mkdtemp` and exported to the app. `~/.kata-agents` is used only when the env var is unset outside E2E. |
| `KATA_VITE_PORT` | harness (per run) | Allocated free Vite port; passed to `vite dev --strictPort`. |
| `VITE_DEV_SERVER_URL` | harness | `http://localhost:<KATA_VITE_PORT>`; renderer entry for dev launch. |
| `KATA_APP_NAME` | harness | Mirrors `getElectronEnv()` shape. |
| `KATA_DEEPLINK_SCHEME` | harness | Mirrors `getElectronEnv()` shape. |
| `KATA_E2E_RELEASE_APP` | operator | Path to packaged `.app` for `desktop-release`. Unset → loud error. |
| `ANTHROPIC_API_KEY` (and peers) | root `.env` | Powers the `@agent` real-provider tier. |
| `KATA_E2E_WORKERS` | operator | Worker count override; default 1. |

Env keys for the Electron launch mirror `getElectronEnv()` in `scripts/electron-dev.ts:277-292`,
and the Vite spawn mirrors `scripts/electron-dev.ts:541`. The single owner for dev-stack env is the
harness `isolatedRun`/`launchEnv` modules.

## Verification matrix

| Area | Command | Pass |
|---|---|---|
| List tests | `bun run e2e --list` | Shows tagged starter tests |
| Dev smoke | `bun run e2e --project desktop-dev --grep @smoke` | exit 0, manifest written, 0 fatal errors |
| Isolation | Two sequential smokes | Different Vite ports + config dirs in manifests |
| Build gate | Remove `dist/main.cjs`, run smoke | Loud error naming the artifact + `electron:build` |
| Settings | `bun run e2e --grep @settings` | Reaches `#app-ready`, setting persists across reload |
| Agent | `bun run e2e --grep @agent` (key in `.env`) | Non-empty assistant reply, `workers: 1` |
| Release channel | `KATA_E2E_RELEASE_APP=<app> bun run e2e:release` | All tiers green against packaged `.app` |
| Release missing app | `bun run e2e:release` (no app path) | Non-zero, clear missing-path error |
| Static | per-package `tsc --noEmit` | No regressions |
| CI unchanged | existing workflows | E2E absent from CI and pre-push |

## Deferred work

Filed as GitHub issues per `AGENTS.md`:

- Parallel isolation: allocate/override subprocess server ports (RPC ~9100) so `workers > 1` is safe. ([#11](https://github.com/gannonh/kata-agents/issues/11))
- macOS CI runner strategy before any CI adoption. ([#12](https://github.com/gannonh/kata-agents/issues/12))
- Real `desktop-release` validation: **done** — all three tiers pass against a packaged `.app`. ([#13](https://github.com/gannonh/kata-agents/issues/13), closed)
