# Kata Agents local E2E (Playwright + real Electron)

Local-only, macOS-first end-to-end tests that launch the **real Electron app**
against **real services**. No CI in V1; run these on a macOS GUI session.

## Prerequisites

```bash
bun install
bun run ensure:electron
bun run electron:build   # produces apps/electron/dist/main.cjs + bootstrap-preload.cjs
```

The harness fails loud if the desktop build artifacts are missing.

For the `@agent` tier, a real Anthropic key must be in the repo root `.env`
(either `KATA_ANTHROPIC_API_KEY` or `ANTHROPIC_API_KEY`).

## Commands

```bash
bun run e2e --list                              # list tests
bun run e2e                                     # all tests, desktop-dev project
bun run e2e --grep @smoke                       # one tier
bun run e2e:headed --grep @smoke                # headed (debug selectors)
bun run e2e:ui                                  # Playwright UI mode
KATA_E2E_RELEASE_APP="/path/Kata Agents.app" bun run e2e:release --grep @smoke
```

## Test tiers

| Tag | Fixture | What it does |
|---|---|---|
| `@smoke` | `appWindow` | Launch → `#root` mounts → onboarding wizard visible → assert 0 fatal errors. Fully offline. |
| `@settings` | `authenticatedAppWindow` | Deferred-setup → ready shell → change appearance Mode → reload → assert persisted. |
| `@agent` | (in-test) | Real Anthropic onboarding → new session → pick a live model → deterministic prompt → assert reply. `workers: 1`. |

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `KATA_CONFIG_DIR` | Set per-run by the harness (temp dir). | — |
| `KATA_VITE_PORT` | Set per-run by the harness (allocated free port). | — |
| `KATA_E2E_RELEASE_APP` | Packaged `.app` path for `desktop-release`. | unset → loud error |
| `KATA_ANTHROPIC_API_KEY` / `ANTHROPIC_API_KEY` | Powers `@agent`. | from `.env` |
| `KATA_E2E_WORKERS` | Worker count. | `1` |
| `KATA_E2E_VIDEO` | `1` retains video on failure. | off |
| `KATA_E2E_*_TIMEOUT_MS` | Timeout knobs (see `src/config/timeouts.ts`). | per-knob |

## Architecture

```text
e2e/
  playwright.config.ts        # projects: setup, desktop-dev (default), desktop-release
  src/
    config/                   # loadEnv, timeouts, tags
    harness/                  # generic launch/process/isolation — no product selectors
    flows/                    # product UI steps (shell, onboarding, settings, agentChat)
    assertions/               # launch-health only
  tests/{smoke,settings,agent}/*.spec.ts
```

Dependency direction: `tests → fixtures → harness`, `tests → flows`,
`flows → harness`. Never `harness → flows`.

### Key design points

- **Playwright owns Electron.** The harness starts **Vite only** (mirroring
  `scripts/electron-dev.ts`), then launches one Electron instance
  (`electron apps/electron`). It does not run `electron:dev`.
- **Run isolation.** Each run gets a temp `KATA_CONFIG_DIR`, an allocated Vite
  port, and a `test-results/<runId>/manifest.json`.
- **id-based selectors.** Stable markers added to product code:
  `#root`, `#onboarding-wizard`, `#app-ready`, `#workspace-picker`.
- **Fail loud.** Missing build artifacts, release app path, or provider key
  throw with the variable name and a pointer here.

## Known follow-ups

- Parallel isolation (subprocess server ports near RPC 9100) for `workers > 1`.
- macOS CI runner strategy before any CI adoption.
- Real `desktop-release` validation against a packaged `.app`.
