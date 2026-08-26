---
name: verify-kata-agents
description: "Verify the Kata Agents macOS Electron desktop app with its isolated Playwright harness; use when proving launch, onboarding, settings, browser-panel, agent, or Git behavior."
---

# Verify Kata Agents

Use this skill when a change affects the Kata Agents desktop experience. The primary surface is the real macOS Electron app. The repository also contains a headless server, WebUI, and CLI; those have separate Playwright projects and are outside this skill's primary launch path.

Run every command from the repository root. This is a local macOS GUI check: the checked-in Electron harness asserts `darwin` and does not support a headless Linux run.

## Launch

Install and build the desktop prerequisites once:

```bash
bun install
bun run ensure:electron
bun run electron:build
```

The isolated launch-and-proof helper is:

```bash
node --experimental-strip-types .agents/skills/verify-kata-agents/scripts/capture-launch-proof.ts
```

It creates a fresh temporary `KATA_CONFIG_DIR`, allocates a free Vite port, starts Vite only, launches one Electron process through Playwright, waits for the renderer URL, waits for `#root` to mount, captures the onboarding/ready screen, and tears everything down. Do not run `bun run electron:dev` beside an E2E run: that command starts its own Electron instance and can duplicate the backend.

For an existing mapped feature, use the repository's real-Electron runner. It starts and stops the instance for the test:

```bash
bun run e2e --grep @smoke --trace on
bun run e2e --grep @settings --trace on
bun run e2e --grep @browser --trace on
bun run e2e --grep @agent --trace on
bun run e2e --grep @git --trace on
```

The dev run is ready when the output includes `Vite dev server is ready`, `Electron renderer window is ready`, and `renderer #root to mount`. A fresh run normally exposes `#onboarding-wizard`; the provider-free setup path clicks `[data-testid="onboarding-setup-later"]`, handles `#workspace-picker` if it appears, and waits for `#app-ready`. The `@smoke`, `@settings`, and structural `@browser` tiers do not require an AI credential. `@agent` and browser annotation-send use the configured real provider chain described in `e2e/README.md`.

For a packaged app, set the explicit app path and use the release project:

```bash
KATA_E2E_RELEASE_APP="/path/to/Kata Agents.app" bun run e2e:release --grep @smoke --trace on
```

The release bundle must be locally inspector-compatible; see the `desktop-release` section of `e2e/README.md` before using it.

## Doctor

Run the read-only doctor against the manifest of the instance that this run owns, while that instance is still alive. The proof helper runs this check internally before cleanup. For a focused Playwright run, select the current run in a second terminal:

```bash
RUN_MANIFEST=$(ls -td e2e/test-results/e2e-*/manifest.json | head -1)
node --experimental-strip-types .agents/skills/verify-kata-agents/scripts/doctor.ts "$RUN_MANIFEST"
```

The doctor refuses an instance it cannot identify as ours. It checks macOS, the root package name/version, the current Git revision, `apps/electron/dist/main.cjs`, `apps/electron/dist/bootstrap-preload.cjs`, the manifest's temporary config and artifact directories, the current user's ownership of the manifest Vite listener, and a matching Electron process. The default provider-free diagnosis reports that authentication is not required. Add `--agent` for an agent tier; it checks that at least one configured provider candidate exists without printing a secret. The live agent flow additionally calls the app's read-only `getChatGptAuthStatus("chatgpt-plus")` check before configuring the OAuth connection, or validates the selected API-key fallback at setup time.

A doctor failure means the process, build, port, or credential precondition is not trustworthy. Stop driving that instance. Do not attach to a user's ordinary Kata Agents process or a run whose manifest is missing.

## Drive

Read [`features/README.md`](features/README.md) first, then the feature file for the behavior under test. The stable handles used by the real harness are:

- `#root`, `#onboarding-wizard`, `#workspace-picker`, and `#app-ready` for lifecycle state.
- `[data-testid="onboarding-setup-later"]`, `[data-testid="workspace-create-input"]`, and `[data-testid="workspace-create-button"]` for credential-free setup.
- `[data-tutorial="new-chat-button"]`, `[data-tutorial="chat-input"]`, `[data-tutorial="model-picker-trigger"]`, and `[data-tutorial="send-button"]` for a real agent turn.
- `#browser-panel`, `#browser-annotate-toggle`, and `#browser-annotation-tray` for the integrated browser.
- `[data-testid="git-workspace-control"]`, `[data-testid="git-workspace-new-worktree"]`, `[data-testid="git-workspace-name"]`, `[data-testid="git-workspace-create"]`, and `[data-testid="git-workspace-identity"]` for managed workspaces.

Prefer ARIA roles and these markers over coordinates, tab order, generated class names, or DOM position. Drive the user action first and assert the resulting UI and side effect second. The checked-in browser flow uses the Electron `webContents` adapter only for clicks inside a native BrowserView, which Playwright cannot treat as a normal page; it still exercises the guest page's visible target.

## Evidence

The proof helper leaves evidence under its run-specific `e2e/test-results/<runId>/` directory:

- `manifest.json` records the run ID, project, launch target, temporary config directory, Vite port, and artifact root.
- `launch-actions.txt` records the launch action and observed shell state.
- `launch-proof.png` is a screenshot with Kata Agents visible.
- `launch-proof.aria.yml` is the renderer's ARIA snapshot.
- `dev-stack-*.log` and `renderer-console.log` preserve process and renderer output.

The Playwright runner writes its JSON report and any `--trace on` trace under `e2e/test-results/` and its HTML report under `e2e/playwright-report/`. These paths are ignored by Git but survive the run cleanup. Keep the run ID with any report. A valid proof includes the user action, the resulting state, and the relevant side effect:

- launch/onboarding: the renderer mounted and the onboarding wizard is visible; fatal renderer errors are empty.
- appearance: the user-selected mode changes the `html` class, survives reload, and the namespaced local-storage value reads back as `dark`/`light`/`system`.
- browser: the visible panel retains the same `data-browser-instance-id` through detach/attach; annotation state is visible in `#browser-annotation-tray` when exercised.
- agent: the user turn and assistant turn both exist, and the assistant response matches the unique prompt token.
- Git: the UI identity, branch, checkout path, and actual `git branch --show-current` agree; created remote/managed resources are removed by the test cleanup.

Do not use renderer setters, direct local-storage writes, test-only endpoints, or a final screenshot alone as proof. For external providers, use the existing credential boundary and real provider fallback; do not add a fake production adapter. If a safe path is called a dry run, inspect its files, network, and Git refs before treating it as non-mutating.

## Cleanup

The Playwright fixture and `capture-launch-proof.ts` register the exact Electron and Vite children they start. Their `finally` cleanup closes Electron, terminates that Vite child, and removes only the temporary `KATA_CONFIG_DIR`. Never use `pkill`, `killall`, or a process-name kill against Electron or Vite. If a failed run strands a process, use the manifest port and the doctor/lsof output to identify only the process owned by this run, terminate that PID, and confirm the port is free.

Cleanup must not remove `e2e/test-results/<runId>/`, `e2e/playwright-report/`, or any copied proof artifact. After cleanup, verify that `manifest.json`, `launch-proof.png`, and `launch-proof.aria.yml` still exist. Feature-specific temporary repositories, managed worktrees, branches, sessions, and browser instances must be removed by their fixture; preserve their reports and screenshots.

The harness defaults to one worker. Keep `KATA_E2E_WORKERS=1` for this skill: subprocess services around the shared RPC port are not isolated for parallel workers yet, and agent credentials are shared state.

## Helpers

These executable helpers are part of this skill:

- `node --experimental-strip-types .agents/skills/verify-kata-agents/scripts/capture-launch-proof.ts` launches the isolated dev app, runs the doctor while it is live, captures the launch screenshot/ARIA snapshot/action record, cleans up, and verifies the evidence remains.
- `node --experimental-strip-types .agents/skills/verify-kata-agents/scripts/doctor.ts "$RUN_MANIFEST"` performs the read-only owned-instance/build/port/process check. Add `--agent` when checking an agent-tier provider precondition.

Use `/maintain-verification-skill` after adding or changing routes, commands, selectors, or teardown behavior so this map stays aligned with the app.
