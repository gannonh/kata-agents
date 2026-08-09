---
name: release-kata-agents
description: >
  Runbook for releasing Kata Agents desktop builds to GitHub Releases.
  Use this skill whenever the user asks to release, ship, publish, cut a release,
  run a release workflow, do a nightly, do a nightly dry run, do a stable release,
  or anything about releasing or publishing Kata Agents. Covers the full sequence:
  Nightly Dry Run → Nightly Release → Stable Dry Run → Stable Release. Dispatches
  the release.yml workflow, polls for status, verifies results at each stage, and
  knows exactly what a passing run looks like vs. a real failure.
---

# Release Runbook — Kata Agents

## Overview

Releases are published to https://github.com/gannonh/kata-agents/releases via
`.github/workflows/release.yml`. The workflow has three triggers:
- **`schedule`** — automatic nightly every 3 hours; only proceeds when `main` has
  changed since the last nightly tag (see `check_changes` job); no input needed
- **`workflow_dispatch`** — manual dispatch with `channel` (stable|nightly),
  `version` (required for stable, ignored for nightly), and `dry_run` (true|false)
- **Tag push** — pushing a `v*.*.*` tag (excluding `v*-nightly.*`) triggers a
  stable release automatically

**Recommended order for a new release cycle:**
1. Nightly Dry Run
2. Nightly Release
3. Stable Dry Run
4. Stable Release

You do not have to run all four. A dry-run failure is expected to be fixed before proceeding.

---

## Release notes (automated)

The in-app What's New overlay reads versioned files at
`apps/electron/resources/release-notes/<version>.md`. PRs accumulate pending
bullets in `next.md`, and the workflow promotes them automatically —
**no manual promotion commit is needed before dispatching.**

- `build` (both channels) writes `<core-version>.md` into the CI checkout only,
  so nightly bundles the pending notes for the upcoming version. Nothing is
  committed, so a cycle that later ships as a minor bump leaves no ghost file.
- `finalize` (stable, non-dry-run) writes `<version>.md` and resets `next.md`
  on `main` inside the `chore(release): prepare v<version>` commit.
- `release_meta` (stable) fails fast only when there is nothing to ship:
  no bullets in `next.md` *and* no existing `<version>.md`.

Nightly and stable of the same core version produce the identical filename
(`0.10.11-nightly.20260622.40` → `0.10.11.md`), so users who saw the notes on
nightly are not re-prompted when stable ships.

Optional: to give a stable release a human summary instead of the bare
`# v<version>` header, pre-create `<version>.md` with a
`# v<version> — <summary>` title — promotion preserves that title and merges the
pending bullets under it.

---

## Pre-flight checks

Before dispatching any release:

```bash
# Confirm main is clean and pushed
git status
git log origin/main..HEAD  # should be empty

# Check current development version in electron package (the nightly target
# is computed as X.Y.(Z+1) from this value; stable dispatch uses the version
# input instead)
bun --print "require('./apps/electron/package.json').version"

# Confirm secrets are configured
gh secret list --repo gannonh/kata-agents
# Required: CSC_LINK, CSC_KEY_PASSWORD, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD,
#           APPLE_TEAM_ID, APPLE_SIGNING_IDENTITY
```

### Stable-only: confirm there are notes to ship

Promotion is automatic, but a stable release still fails in `release_meta` when
there is nothing to promote. Verify locally with the same check the workflow
runs:

```bash
version=0.10.7  # the version you are about to release
bun run scripts/release/promote-release-notes.ts --version "$version" --check
```

If it fails, the pending changes were never written up — append the
user-visible bullets to `apps/electron/resources/release-notes/next.md` and push
before dispatching. Nightly dispatches skip this check entirely.

---

## Dispatch commands

```bash
# Nightly runs automatically on schedule. To trigger one manually:

# Nightly Dry Run
gh workflow run release.yml --repo gannonh/kata-agents \
  --field channel=nightly --field dry_run=true

# Nightly Release
gh workflow run release.yml --repo gannonh/kata-agents \
  --field channel=nightly --field dry_run=false

# Stable Dry Run (version is required for stable)
gh workflow run release.yml --repo gannonh/kata-agents \
  --field channel=stable --field version=0.10.4 --field dry_run=true

# Stable Release (dispatch — version is required)
gh workflow run release.yml --repo gannonh/kata-agents \
  --field channel=stable --field version=0.10.4 --field dry_run=false

# Stable Release (tag push — alternative to dispatch)
git tag v0.10.4 && git push origin v0.10.4
```

For **stable dispatch**, the `version` input is the source of truth. It may be
`0.10.4` or `v0.10.4`; the leading `v` is stripped and the tag becomes `v<version>`.
The `version` input is required — stable dispatch without it fails the `release_meta`
job. Stable dispatch no longer reads `apps/electron/package.json`.

For **nightly**, the version is computed automatically as
`X.Y.(Z+1)-nightly.YYYYMMDD.N` from the current `apps/electron/package.json` version.
This applies to both the scheduled run and any manual `channel=nightly` dispatch.

---

## Polling for status

After dispatching, get the run ID and watch it:

```bash
# Get the most recent run
gh run list --repo gannonh/kata-agents --workflow=release.yml --limit 3

# View a specific run (replace RUN_ID)
gh run view RUN_ID --repo gannonh/kata-agents

# Fetch logs for a failed job (replace JOB_ID)
gh api repos/gannonh/kata-agents/actions/jobs/JOB_ID/logs | tail -80
```

The workflow has these jobs: `check_changes` (scheduled only) → `release_meta` →
`signing_gate` → `build` (matrix) → `release` → `finalize` (stable only) → `publish_cli` (disabled).
- `check_changes` is skipped on non-schedule events
- `build` has four matrix legs: `macos-14 arm64` (required), `macos-14 x64` (required),
  `ubuntu-latest linux x64` (best-effort, `continue-on-error`), `windows-latest win x64` (best-effort)
- The `release` job only runs when `dry_run != true`
- `finalize` runs only for successful, non-dry-run **stable** releases and
  commits the version bump back to `main` (see below)

---

## What to verify at each stage

### Dry Run (nightly or stable)
- All four build legs complete (macOS required; Linux/Windows best-effort)
- The `release` job is **skipped** (shown as `-` or not triggered)
- No new release appears at https://github.com/gannonh/kata-agents/releases
- No npm publish occurred

```bash
# Confirm no release was created
gh release list --repo gannonh/kata-agents --limit 5
```

### Nightly Release
- GitHub release is a **prerelease** (`is_prerelease=true`)
- Tag format: `v<X>.<Y>.<Z+1>-nightly.<YYYYMMDD>.<N>`
- Release is **not** marked latest
- Assets include: `Kata-Agents-arm64.dmg`, `Kata-Agents-x64.dmg`, `.zip` equivalents,
  `nightly-mac.yml`, `nightly.yml` (the auto-update manifests)

```bash
gh release view --repo gannonh/kata-agents <tag>
# Check: prerelease: true, assets list includes nightly*.yml
```

### Stable Release
- GitHub release is **not** a prerelease (`is_prerelease=false`)
- Marked **latest**
- Assets include: DMGs, ZIPs, `latest-mac.yml`, `latest.yml`

```bash
gh release view --repo gannonh/kata-agents <tag>
# Check: prerelease: false, latest: true, assets list includes latest*.yml
```

---

## Common failures and fixes

| Symptom | Cause | Fix |
|---|---|---|
| `GitHub Personal Access Token is not set` | electron-builder trying to auto-publish | Add `--publish never` to the electron-builder invocation in the build script |
| `Release package manifest not found: D:\D:\...` | Windows path doubling from `.pathname` | Use `fileURLToPath(import.meta.url)` instead of `new URL(import.meta.url).pathname` |
| `signing_gate` fails | Missing Apple secrets | Run `gh secret list --repo gannonh/kata-agents` and add missing secrets from `.env` |
| macOS build fails after 10+ minutes | Notarization timeout or Apple service issue | Retry; notarization can be rate-limited |
| `Stable release <version> has no release notes` | `next.md` has no bullets and no `<version>.md` exists | Append the user-visible changes to `apps/electron/resources/release-notes/next.md`, push to `main`, then re-dispatch. Promotion itself is automatic. |
| `Could not push the post-release commit to main after 3 attempts` | `finalize` lost 3 rebase/push races, or `main` is protected | Re-run the `finalize` job; if it keeps failing, apply the version bump + notes promotion manually with `promote-release-notes.ts --version <v> --reset` |

---

## Secrets reference

All values are in `/Volumes/EVO/dev/kata-agents/.env`.

| Secret | Purpose |
|---|---|
| `CSC_LINK` | Base64 `.p12` signing cert |
| `CSC_KEY_PASSWORD` | `.p12` password |
| `APPLE_ID` | Notarization Apple ID |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for notarization |
| `APPLE_TEAM_ID` | Apple Developer team ID (`ZBZKKWF95G`) |
| `APPLE_SIGNING_IDENTITY` | Developer ID Application identity |
| `GITHUB_TOKEN` | Auto-provided by Actions — no setup needed. Also used by `finalize` to push the post-stable version bump + notes promotion to `main`, so repo Workflow permissions must be **Read and write** |

To re-set a secret from `.env`:
```bash
gh secret set SECRET_NAME --repo gannonh/kata-agents --body "value"
```

---

## After a successful release

1. Verify the release page looks correct at https://github.com/gannonh/kata-agents/releases
2. **Stable releases**: the `finalize` job automatically bumps
   `apps/electron/package.json` + `package.json` on `main` to the shipped
   version, promotes `next.md` → `<version>.md`, resets `next.md`, and commits
   `chore(release): prepare v<version>`, so the next nightly resolves to
   `X.Y.(Z+1)-nightly.*`. No manual bump or promotion needed. If `finalize`
   fails, apply both manually as a fallback and confirm the commit landed on
   `main` before the next stable.
3. Confirm the What's New overlay shows the new version in the shipped build.
4. Update `docs/specs/index.md` and `docs/log.md` if this release closes a project milestone
