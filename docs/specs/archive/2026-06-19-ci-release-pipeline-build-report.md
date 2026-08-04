---
type: Build Report
title: CI/Release Pipeline (Project B) — Build Report
description: Build completion report for the Project B CI/release pipeline spec — what was implemented, verification results, acceptance-criteria evidence, deviations, and follow-ups.
tags: [ci, release, github-actions, build-report, project-b]
timestamp: 2026-06-19T00:00:00Z
migrated: false
archived_at: 2026-08-04T16:24:02Z
status: Completed
---

> **Completed before migration** (status: Completed). Retained as history. Not tracked in GitHub Issues.

# Build Report — CI/Release Pipeline (Project B)

## Source

- Spec: [2026-06-19-ci-release-pipeline.md](2026-06-19-ci-release-pipeline.md) (Plan: Approved)
- Branch: `feat/ci-release-pipeline`
- Base SHA: `24c21a9cd19c11bf90f71d6ea2a9346ee2288c0b`
- Final build SHA (pre-docs commit): `87e20cffc3fb92814c7c54d0a7c1e4cf6e571d68`
- Execution mode: single-agent path (harness policy: no subagents unless
  requested). Independent subagent review was **not** used; spec-compliance and
  code-quality checks were performed inline. TDD: no `tdd`/`test-driven-development`
  skill was available; TDD best practices were followed (failing test first for
  each pure module, then implementation).

## Tasks completed (by phase)

1. **Phase 1 — green CI baseline** (`c852762`): created the missing root
   `tsconfig.base.json`; removed the `lint:i18n:coverage` gate (with rationale)
   and its dangling script ref; enabled `.github/workflows/ci.yml`; re-enabled
   `validate-server.yml`.
2. **Phase 2 — build/release config** (`09864f2`): removed dead
   `build`/`release`/`check-version` script refs; switched the desktop update
   feed to the `github` provider; added `scripts/build/release-config.ts`;
   taught `build-dmg.sh` to consume a generated config and dropped the dead
   `NOTARIZE` export.
3. **Phase 2b — runtime updater channel** (`646c515`): `update-channel.ts` +
   channel-aware `auto-update.ts` (`channel`/`allowPrerelease`, cross-channel
   guard, docstring fix).
4. **Phase 3 — release workflow** (`4caeb7c`): `release.yml` (release_meta,
   signing_gate, build matrix, release job) + ported Bun helpers
   (`resolve-nightly-release`, `update-release-package-versions`,
   `check-macos-release-signing`); `build-linux.sh`/`build-win.ps1` config
   override.
5. **Phase 4 — npm scaffold disabled** (`87e20cf`): `publish_cli` job guarded
   `if: false`.
6. **Phase 5 — docs** (this commit): `docs/operations/{ci,release}.md`, index/log
   updates, spec status → Implemented.

## Files changed

CI: `.github/workflows/ci.yml` (from `disabled/validate.yml`),
`.github/workflows/validate-server.yml` (re-enabled), `.github/workflows/release.yml`.
Build/release config: `package.json`, `tsconfig.base.json`, `.gitignore`,
`apps/electron/electron-builder.yml`, `apps/electron/scripts/build-dmg.sh`,
`build-linux.sh`, `build-win.ps1`, `scripts/build/release-config.ts`,
`scripts/release/*.ts`. Runtime updater: `apps/electron/src/main/auto-update.ts`,
`update-channel.ts`. Tests: `scripts/build/__tests__/release-config.test.ts`,
`scripts/release/__tests__/release-meta.test.ts`,
`apps/electron/src/main/__tests__/update-channel.test.ts`. Docs: `docs/operations/*`,
`docs/index.md`, `docs/log.md`, `docs/specs/index.md`, `docs/specs/log.md`,
and this report.

## Verification run locally

| Command | Result |
| --- | --- |
| `bun run validate:ci` | exit 0 (typecheck:all, test:shared:all, test:doc-tools, i18n parity, i18n sorted) |
| `bun test` (3 new suites) | 24 pass / 0 fail |
| `apps/electron` `bun run typecheck` | exit 0 (confirms `autoUpdater.channel`/`allowPrerelease`) |
| `tsc --noEmit` on `scripts/{build,release}/*.ts` | exit 0 |
| release_meta logic (local simulation, 4 trigger cases) | correct channel/version/tag/prerelease/make_latest |
| `release-config.ts` CLI vs real `electron-builder.yml` | stable→github release; nightly→prerelease+channel; appId preserved |
| signing gate CLI (secrets present/absent) | exit 0 / exit 1 as expected |
| All `.github/workflows/*.yml` | parse cleanly |

## Acceptance-criteria evidence

| AC | Status | Evidence |
| --- | --- | --- |
| AC1 `ci.yml` triggers + green | **Code complete; live check run pending** | Workflow authored (pull_request + push main, Bun 1.3.10, frozen install, Windows-illegal guard, validate:ci). A green check run on `main` requires pushing to GitHub (maintainer). |
| AC2 `validate:ci` exits 0, legs enumerated | **Done** | Runs green locally; `lint:i18n:coverage` removed with recorded rationale (see operations/ci.md). |
| AC3 single signed+notarized macOS command | **Code complete; live build pending** | `build-dmg.sh <arch>` produces dmg/zip/`*-mac.yml`; auto-notarizes from `APPLE_*`. A real signed+notarized run (codesign/spctl/stapler) needs Apple creds + macOS runner (maintainer / dry-run). |
| AC4 `release.yml` triggers + dry_run | **Code complete; dispatch pending** | Triggers + inputs present; `release`/`publish_cli` gated `if dry_run != true` / `if false`. dry-run dispatch evidence is maintainer-run. |
| AC5 stable release = latest + manifests | **Code complete; live release pending** | softprops with `make_latest=true`, `prerelease=false`, latest*.yml attached. Needs a live run. |
| AC6 nightly = prerelease + nightly*.yml | **Code complete; live release pending** | release_meta nightly path + generated `channel: nightly`/`prerelease`; softprops `prerelease=true`. Needs a live run. |
| AC7 publish config = github (build-time) + softprops + no agents.craft.do feed | **Done (config) / live attach pending** | `release-config.ts` resolves github+releaseType+channel (tested); static feed switched off agents.craft.do; upload via softprops, not `--publish`. Bundled `app-update.yml` content verified by config inspection. |
| AC8 runtime channel + allowPrerelease + ignore off-channel | **Done** | `auto-update.ts` sets `channel`/`allowPrerelease` and guards `update-available`; `update-channel.ts` unit-tested. |
| AC9 release job `contents: write` | **Done (declared); live create pending** | Job-level `permissions: contents: write` present; live release create is maintainer-run. |
| AC10 npm publish job skipped | **Done** | `publish_cli` `if: false` — always skipped; nothing published. |
| AC11 secrets ops guide | **Done** | `docs/operations/release.md` enumerates every secret with source/setup. |
| AC12 no identity-infra changes beyond feed | **Done** | Diff confined to allowlisted surfaces; appId/scheme/config-dir/scopes/env/auth-domain unchanged (the only `@craft-agent`/`appId`/`agents.craft.do` strings in the diff are a forward-looking comment and test fixtures asserting preservation). |

## Evidence when a live release cannot be produced

The Build agent's environment has no configured GitHub repo secrets, no macOS
signing keychain, and cannot run the multi-minute notarized build / live
release. Per the spec's substitute-evidence clause, AC1, AC3, AC4 (dry-run),
AC5, AC6, AC7 (live attach), and AC9 require **maintainer execution**:

1. Configure the repository secrets in `docs/operations/release.md`.
2. Run `release.yml` via `workflow_dispatch` with `dry_run=true` (validates
   build+sign+notarize, AC3/AC4 path) — expect green, no release created.
3. Run `channel=stable` (AC5) and `channel=nightly` (AC6) dispatches; inspect
   the resulting releases for assets + `latest*.yml`/`nightly*.yml`, prerelease
   flags, and a built app's `app-update.yml` (AC7).

## Deviations from the plan

- **`lint:i18n:coverage` removed** (user-approved): no coverage spec/model
  existed and a scanner would be high-false-positive. Rationale recorded in
  `docs/operations/ci.md`. (Spec AC2 explicitly permits dropping this one gate
  with rationale.)
- **`resolve-previous-release-tag.ts` not ported**: no AC requires it; the
  release uses softprops `generate_release_notes` for changelogs instead.
- **Nightly product name** `Kata Agents (Nightly)` is applied via the generated
  config. The dead `scripts/build/darwin.ts` packager (which hardcodes
  `Kata Agents.app`) is not on the live build path (`build-dmg.sh`), so this is
  safe; that orphaned packager was left untouched (surgical scope).

## Known follow-ups

- Live release verification (above) by the maintainer.
- Windows/Linux are unsigned best-effort (`continue-on-error`); they may need
  SDK-staging hardening if promoted to a required, channel-correct gate.
- Re-introduce an i18n coverage check with defined semantics (deferred).
- Project C will enable the `publish_cli` job and the scope/env rename.
