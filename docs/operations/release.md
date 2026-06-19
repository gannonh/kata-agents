---
type: Operations
title: Release Pipeline
description: Nightly/stable desktop release pipeline for Kata Agents — channel model, GitHub Releases auto-update shape, dry-run usage, and required repository secrets.
tags: [release, github-actions, electron-updater, nightly, stable, signing, notarization]
timestamp: 2026-06-19T00:00:00Z
---

# Release Pipeline

`release.yml` builds, signs, and publishes the desktop app to GitHub Releases,
and the desktop auto-updater pulls per-channel updates from those releases.

## Triggers

| Trigger | Behavior |
| --- | --- |
| Push tag `v*.*.*` | Channel inferred from the tag: `…-nightly.*` → nightly prerelease; otherwise stable. |
| `workflow_dispatch` | Inputs `channel` (`stable` \| `nightly`) and `dry_run` (boolean). |

## Channel model

| Channel | Version format | Tag | GitHub Release | Update manifest |
| --- | --- | --- | --- | --- |
| stable | `X.Y.Z` | `vX.Y.Z` | `make_latest=true`, not prerelease | `latest.yml` / `latest-mac.yml` |
| nightly | `X.Y.(Z+1)-nightly.YYYYMMDD.N` | `vX.Y.(Z+1)-nightly.…` | prerelease, not latest | `nightly.yml` / `nightly-mac.yml` |

A nightly is a prerelease of the **next** patch, so it sorts above the current
stable release. The nightly version/tag are computed by
`scripts/release/resolve-nightly-release.ts` from `apps/electron/package.json`.

## Auto-update shape

* The electron-builder `publish` config uses `provider: github`. The bundled
  `app-update.yml` therefore points the updater at GitHub Releases.
* `scripts/build/release-config.ts` injects the per-channel publish block at
  build time: `releaseType: prerelease` + `channel: nightly` for nightly;
  `releaseType: release` (no channel → latest) for stable. It also sets the
  `Kata Agents (Nightly)` product name for nightlies. This governs the manifest
  filenames only; it does **not** upload.
* The GitHub Release and its assets are created by
  `softprops/action-gh-release@v2` (not `electron-builder --publish`), which
  controls the prerelease/latest flags.
* At runtime (`apps/electron/src/main/auto-update.ts`), the installed build's
  version selects its channel: nightly builds set
  `autoUpdater.channel = 'nightly'` + `allowPrerelease = true` and resolve
  `nightly*.yml`; everything else stays on `latest*.yml`. Updates whose version
  does not match the installed channel are ignored.

## Jobs

1. `release_meta` — resolves channel/version/tag/name/is_prerelease/make_latest/dry_run.
2. `signing_gate` (macOS) — fails fast if any signing secret is missing.
3. `build` — matrix: macOS arm64 + x64 **signed + notarized** (primary gate);
   Windows + Linux **unsigned best-effort** (`continue-on-error`). Each leg
   aligns versions, generates the per-channel config, builds via
   `apps/electron/scripts/build-{dmg.sh,linux.sh,win.ps1}`, and uploads
   dmg/zip/exe/AppImage/blockmap/`*.yml`.
4. `release` — `permissions: contents: write`; skipped when `dry_run=true`;
   creates the GitHub Release and attaches all collected assets.
5. `publish_cli` — **disabled** (`if: false`) in Project B; enabled in Project C.

## Dry run

Dispatch with `dry_run=true` to exercise the full build + sign + notarize path
without creating a release or publishing anything. The `release` and
`publish_cli` jobs are skipped.

## Required GitHub repository secrets

Set these under **Settings → Secrets and variables → Actions**. The macOS
signing values are exported from the kata-code `.env`
(`/Volumes/EVO/dev/kata-code/.env`).

| Secret | Purpose | Source / setup |
| --- | --- | --- |
| `CSC_LINK` | Base64-encoded `.p12` Developer ID signing certificate. electron-builder imports it into a temporary keychain in CI. | kata-code `.env`. To regenerate: `base64 -i cert.p12 \| pbcopy`. |
| `CSC_KEY_PASSWORD` | Password for the `.p12` in `CSC_LINK`. | kata-code `.env`. |
| `APPLE_ID` | Apple ID used for notarization. | kata-code `.env` (Apple Developer account). |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for the Apple ID (notarization). | Generate at appleid.apple.com → Sign-In and Security → App-Specific Passwords. |
| `APPLE_TEAM_ID` | Apple Developer team ID (`ZBZKKWF95G`). | kata-code `.env` / Apple Developer membership page. |
| `APPLE_SIGNING_IDENTITY` | Developer ID Application identity name (`Developer ID Application: …`). Used to pick the signing identity. | kata-code `.env`. |
| `GITHUB_TOKEN` | Create the release and upload assets. The release job grants `contents: write`. | Provided automatically by GitHub Actions — no manual setup; ensure repo Actions permissions allow write or rely on the job-level `permissions` block. |
| `CRAFT_ANTHROPIC_API_KEY` *(optional)* | `validate-server.yml` integration run. | Existing Anthropic API key. |
| `STITCH_API_KEY` *(optional)* | `validate-server.yml` integration run. | Existing. |
| `NPM_TOKEN` *(future, Project C)* | npm publish (the `publish_cli` job, disabled in B). | Add when enabling npm publishing. |

> Windows code-signing is deferred — no certificate is available, so Windows
> artifacts are unsigned best-effort.

## Verifying a signed macOS build

```sh
codesign -dv --verbose=4 "Kata Agents.app"      # shows the Developer ID identity
spctl -a -vvv -t install "Kata Agents.app"      # Gatekeeper assessment
xcrun stapler validate "Kata-Agents-arm64.dmg"  # notarization ticket stapled
```
