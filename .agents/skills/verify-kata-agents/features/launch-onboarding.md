# Launch and deferred setup

Launching Kata Agents mounts the real Electron renderer, shows the provider-selection onboarding screen on a fresh config, and can continue without credentials into a selected workspace and ready shell.

## Sub-features

- `launch-renderer` mounts `#root` and exposes the onboarding or ready shell.
- `setup-later` reaches the provider-free ready path through `Setup later`.
- `workspace-select` selects an existing workspace when the picker has one.
- `workspace-create` creates a named workspace when the picker is empty.
- `setup-ready` exposes `#app-ready` after deferred setup.

## How to get to it (user POV)

- Start Kata Agents from a fresh local profile.
- On the provider-selection screen, choose `Setup later`.
- If the app asks for a workspace, select one or enter a name and choose `Create workspace`. Isolated desktop e2e usually does not show this picker.

## Driving it with Playwright + real Electron

Preconditions:

- macOS GUI session and built Electron main/preload bundles.
- Fresh harness-owned config; do not reuse a normal Kata Agents profile.

- **Launch.** Run `node --experimental-strip-types .agents/skills/verify-kata-agents/scripts/capture-launch-proof.ts`. The helper waits for the real Vite renderer, `#root`, and `#onboarding-wizard`/`#app-ready`, and records the screen before teardown.
- **Smoke equivalent.** Run `bun run e2e --grep @smoke --trace on`. The checked-in test asserts `#root`, waits for `#onboarding-wizard`, and fails on fatal renderer errors.
- **Defer setup.** In the provider-selection view, click `[data-testid="onboarding-setup-later"]`. On the isolated desktop app the main process already created a local workspace, so wait for `#app-ready` (after splash). `#workspace-picker` is the no-`wsId` / thin-client gate, not the usual post-Setup-later path.
- **Create a workspace.** If `#workspace-picker` is visible and has no `[data-testid^="workspace-select-"]`, fill `[data-testid="workspace-create-input"]` with a disposable name and click `[data-testid="workspace-create-button"]`. Wait for `#app-ready`.
- **Select a workspace.** If a workspace exists, click its `[data-testid^="workspace-select-"]` button and wait for `#app-ready`.
- **Proof.** Keep `manifest.json`, `launch-actions.txt`, `launch-proof.png`, `launch-proof.aria.yml`, renderer logs, and the Playwright report. The visible result must identify Kata Agents and the onboarding or ready state; do not treat a process exit alone as a successful launch.

## Gotchas

- The fresh onboarding state is provider selection, not necessarily the welcome copy; wait for the stable `#onboarding-wizard` marker rather than a title string.
- `Setup later` is a provider-free test path, not proof that an AI provider is configured.
- Workspace picker creation is only needed when `#workspace-picker` appears (thin client / missing window workspace id). Isolated desktop e2e does not show it after Setup later.
- `#app-ready` is withheld until splash completes; wait for the id, not only `appState === 'ready'`.
- `bun run electron:dev` starts a second Electron process and is not the Playwright launch command.
- `desktop-release` loads a `file://` renderer and requires `KATA_E2E_RELEASE_APP`; do not mix its process with a dev run.
