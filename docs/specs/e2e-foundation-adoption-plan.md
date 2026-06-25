---
type: spec
---

# Plan: Adopt the local Electron E2E foundation in Kata Agents

## Context

Kata Agents has unit tests (`bun test`) and manual desktop smoke (`electron:start`) but **no E2E coverage**. The adoption guide `docs/specs/e2e-foundation-adoption.md` describes bringing the Playwright + real-Electron foundation proven in the sibling repo Kata Code (`/Volumes/EVO/dev/kata-code`, branch `feat/mobile-e2e-testing-foundation`) into this repo. This plan implements that adoption, adapted to Kata Agents' actual architecture.

Goal: a **local-only, macOS-first** Playwright suite that launches the real Electron app against real services, with run isolation (temp config dir, allocated port, per-run artifacts), starter tests at `@smoke` / `@settings` / `@agent`, and **no CI** in V1.

### Why this is not a wholesale copy of Kata Code

The reference harness assumes a different app shape. Concrete deltas drive a copy-the-pattern / rewrite-the-harness approach:

| Concern | Kata Code (reference) | Kata Agents (this repo) |
|---|---|---|
| Desktop dir / main entry | `apps/desktop` → `dist-electron/main.cjs` | `apps/electron` → `dist/main.cjs` (`apps/electron/package.json` `main`) |
| Launch | `electron-launcher.mjs` raw-binary shim | plain `electron apps/electron`, no shim |
| Ports | server+web pair, `KATACODE_PORT_OFFSET`, `findAvailablePortOffset` | single Vite port `KATA_VITE_PORT`; renderer talks over IPC/preload |
| Home dir env | `KATACODE_HOME` | `KATA_CONFIG_DIR` (`packages/shared/src/config/paths.ts:19`) |
| Auth gate | Clerk sign-in | local credentials/onboarding wizard; `getSetupNeeds()` |

So we reuse the **structure and proven learnings** from `e2e/README.md` and the harness module boundaries, but rewrite harness internals for Kata Agents' single-port, IPC, credentials-onboarding model. Flows and auth are written fresh; Clerk/pairing code is omitted.

### Decisions (confirmed)

- **Scope:** land `@smoke` first, then add `@settings` and `@agent`. Provider keys are already present in root `.env`, so the seeded/real-provider tiers are viable.
- **Selectors:** id-based locators preferred. Use existing `#root`; add a few stable DOM `id`s to product code (below). No `data-testid`.
- **Release target:** scaffold the `desktop-release` Playwright project but defer real release validation; it no-ops with a clear error when `KATA_E2E_RELEASE_APP` is unset.

---

## Reaching app states deterministically

App boot (`apps/electron/src/renderer/App.tsx:651-681`) calls `getSetupNeeds()`:
- configured + workspace selected → `ready`
- configured + no workspace → `workspace-picker`
- not configured → `onboarding`

`getSetupNeeds` (`packages/shared/src/auth/state.ts:332-346`) returns `isFullyConfigured: true` when **setup is deferred** (`isSetupDeferred()` reads from config storage; written by `DEFER_SETUP` / the wizard "Setup later" path). This gives the test tiers their entry points:

- **`@smoke`** — fresh temp `KATA_CONFIG_DIR`, no seeding. Assert renderer mounts and the **onboarding wizard** renders with zero fatal errors. Fully offline/deterministic.
- **`@settings`** — `authenticatedAppWindow` fixture reaches `ready` by setting the **deferred-setup** flag in the temp config dir (credential-free), handling `workspace-picker` if it appears (pick/create first workspace).
- **`@agent`** — same fixture but configures a **real** Anthropic connection by driving the API-key onboarding step with the key from `.env`, then sends a deterministic prompt and asserts the reply. `workers: 1`.

---

## Work plan

### Phase 0 — Decision record (OKF)
- Add `docs/specs/2026-06-24-e2e-testing-foundation-design.md` (OKF frontmatter, `type: Spec`): V1 constraints (local-only, macOS, no service mocks, id-based selectors, starter tiers), env-var table (KATA_*), and the verification matrix copied from the adoption guide.
- Link it from `docs/specs/index.md`; add a `docs/specs/log.md` / relevant `log.md` entry.
- Reference `docs/specs/e2e-foundation-adoption.md` as the baseline (note its `CRAFT_*` names are superseded by `KATA_*`).

### Phase 1 — Scaffold
- Add `@playwright/test` devDependency (root `package.json`).
- Root scripts (default project `desktop-dev`):
  - `e2e`: `playwright test --config e2e/playwright.config.ts --project desktop-dev`
  - `e2e:headed`: same + `--headed`
  - `e2e:ui`: `playwright test ... --ui`
  - `e2e:release`: `... --project desktop-release`
- `.gitignore`: add `e2e/.auth/`, `e2e/test-results/`, `e2e/playwright-report/`.
- `.env.example`: add `KATA_E2E_RELEASE_APP` (path to packaged `.app`) and a comment that provider keys (e.g. `ANTHROPIC_API_KEY`) power `@agent`.
- `e2e/src/config/loadEnv.ts`: load root `.env` / `.env.local` (mirror the `loadEnvFile()` parser in `scripts/electron-dev.ts:98-120`).

### Phase 2 — Harness (`e2e/src/harness/`)
Adapt module boundaries from Kata Code; rewrite internals.

- **`ports.ts`** — minimal `findAvailablePort()` via `net` probe (no offset model). Returns one free port for Vite. *(Note: subprocess servers default near RPC `9100`; V1 stays `workers: 1` sequential to avoid collisions — file a follow-up issue to allocate/override server ports for parallel isolation.)*
- **`isolatedRun.ts`** — per-run: `runId`, `mkdtemp` temp `KATA_CONFIG_DIR`, allocated Vite port, artifact dir, cleanup registry. Build `devEnv` with `KATA_CONFIG_DIR`, `KATA_VITE_PORT`, `VITE_DEV_SERVER_URL=http://localhost:<port>`, `KATA_APP_NAME`, `KATA_DEEPLINK_SCHEME` (mirror keys from `getElectronEnv()` in `scripts/electron-dev.ts:276-292` — single owner for dev-stack env, per learning #2).
- **`devStack.ts`** — spawn **Vite only** on the allocated port (mirror the Vite spawn in `scripts/electron-dev.ts:540-548`: `vite dev --config apps/electron/vite.config.ts --port <port> --strictPort`). Do **not** run `electron:dev` (learning #3 — Playwright owns the single Electron instance).
- **`desktopArtifacts.ts`** — build gate: assert `apps/electron/dist/main.cjs` and `dist/bootstrap-preload.cjs` exist; throw with instruction to run `bun run electron:build` (renderer dist not required in dev — Vite serves it via `VITE_DEV_SERVER_URL`).
- **`appLaunch.ts`** — dev: `_electron.launch({ args: [join(repoRoot, 'apps/electron')], env, cwd: repoRoot })` (Playwright resolves the local `electron` binary; equivalent to `electron apps/electron`). Wait for the renderer window, attach console/pageerror logging, and a fatal-error collector (port the `resolveRendererWindow` + `attachFatalLaunchErrorTracking` patterns from `kata-code/e2e/src/harness/appLaunch.ts`).
- **`launchEnv.ts`** — release env stripping (remove `VITE_DEV_SERVER_URL`, dev port) for `desktop-release` (learning #4).
- **`readiness.ts`** — TCP/HTTP wait on the Vite port before launch.
- **`artifacts.ts` / `processSpawn.ts` / `log.ts` / `env.ts`** — per-run manifest (runId, port, config dir), process-log appender, prerequisite readers that **fail loud** with the missing var name + pointer to `e2e/README.md` (learning #8).
- **`testFixtures.ts`** — fixture chain (do not collapse, per spec):
  - `launchedApp` — Vite-only dev stack + Electron boot + renderer window + fatal-error listeners.
  - `appWindow` — wait for `#root` mounted and the active shell marker visible.
  - `authenticatedAppWindow` — opt-in: drive deferred-setup (or real API-key config for `@agent`) to reach `#app-ready`, handling `workspace-picker`.

### Phase 3 — Product flows, markers, specs
- **id markers (surgical product edits):**
  - `apps/electron/src/renderer/components/onboarding/OnboardingWizard.tsx:193` root `<div>` → add `id="onboarding-wizard"`.
  - `apps/electron/src/renderer/App.tsx` ready container `<div>` (~line 2000) → add `id="app-ready"`.
  - (optional) `WorkspacePicker` root → `id="workspace-picker"` to let the auth fixture detect/handle it.
- **`e2e/src/flows/shell.ts`** — canonical waits keyed on `#root`, `#onboarding-wizard`, `#app-ready`.
- **`e2e/src/flows/onboarding.ts`** — deferred-setup helper (→ `ready`) and real API-key helper (drives `ProviderSelectStep` → API key → validate → complete, using `.env` key) for `@agent`.
- **Specs (thin bodies):**
  - `e2e/tests/smoke/launch.spec.ts` `@smoke` — launch → `#root` → `#onboarding-wizard` visible → assert 0 fatal errors.
  - `e2e/tests/settings/appearance.spec.ts` `@settings` — `authenticatedAppWindow` → change appearance/language → reload → assert persisted.
  - `e2e/tests/agent/reply.spec.ts` `@agent` — real provider → new session → deterministic prompt → assert assistant reply (`workers: 1`).
- **`e2e/playwright.config.ts`** — projects `setup`, `desktop-dev` (default), `desktop-release`; reporters list/html/json; `trace`/`screenshot` on failure; `workers` from env (default 1).
- **`e2e/README.md`** — operator commands, env vars, prerequisites; link from `AGENTS.md`.
- **`.agents/skills/e2e-test-author/SKILL.md`** — adapt from Kata Code's skill (Kata Agents flow names, id-selector convention).

### Phase 4 — Verification
- `bun run e2e --list` → starter tests listed.
- `bun run e2e:headed --project desktop-dev --grep @smoke` → exit 0, manifest written.
- Two sequential `@smoke` runs → different ports/config dirs in manifests (isolation).
- `@settings` and `@agent` (with `.env` key) green.
- `bun run e2e:release --grep @smoke` with `KATA_E2E_RELEASE_APP` unset → clear missing-path error (no silent skip).
- Per-package `tsc --noEmit` for touched packages; `bun test` on any harness unit tests.
- Keep E2E out of CI and out of the pre-push hook.

---

## Files

**New:** `e2e/playwright.config.ts`; `e2e/src/config/{loadEnv,timeouts,tags}.ts`; `e2e/src/harness/{ports,isolatedRun,devStack,desktopArtifacts,appLaunch,launchEnv,readiness,artifacts,processSpawn,log,env,testFixtures}.ts`; `e2e/src/flows/{shell,onboarding}.ts`; `e2e/tests/{smoke,settings,agent}/*.spec.ts`; `e2e/README.md`; `.agents/skills/e2e-test-author/SKILL.md`; `docs/specs/2026-06-24-e2e-testing-foundation-design.md`.

**Modified (surgical):** root `package.json` (devDep + 4 scripts); `.gitignore`; `.env.example`; `apps/electron/src/renderer/components/onboarding/OnboardingWizard.tsx` (+`id`); `apps/electron/src/renderer/App.tsx` (+`id`); optionally `WorkspacePicker` (+`id`); `docs/specs/index.md` + `log.md`.

**Reuse / mirror (do not re-invent):** Vite spawn + env shape from `scripts/electron-dev.ts` (`getElectronEnv` 276-292, Vite spawn 540-548, `loadEnvFile` 98-120); harness patterns from `/Volumes/EVO/dev/kata-code/e2e/src/harness/*`; build via existing `bun run ensure:electron` + `bun run electron:build`.

## Build prerequisites (before first run)
```bash
bun run ensure:electron
bun run electron:build   # produces dist/main.cjs + dist/bootstrap-preload.cjs
```

## Follow-up issues to file (deferred work, per AGENTS.md)
- Parallel isolation: allocate/override subprocess server ports (RPC ~9100) so `workers > 1` is safe.
- macOS CI runner strategy before any CI adoption.
- Real `desktop-release` validation once a packaged `.app` path is standardized.
