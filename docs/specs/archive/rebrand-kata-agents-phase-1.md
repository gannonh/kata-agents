---
type: Spec
title: Rebrand Kata Agents — Phase 1 (user-facing)
description: Scope, decisions, change set, and verification plan for renaming Craft Agents to Kata Agents in all user-visible surfaces while preserving identity infrastructure.
tags: [rebrand, kata, phase-1, implemented]
timestamp: 2026-06-19T00:00:00Z
migrated: false
archived_at: 2026-08-04T16:24:02Z
status: Completed
---

> **Completed before migration** (status: Completed). Retained as history. Not tracked in GitHub Issues.

# Rebrand fork to "Kata Agents" — Phase 1 (user-facing)

## Status

- **Plan**: Approved (user decisions captured below).
- **Build**: Implemented (2026-06-19). See
  `docs/specs/rebrand-kata-agents-phase-1-build-report.md`.
- **Verify**: Pending runtime/dev-run + packaged-build acceptance.

## Context
This repo is a fork of **Craft Agents** (`craft-agent`), an Electron desktop app + supporting
CLI/web/server packages. We are rebranding the fork to **Kata Agents**. Phase 1 covers
**user-facing surfaces only**: the displayed product name and the app icons. The liquid-glass
Kata icon assets already exist in a sibling project at
`/Volumes/EVO/dev/kata-code/apps/desktop/resources` and will be copied in.

## Decisions (from user)
- **Scope: visible name + icons only.** Do NOT change identity infra — keep `appId`
  (`com.lukilabs.craft-agent`), deep-link scheme (`craftagents://`), config dir
  (`~/.craft-agent`), npm scopes (`@craft-agent/*`), env vars (`CRAFT_*`), and the
  `agents.craft.do` publish/viewer URLs. This preserves auto-update continuity, code-signing
  identity, and existing user data.
- **Rebrand all visible "Craft" references → "Kata"**, including the product name
  (`Craft Agents`/`Craft Agent` → `Kata Agents`/`Kata Agent`) and standalone prose/labels.
- **Keep legal/org**: `Craft Docs Ltd.`, author, Linux maintainer, `support@craft.do`.

## Must-keep exceptions (functional identifiers, not free text)
These are visible-ish but tied to retained infra; changing them breaks behavior:
- `{source:Craft}` hint tokens (`hints.reviewGitHubPRs`, `hints.summarizeGmail`) — the token
  resolves to the connected **Craft source**. Keep `{source:Craft}` verbatim.
- `CRAFT_SERVER_TOKEN` in `transport.authFailed` — env var name. Keep.
- `~/.craft-agent`, `.craft-agent` paths in settings/workspace strings — keep the literal path
  (config dir unchanged); only adjust surrounding product-name prose.
- `bun run fresh-start` command text in `menu.resetToDefaultsDetail` — keep the command.

## Flagged (rebranding visible label, infra unchanged underneath)
Doing these per "rebrand everything," but note the backend still authenticates against Craft:
- `onboarding.reauth.loginWithCraft` ("Log In with Craft"), `onboarding.reauth.expired`
  ("Your Craft session…") — auth still hits `agents.craft.do`. Cosmetic relabel only.
- `editPopover.example.addSource` ("Connect to my Craft space") — example prompt referencing
  the Craft document platform.
- `auth/oauth.ts` `CLIENT_NAME = 'Claude Code (Craft Agent)'` — shown on Anthropic's OAuth
  consent screen. Relabel the parenthetical to `(Kata Agent)`.

---

## Change set

### 1. App identity strings (code/config)
- `apps/electron/electron-builder.yml`: `productName: Kata Agents` (line 2); `artifactName`
  for mac/dmg/win/linux → `Kata-Agents-${arch}…` (lines 125, 133, 158, 201); dmg `title:
  "Kata Agents"` (line 139). **Keep** `appId` (1), `copyright` (3), `maintainer` (196),
  `publish.url` (79).
- `apps/electron/scripts/afterPack.cjs:29`: `'Craft Agents.app'` → `'Kata Agents.app'`.
  **Functional** — the bundle dir name follows `productName`; the Liquid-Glass `Assets.car`
  copy targets this path.
- `apps/electron/src/main/index.ts:229`: `app.setName(... || 'Kata Agents')` (keep
  `CRAFT_APP_NAME` env override).
- `apps/electron/src/main/menu.ts:82`: `label: 'Kata Agents'`. Update comments at 19/43/53.
- `apps/electron/src/renderer/index.html:7`: `<title>Kata Agents</title>`.
- `apps/electron/src/main/window-manager.ts`: update comments at ~164/302 (cosmetic).

### 2. i18n values — all 7 locales
Locale files: `packages/shared/src/i18n/locales/{en,de,es,hu,ja,pl,zh-Hans}.json`.
Per `packages/shared/CLAUDE.md`, brand names stay in English in every locale, so the brand
substring is identical across all 7 files.
- **Change values only; do NOT rename keys** (key names like `menu.aboutCraftAgents` are
  internal; renaming them would force callsite + coverage-check churn — out of scope for a
  visible-only pass).
- Replace `Craft Agents`/`Craft Agent` → `Kata Agents`/`Kata Agent` and standalone product
  `Craft` → `Kata` across the affected values: `menu.aboutCraftAgents`, `menu.hideCraftAgents`,
  `menu.quitCraftAgents`, `menu.craftMenu`, `menu.resetToDefaultsDetail` (keep command),
  `browser.safetyHint`, `errors.failedToLoadSessionsDesc`, `onboarding.*` (welcome.title,
  providerSelect.title/desc, apiSetup.*, credentials.*, gitBash.description, reauth.*),
  `settings.preferences.*`, `workspace.connectRemoteDesc`, `editPopover.example.addSource`.
- **Keep verbatim**: `{source:Craft}` tokens, `CRAFT_SERVER_TOKEN`, `~/.craft-agent` /
  `.craft-agent` paths in `settings.appearance.toolIconsDesc`,
  `settings.permissions.noDefaultPermissionsDesc`, `workspace.underDefaultFolder`.
- Run i18n validation after (see Verification) to guarantee sort + parity.

### 3. Branding module
- `packages/shared/src/branding.ts`: header comment → Kata; replace the `CRAFT_LOGO` ASCII art
  (currently spells "CRAFT", shown on OAuth callback pages) with a "KATA" rendering. **Keep
  export name `CRAFT_LOGO`/`CRAFT_LOGO_HTML`** (importers; internal). **Keep** `VIEWER_URL`.
  Note: the ASCII art must be hand-drawn for "KATA".

### 4. OAuth consent label
- `packages/shared/src/auth/oauth.ts:29`: `CLIENT_NAME = 'Claude Code (Kata Agent)'`.

### 5. App icons — copy from `/Volumes/EVO/dev/kata-code/apps/desktop/resources`
Target: `apps/electron/resources/`.
- Overwrite raster/vector: `icon.icns`, `icon.ico`, `icon.png`, `icon.svg`, `source.png`.
- Overwrite `Assets.car` with Kata's **pre-compiled Liquid-Glass** `Assets.car` (~410 KB).
  Because it is already compiled, no `actool`/macOS-26-SDK step is required — `afterPack.cjs`
  just copies this file into the bundle.
- Replace the `icon.icon/` icon set: use Kata's `liquid-glass/AppIcon.icon/icon.json` (layer =
  `kanji.png`, scale 0.64) and add `icon.icon/Assets/kanji.png`; remove the old
  `icon.icon/Assets/icon.svg` layer. **Keep the dir name `icon.icon`** so no electron-builder /
  afterPack references change (`CFBundleIconName: AppIcon` is unaffected).
- **Not provided by Kata assets — flag as follow-up**: `dmg-background.tiff` /
  `dmg-background.png` / `@2x` in the working repo may still carry Craft visuals. No Kata DMG
  background exists in the source; leave existing files and note that a Kata DMG background is a
  separate design deliverable.

### 6. Docs (product name only)
- `README.md`, `CONTRIBUTING.md`: product references `Craft Agents` → `Kata Agents`.
- **Keep** `TRADEMARK.md`, `SECURITY.md` legal notices and `Craft Docs Ltd.` ownership
  (legal — out of scope this phase).
- Root `package.json` `description` ("Claude Code-like agent for Craft documents") references
  the Craft document integration, not the product name — leave as-is (not user-visible).

---

## Verification
1. **i18n gates**: `bun run validate:ci` (runs `lint:i18n:sorted`, `lint:i18n:parity`,
   `lint:i18n:coverage`). Must pass — confirms all 7 locales edited consistently and no key was
   accidentally renamed.
2. **Type check**: `cd packages/shared && bun run tsc --noEmit`; `cd apps/electron` type check.
3. **Dev run** (`scripts/electron-dev.ts`): confirm window title = "Kata Agents", macOS app menu
   shows "Kata Agents" with "About/Hide/Quit Kata Agents", onboarding welcome title, and the
   dock icon = the new liquid-glass kanji mark.
4. **Packaged macOS build** (`scripts/build/darwin.ts`): produces `Kata-Agents-arm64.dmg`;
   verify the bundle is `Kata Agents.app`, afterPack log shows "Liquid Glass icon copied", and
   Finder/dock render the Kata icon. DMG window title = "Kata Agents".
5. **OAuth surfaces** (spot check): callback page shows the KATA ASCII logo; Anthropic consent
   screen shows "Claude Code (Kata Agent)".

## Out of scope (later phases)
Bundle `appId`, `craftagents://` scheme, `~/.craft-agent` config dir + migration, `@craft-agent`
package scopes, `CRAFT_*` env vars, `agents.craft.do` publish/viewer/auth domains, legal entity
rename, the `{source:Craft}` integration, and a Kata-branded DMG background.
