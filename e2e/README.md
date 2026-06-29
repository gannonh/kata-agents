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
bun run e2e --list                              # list desktop-dev tests
bun run e2e                                     # all tests, desktop-dev project
bun run e2e --grep @smoke                       # one tier
bun run e2e:headed --grep @smoke                # headed (debug selectors)
bun run e2e:web                                 # browser/WebUI Playwright tests
bun run e2e:codegen                             # record WebUI flows with Playwright CodeGen
bun run e2e:ui                                  # Playwright UI mode
KATA_E2E_RELEASE_APP="/path/Kata Agents.app" bun run e2e:release   # packaged app
```

> The `e2e:*` scripts invoke the Playwright CLI through **Node**, not Bun.
> Bun's WebSocket client cannot complete the Node-inspector handshake that
> `_electron.launch` uses to attach to a **packaged** Electron app, so release
> launches hang under Bun. Node works for both dev and release.

## desktop-release (packaged app)

The same spec files run under `desktop-dev` and `desktop-release`; only the
launch target differs (`metadata.launchTarget`). Release launches a packaged
`.app` (renderer loaded from `file://`), dev launches Vite + Electron.

Build an E2E-ready app and run the release project:

```bash
# Build a staged, ad-hoc-signed .app (prints the path on the last line).
KATA_APP=$(bun run e2e:build-release arm64 | tail -1)
KATA_E2E_RELEASE_APP="$KATA_APP" bun run e2e:release
```

Why a dedicated build step:
- `build-dmg.sh` stages the root-hoisted `@anthropic-ai/claude-agent-sdk` and
  `@vscode/ripgrep` into `apps/electron/node_modules` so the packaged main
  process can boot. A bare `electron-builder` run ships an app that never opens
  a window.
- The production signature uses hardened runtime without a debugger
  entitlement, which blocks Playwright's inspector attach. `e2e:build-release`
  re-signs the bundle ad-hoc with `get-task-allow` so it is locally drivable.
  This does not change the production build config.

You can also point `KATA_E2E_RELEASE_APP` at any locally-built `.app`; if it was
produced by the production pipeline (hardened runtime), re-sign it first:
`codesign --force --deep --sign - --entitlements <debug.plist> "/path/App.app"`.

## Test tiers

| Tag | Fixture | What it does |
|---|---|---|
| `@smoke` | `appWindow` | Launch → `#root` mounts → onboarding wizard visible → assert 0 fatal errors. Fully offline. |
| `@settings` | `authenticatedAppWindow` | Deferred-setup → ready shell → change appearance Mode → reload → assert persisted. |
| `@agent` | (in-test) | Real Anthropic onboarding → new session → pick a live model → deterministic prompt → assert reply. `workers: 1`. |
| `@oauth` | `web-dev` Playwright + Bun integration | Local relay + WebUI callback chain and MCP OAuth prepare (relay vs Electron local callback). Browser coverage runs with `bun run e2e:web`; offline integration coverage runs with `bun run e2e:oauth`. |

## Commands (OAuth tier)

```bash
bun run e2e:web      # Playwright browser coverage for WebUI relay callback pages
bun run e2e:oauth    # relay/callback chain + MCP OAuth prepare (offline integration)
```

## WebUI startup modes

- `bun run webui:dev` starts the browser frontend on `http://localhost:5175`. It
  expects the headless server to already be running on `http://localhost:9100`.
- `bun run webui:dev:full` starts the built WebUI and the server together on
  `http://localhost:9100/login`. It generates a fresh `KATA_SERVER_TOKEN`, sets
  the dev login password to `dev`, and serves the app from the server process.

For manual testing, use one of these:

```bash
bun run webui:dev:full
# open http://localhost:9100/login and sign in with password: dev

# or, split frontend and backend into two terminals:
TOKEN=$(bun run packages/server/src/index.ts --generate-token)
KATA_SERVER_TOKEN="$TOKEN" bun run packages/server/src/index.ts
bun run webui:dev
```

For Playwright recording:

```bash
bun run webui:dev:full
bun run e2e:codegen
```

Playwright CodeGen records browser/WebUI flows. It does not record Electron
`_electron.launch` tests directly. Paste generated tests into
`e2e/tests/web/recorded.spec.ts`, then tighten selectors and assertions before
relying on the flow as durable coverage.

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `KATA_CONFIG_DIR` | Set per-run by the harness (temp dir). | — |
| `KATA_VITE_PORT` | Set per-run by the harness (allocated free port). | — |
| `KATA_E2E_RELEASE_APP` | Packaged `.app` path for `desktop-release`. | unset → loud error |
| `KATA_E2E_AGENT_PROVIDER` | `@agent` provider: `anthropic` or `openai`. | `anthropic` |
| `KATA_E2E_AGENT_MODEL` | Composer model id picked in `@agent`. | per-provider default |
| `KATA_ANTHROPIC_API_KEY` / `ANTHROPIC_API_KEY` | Anthropic key for `@agent`. | from `.env` |
| `KATA_OPENAI_API_KEY` / `OPENAI_API_KEY` | OpenAI key for `@agent` (provider=openai). | from `.env` |
| `KATA_E2E_WORKERS` | Worker count. | `1` |
| `KATA_E2E_VIDEO` | `1` retains video on failure. | off |
| `KATA_E2E_AUTH_TIMEOUT_MS` | Settings/auth wait budget. | `15000` |
| `KATA_E2E_AGENT_REPLY_TIMEOUT_MS` | Agent reply wait budget. | `60000` |
| `KATA_E2E_*_TIMEOUT_MS` | Other timeout knobs (see `src/config/timeouts.ts`). | per-knob |

> `@agent` provider note: the validated onboarding UI path is the Anthropic
> API-key endpoint. `KATA_E2E_AGENT_PROVIDER=openai` selects the OpenAI key and
> model defaults, but a provider whose onboarding UI differs may need the
> onboarding flow extended.

## Architecture

```text
e2e/
  playwright.config.ts        # projects: desktop-dev (default), desktop-release, web-dev
  src/
    config/                   # loadEnv, timeouts, tags
    harness/                  # generic launch/process/isolation — no product selectors
    fixtures/                 # Playwright fixture composition root (wires flows → harness)
    flows/                    # product UI steps (shell, onboarding, settings, agentChat)
    assertions/               # launch-health only
  tests/{smoke,settings,agent}/*.spec.ts
  tests/web/*.spec.ts         # browser/WebUI tests and recording templates
```

Dependency direction: `tests → fixtures → harness`, `tests → flows`,
`flows → harness`. Never `harness → flows`. The fixtures layer is the
composition root: it is the only place flows may be wired into the launch
pipeline; generic harness modules must not import flows.

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
