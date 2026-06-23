---
type: VerifyReport
title: Complete Kata Brand Transition — Verify Report
description: Verify-phase UAT evidence and sign-off for the hard-cutover brand transition
tags: [rebrand, kata, verify-report, uat]
timestamp: 2026-06-23T00:00:00Z
---

# Complete Kata Brand Transition — Verify Report

## Spec

[2026-06-22-complete-kata-brand-transition-design.md](2026-06-22-complete-kata-brand-transition-design.md)

## Build report

[2026-06-22-complete-kata-brand-transition-build-report.md](2026-06-22-complete-kata-brand-transition-build-report.md)

## SHAs

| | SHA |
|---|-----|
| Base (Build final) | `2df966ff` |
| Quality review fixes | `7bef7cd7` |
| Merged PR #3 | `f9e13703` |
| Verify fixes (this report) | uncommitted on `main` |

## Verify summary

A full UAT pass was run against `f9e13703` (merged PR #3) on 2026-06-23. The first pass found **3 failing acceptance criteria** (AC 3, 9, 12) plus a blocked AC 6 (packaged metadata not inspected) and a minor AC 7 (inconsistent GitHub org refs). This report documents the fixes applied and the re-run results that close Verify.

## Failures found and fixed

1. **AC 9 / broken tool icon (functional defect)**: `apps/electron/resources/tool-icons/tool-icons.json` declared `"icon": "kata-agent.svg"` for the `kata-agent` tool, but only `craft-agent.svg` existed in source and the built `dist/resources/tool-icons/`. The Kata Agent tool icon was broken at runtime.
   - Fix: `git mv craft-agent.svg -> kata-agent.svg` so the JSON reference resolves.

2. **AC 9 / Craft-named brand assets**: `kata-logos/` still held four Craft-named PNGs (`craft_app_icon.png`, `craft_app_icon_dark.png`, `craft_logo_black.png`, `craft_logo_white.png`).
   - Fix: renamed each to its `kata_*` equivalent via `git mv`.

3. **AC 9 / dead Craft code**: `src/renderer/components/icons/CraftAppIcon.tsx` and its sole import `src/renderer/assets/craft_logo_c.svg` were never imported anywhere (dead code carrying Craft-named product-identity symbols).
   - Fix: `git rm` both files.

4. **AC 12 / filename residual scan**: the prior UAT ran a content-only residual scan that missed 7 Craft-named files. After the renames above, a filename scan (`rg --files | rg -i 'craft-cli|craft-agent|craft-server|craftagents|craft_logo|craft_app'`) returns **no matches**.

5. **AC 6 / packaged metadata (previously blocked)**: ran an unpacked `electron-builder --mac --arm64 --dir` build and inspected the generated `Info.plist`:
   - `CFBundleIdentifier` = `sh.kata.agents`
   - `CFBundleName` / `CFBundleDisplayName` = `Kata Agents`
   - No `craftagents`, `craft-agent`, `com.lukilinks.craft-agent`, or `agents.craft.do` in the packaged `Info.plist`.
   - The `kataagents://` scheme is registered at runtime via `app.setAsDefaultProtocolClient('kataagents')` (the existing pattern; no static `CFBundleURLTypes` declaration). This is not a regression from the rename and matches the pre-Craft-era architecture.

6. **AC 7 minor / GitHub org consistency**: `CONTRIBUTING.md`, `Dockerfile.server`, and the playground `browser-ui.tsx` registry referenced `github.com/lukilabs/kata-agents-oss`, inconsistent with the canonical `gannonh/kata-agents` owner used by the `electron-builder.yml` publish block.
   - Fix: reconciled all three to `gannonh/kata-agents`.

## Build-hygiene fix

`apps/electron/scripts/copy-assets.ts` used `cpSync` without cleaning the destination, so renamed assets (e.g. `craft-agent.svg` -> `kata-agent.svg`) left stale Craft-named files in `dist/resources/` and consequently in the packaged app. In a fresh CI checkout `dist/` is absent so this is clean, but local incremental builds shipped stale residuals.
- Fix: `copy-assets.ts` now `rmSync('dist/resources', { recursive: true, force: true })` before copying, so the destination mirrors the source exactly. This prevents stale renamed brand assets from shipping.

## Mock/test data cleanup

Two incidental "Craft Agents" strings remained in non-product-identity surfaces and were updated for cleanliness:
- `playground/registry/browser-ui.tsx`: a mock Notion URL slug `Craft-Agents-...` -> `Kata-Agents-...` (title was already "Kata Agents ...").
- `main/__tests__/browser-pane-manager.test.ts`: a search-query fixture `craft agents browser tools` -> `kata agents browser tools` (input + encoded-URL assertion updated together).

## Verification results

| Check | Result |
|-------|--------|
| `bun run lint:i18n:parity` | Pass (6 locales, 1466 keys each) |
| `bun run lint:i18n:sorted` | Pass |
| CLI help smoke (`bun run apps/cli/src/index.ts --help`) | Pass — `kata-cli — Terminal client for Kata Agent server`, no `Craft Agent` |
| Server startup smoke (`KATA_CONFIG_DIR=$(mktemp -d) KATA_RPC_PORT=19199`) | Pass — `Kata Agent server listening on ws://127.0.0.1:19199`, `KATA_SERVER_URL=...`, no `Craft Agent` |
| `feature-flags.test.ts` | 11 pass, 0 fail |
| `permissions-kata-agent-sync.test.ts` | 1 pass, 0 fail |
| `deep-link-routing.test.ts` | 3 pass, 0 fail (kataagents://) |
| `apps/electron && bun run typecheck` | Pass |
| Electron build (`bun run electron:build`) | Pass |
| Packaged `--dir` build (arm64) | Pass — `Kata Agents.app` produced |
| Packaged `Info.plist` identity | `sh.kata.agents` / `Kata Agents` |
| Packaged app Craft residual scan (excl. `_CodeSignature`) | No matches |
| Bundled `tool-icons/kata-agent.svg` present, no `craft-agent.svg` | Pass |
| Bundled `kata-logos/kata_*.png` present, no `craft_*.png` | Pass |
| Repo content residual scan | Only `LICENSE` (upstream attribution) + `release-notes/next.md` rename description (both allowlisted) |
| Repo filename residual scan | No matches |

## Acceptance criteria status

| AC | Status | Notes |
|----|--------|-------|
| 1 | Pass | No `Craft Agent(s)` in active content or packaged app; UI shows "Welcome to Kata Agents" |
| 2 | Pass | All packages `@kata-sh/*`; typechecks clean; `bun.lock` no `@craft-agent` |
| 3 | Pass | `kata-cli.md` bundled doc; `tool-icons.json` references existing `kata-agent.svg`; CLI help shows `kata-cli` |
| 4 | Pass | `CRAFT_` content scan no matches (migration scripts excluded as one-shot maps) |
| 5 | Pass | `~/.kata-agents` used; no active `.craft-agent` reads; `KATA_CONFIG_DIR` honored |
| 6 | Pass | Packaged `Info.plist` = `sh.kata.agents`; `kataagents://` runtime registration; no `craftagents://` |
| 7 | Pass | `agents.kata.sh` targets; `agents.craft.do` no matches; GitHub org refs reconciled to `gannonh/kata-agents` |
| 8 | Pass | Author `Gannon Hall <support@kata.sh>`; copyright `Gannon Hall`; LICENSE upstream Craft attribution retained |
| 9 | Pass | Bundled resources cleaned: `kata-agent.svg`, `kata-logos/kata_*.png`, dead `CraftAppIcon`/`craft_logo_c.svg` removed |
| 10 | Pass | i18n parity + sort pass (6 locales, 1466 keys) |
| 11 | Pass | All automated checks pass (typechecks, i18n, CLI help, server startup, electron build, targeted tests) |
| 12 | Pass | Content + filename scans report only allowlisted residuals (`LICENSE`, historical specs, migration scripts, release-notes rename description) |

## Residual Craft allowlist (final)

| Category | Examples | Rationale |
|----------|----------|-----------|
| Upstream attribution | `LICENSE` Craft Agents / Craft Docs Ltd. | Required Apache attribution |
| Historical completed specs | `docs/specs/rebrand-*.md`, `2026-06-19-ci-release-pipeline*.md`, design/build reports with quoted Craft-era slugs | Historical accuracy; do not rewrite completed docs |
| Migration tooling | `scripts/migrations/brand-transition-*.ts` | One-shot replacement maps |
| Release-notes rename description | `release-notes/next.md` mentions `craft-cli.md` -> `kata-cli.md` | Documents the change for users |

## Known follow-ups (out of scope for this spec)

- The unpacked `--dir` build includes the full `src/` tree in the app bundle (760 MB). This is a pre-existing `electron-builder` `files` config behavior unrelated to the rename; the production `build-dmg.sh` path produces a DMG/zip. Worth a separate cleanup pass to tighten the `files` globs and reduce bundle size.
- `bun run typecheck:all` root script may still fail on the missing root `tsconfig.base.json` (pre-existing per `AGENTS.md`); per-package `tsc --noEmit` is the workaround.
- A signed+notarized release DMG (real code-signing credentials) was not produced in this Verify pass; the ad-hoc-signed unpacked build suffices for identity/metadata verification. Full signed-release UAT belongs to the release pipeline.

## Sign-off

All 12 acceptance criteria pass. The Complete Kata Brand Transition spec moves from **Implemented** to **Completed**.
