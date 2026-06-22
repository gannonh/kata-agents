---
type: BuildReport
title: Rebrand Kata Agents — Phase 1 (Build completion report)
spec: docs/specs/rebrand-kata-agents-phase-1.md
base_sha: 2dbb3edd247fb593199c1f566ed699778e6ad88d
head_sha: 9154155d4cf20ecde740efb00251ed30030e2b41
timestamp: 2026-06-19
---

# Build completion report — Rebrand Kata Agents Phase 1

## Summary

Implemented the Phase 1 rebrand of user-visible "Craft Agents" / "Craft
Agent" / "Craft" strings to "Kata" across the Electron desktop app and
`@craft-agent/shared`, plus the Kata liquid-glass icon asset swap and
README/CONTRIBUTING product-name update. Identity infrastructure (appId,
`craftagents://` scheme, `~/.craft-agent` config dir, `@craft-agent` npm
scopes, `CRAFT_*` env vars, `agents.craft.do` publish/viewer/auth
domains, `Craft Docs Ltd.` legal) is unchanged.

## Tasks completed

1. App identity strings (code/config): `electron-builder.yml`,
   `afterPack.cjs`, `main/index.ts`, `main/menu.ts`, `main/window-manager.ts`,
   `renderer/index.html`, and build-script echo lines
   (`build-dmg.sh`, `build-linux.sh`, `build-win.ps1`).
2. i18n values across all 7 locales (`de`, `en`, `es`, `hu`, `ja`, `pl`,
   `zh-Hans`): values only, keys unchanged.
3. `branding.ts`: KATA ASCII logo; `CRAFT_LOGO` / `CRAFT_LOGO_HTML` /
   `VIEWER_URL` preserved.
4. `oauth.ts`: `CLIENT_NAME = 'Claude Code (Kata Agent)'`.
5. Kata app icon assets copied into `apps/electron/resources/`
   (raster/vector + pre-compiled `Assets.car` ~410 KB + `icon.icon`
   kanji layer, old `icon.svg` layer removed).
6. README.md and CONTRIBUTING.md product-name prose updated; trademark
   line and `TRADEMARK.md` / `SECURITY.md` / `LICENSE` kept.

## Approved scope extension

The spec's enumerated change set did not list user-visible **hardcoded**
Craft strings outside i18n/branding. The user approved extending the
rebrand to them ("rebrand all visible Craft references"). Files added
under this extension:

- Renderer source: model picker (`model-picker-helpers.ts` + tests),
  `AiSettingsPage.tsx`, `lib/provider-icons.ts`, onboarding
  (`WelcomeStep`, `OnboardingWizard`, `ReauthScreen`), app-menu
  components (`DesktopAppMenu`, `MobileAppMenu`, `types`, `AppMenu`),
  `SplashScreen`, `EditPopover`, `TopBarButton`, `ApiKeyInput`,
  `AddWorkspaceStep_ConnectRemote`, `useNotifications`, `browser-pane`,
  icon components, `menu-schema.ts`.
- Shared package agent identity surfaced to the LLM and the user:
  `prompts/system.ts` (agent self-identity "You are Kata Agent",
  refer-to-self instruction, git `Co-Authored-By` trailer display name,
  CLI section heading, developer-feedback line, doc-table CLI label),
  `agent/pi-agent.ts` (`backendName` x2, desktop-app hint),
  `agent/diagnostics.ts` (`pi_compat` label), `agent/errors.ts`
  (reinstall error x1), `agent/claude-agent.ts` (reinstall error x1),
  `sources/builtin-sources.ts` (Kata Agents Docs source name/tagline;
  `id`/`slug` identifiers kept), `auth/callback-page.ts` (OAuth
  callback page title + return-link text), `unified-network-interceptor.ts`
  (request-blocked messages), `config/models-pi.ts`, `config/storage.ts`
  (description strings).
- Test fixtures/assertions refreshed to match the rebranded strings:
  `prompts/__tests__/system.test.ts`, `agent/__tests__/claude-agent-spawn-cwd.test.ts`,
  `config/__tests__/storage-startup-migration.test.ts`,
  `renderer/components/app-shell/input/__tests__/model-picker-helpers.test.ts`,
  `renderer/src/main/__tests__/browser-pane-manager.test.ts`,
  `main/handlers/__tests__/browser-broadcast.test.ts`.

## Files changed

62 files across 6 commits:

```
d359f79 feat(electron): rebrand app identity strings to Kata Agents
8ba05e7 feat(i18n): rebrand visible Craft strings to Kata across 7 locales
b135769 feat(shared): rebrand branding, OAuth label, and agent identity to Kata
aca2896 feat(renderer): rebrand visible Craft strings to Kata in UI sources
526665e feat(electron): replace app icons with Kata liquid-glass assets
9154155 docs: rebrand product name to Kata Agents in README and CONTRIBUTING
```

## Verification run

| Gate | Command | Result |
|------|---------|--------|
| i18n parity | `bun run lint:i18n:parity` | PASS — "i18n parity OK (6 locales, 1436 keys each)" |
| i18n sort | `bun run lint:i18n:sorted` | PASS — no diff |
| i18n JSON validity | `python3 json.load` per locale | PASS — all 7 valid, 2-space indent |
| shared typecheck | `cd packages/shared && bun run tsc --noEmit` | PASS (exit 0) |
| electron typecheck | `cd apps/electron && bun run typecheck` | PASS (exit 0) |
| shared tests | `cd packages/shared && bun test` | PASS — 2891 pass / 12 skip / 0 fail |
| model-picker test | `bun test .../model-picker-helpers.test.ts` | PASS — 18/18 |
| storage migration test | `bun test .../storage-startup-migration.test.ts` | PASS — 15/15 |
| system prompt test | `bun test .../system.test.ts` | PASS |
| electron test suite | `bun test apps/electron` | 808 pass / 10 fail (PRE-EXISTING) |
| branding render | `bun -e` import + print `CRAFT_LOGO_HTML` | KATA logo renders; `VIEWER_URL` preserved |

## Review gates completed

- **Spec compliance review** (subagent `reviewer`): PASS on all five
  criteria (protected tokens preserved, identity infra unchanged, 7
  locales consistent with keys/sort/parity, README/CONTRIBUTING + legal
  preserved, icon assets match Kata ~/icons spec).
- **Code quality review** (subagent `reviewer`): PASS — no JSON/TS
  regressions, test/impl consistency verified, brand strings consistent
  across all surfaces, build scripts only changed echo/log lines.

Both reviews surfaced the shared-package agent-identity scope gap
(prompt self-identity, `backendName`, diagnostics/errors, built-in
source name) which was then fixed in this Build under the approved
scope extension and re-verified.

## Approved deviations

1. **Scope extension to hardcoded user-visible strings** — spec's
   enumerated change set did not list renderer/shared/source string
   literals; user approved extending per "rebrand all visible Craft
   references."
2. **Playground demo/seed-data strings left unchanged** —
   `apps/electron/src/renderer/playground/demos/**` and
   `playground/registry/**` are dev fixtures; out of scope.

## Known issues / follow-ups

- **`lint:i18n:coverage` script is broken on base SHA** —
  `scripts/check-i18n-coverage.ts` does not exist (pre-existing, not
  introduced by this rebrand). `AGENTS.md` claims `validate:ci` checks
  coverage; it cannot. Separate follow-up.
- **`tsconfig.base.json` missing at repo root** — causes
  `typecheck:all` / `validate:dev` / `validate:ci` to fail on base SHA
  (pre-existing). Per-package `tsc --noEmit` for `packages/shared` and
  `apps/electron` (the spec's Verification step 2 targets) pass clean.
- **10 pre-existing `BrowserPaneManager` / RPC-handler test failures**
  in `apps/electron` — fail identically on base SHA; Electron
  window-mocking/toolbar-load timing issues, unrelated to rebrand.
- **`packages/shared/CLAUDE.md` lines 4 and 104** still document the
  i18n rule with "Craft / Craft Agents" brand names. The spec did not
  list this file; minor stale cross-reference worth a follow-up edit.
- **Kata DMG background not provided** —
  `apps/electron/resources/dmg-background.tiff` / `.png` / `@2x` still
  carry Craft visuals. Explicitly flagged as out of scope in the spec;
  separate design deliverable for a later phase.
- **`README.md:595` Windows install path** has a pre-existing typo
  `@craft-agentelectron` (missing slash), independent of the rebrand.
- **Out-of-scope `Craft` in code** (internal class/function names like
  `CraftOAuth`, `isCraftAgentsCliEnabled`, `SearchCraftAgents`,
  `getCraftAgentReadOnlyBashPatterns`; `CraftAgentEvent`;
  `User-Agent: CraftAgents/<ver>` HTTP headers; JSDoc/code comments)
  intentionally preserved as functional identifiers per the spec's
  keep-functional-identifiers decision.

## Independent subagent review

Yes — two `reviewer` subagents dispatched in parallel (spec compliance +
code quality); both PASS. Scope gap they flagged was resolved and
re-verified within this Build.

## Status

Spec `docs/specs/rebrand-kata-agents-phase-1.md` status updated from
`in-progress` to `Implemented`. Verification steps 1 (i18n gates that
can run), 2 (shared + electron typecheck), and 5 (OAuth surfaces via
callback-page.ts + CLIENT_NAME) are satisfied by code-level evidence.
Steps 3 (dev run) and 4 (packaged macOS build) require a runtime/desktop
environment and are recommended for a Verify pass.
