# Kata Agents verification map

This directory is the maintained user-facing verification map for the Kata Agents macOS Electron desktop app. Read this index before driving the app, then use the feature file for the behavior under test.

## Baseline preconditions

- Run from the repository root on a macOS GUI session.
- Build `apps/electron/dist/main.cjs` and `apps/electron/dist/bootstrap-preload.cjs` with `bun run ensure:electron && bun run electron:build`.
- Use the checked-in Playwright `desktop-dev` project. It creates a fresh temporary `KATA_CONFIG_DIR` and free Vite port for every test.
- Keep `KATA_E2E_WORKERS=1`; the repository does not yet isolate all shared subprocess ports for parallel workers.
- The default locale is English, which is why the stable English ARIA names below match the checked-in test harness. Prefer `data-testid`/`data-tutorial` markers when a translated label is not necessary.
- Provider-free launch, deferred setup, appearance, and structural browser checks need no AI credential. Agent turns and browser annotation-send require the real provider chain in `e2e/README.md`; GitHub integration additionally needs authenticated `gh` and the configured UAT checkout.
- Never drive an instance whose manifest was not created by the current run.

## Driving conventions

- Start each recipe from its stated precondition; a fresh run is the default.
- Use `bun run e2e --grep @smoke --trace on` or the feature-specific command so the checked-in harness owns launch and teardown.
- Prefer ARIA roles and stable test markers over coordinates and generated CSS classes.
- For every mutation, assert a second user-visible read or an external side effect such as local-storage readback, `git branch --show-current`, or a persisted session turn.
- Keep the run ID with screenshots, ARIA snapshots, logs, and Playwright reports.
- Do not call a feature verified through one entry point when another entry point in that feature file was skipped.

## Features

- [Launch and deferred setup](./launch-onboarding.md) covers the first renderer state, `Setup later`, workspace selection/creation, and the ready shell.
- [Appearance settings](./appearance-settings.md) covers the user-facing settings menu, mode changes, and persistence after reload.
- [Embedded browser panel](./browser-panel.md) covers creating, showing, detaching, reattaching, hiding, and enabling Annotate on a fixture page.
- [Agent session](./agent-session.md) covers a real provider-backed session, model selection, a deterministic prompt, and the assistant reply.
- [Git workspaces](./git-workspaces.md) covers current checkout versus managed worktree selection, branch identity, configured roots, and cleanup.
