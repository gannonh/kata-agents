---
name: e2e-test-author
description: Author or modify local Playwright + real-Electron E2E tests for Kata Agents. Use when adding @smoke/@settings/@agent specs, harness modules, or product flows under e2e/, or when wiring stable id selectors into renderer code for E2E.
---

# E2E test author (Kata Agents)

Author local, macOS-first Playwright tests that launch the real Electron app.
Read [`e2e/README.md`](../../../e2e/README.md) first.

## Rules

- **Real services only.** No `route().fulfill()`, MSW, or fake backends in specs.
- **Playwright owns Electron.** The harness starts Vite only; never call
  `electron:dev` from a test or harness module.
- **id-based selectors for shell state.** Use `#root`, `#onboarding-wizard`,
  `#app-ready`, `#workspace-picker`. For in-product controls prefer stable
  roles/text (`getByRole`, `getByText`) or existing `data-tutorial` hooks; add a
  new stable `id`/attribute to product code only as a deliberate, minimal
  contract.
- **Fail loud.** Missing prerequisites (build artifacts, provider key, release
  app path) must throw with the variable name and a pointer to `e2e/README.md`.
  Never silently skip an assertion.
- **Keep layers separate.** `tests → fixtures → harness`, `tests → flows`,
  `flows → harness`. Never import flows from harness. The fixtures layer
  (`e2e/src/fixtures/`) is the composition root that wires flows into the
  launch pipeline; harness modules stay product-selector-free.

## Where things go

| Need | File |
|---|---|
| New test | `e2e/tests/<tier>/<name>.spec.ts`, tagged `@smoke` / `@settings` / `@agent` |
| Shell wait | `e2e/src/flows/shell.ts` |
| Onboarding step | `e2e/src/flows/onboarding.ts` |
| Settings step | `e2e/src/flows/settings.ts` |
| Agent chat step | `e2e/src/flows/agentChat.ts` |
| Launch/process/isolation | `e2e/src/harness/*` |
| Playwright fixtures (composition root) | `e2e/src/fixtures/testFixtures.ts` |
| Launch-health assertion | `e2e/src/assertions/appAssertions.ts` |

## Fixtures

- `appWindow` — launched app, `#root` mounted. Use for `@smoke`.
- `authenticatedAppWindow` — deferred-setup → ready shell. Use for `@settings`.
- `@agent` drives real API-key onboarding in-test (it needs to reach ready with
  a configured provider, not deferred setup).

## Reaching app states

Boot is driven by `getSetupNeeds()`:
- fresh temp config dir → **onboarding** (`#onboarding-wizard`).
- deferred setup (the wizard "Setup later" button) → **ready** (`#app-ready`),
  possibly via **workspace-picker** (`#workspace-picker`).

## Authoring an @agent test

1. Drive `completeApiKeyOnboarding` (provider select → "I use other provider" →
   fill the "API Key" textbox → Continue → "Get Started").
2. `startNewSession` to mount the composer (`[data-tutorial="chat-input"]`).
3. `selectModel` — the onboarding default model can be stale and 404; pick a
   current registry model from the composer dropdown.
4. Send a unique deterministic prompt and assert the token appears **at least
   twice** (the prompt echo plus the real reply) to avoid a false pass on the
   echoed prompt.

## Validate before codifying selectors

Run headed (`bun run e2e:headed --grep <tag>`) and read the failure
`error-context.md` page snapshot to confirm real labels/roles before hardcoding
them. Wizard copy and model lists change.

## Verify

```bash
bun run e2e --list
bun run e2e --grep @smoke      # offline
bun run e2e --grep @settings
bun run e2e --grep @agent      # needs provider key in .env
```
