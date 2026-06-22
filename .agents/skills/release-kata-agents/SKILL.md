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
  `version` (optional — stable defaults to the latest nightly's version,
  ignored for nightly), and `dry_run` (true|false)
- **Tag push** — pushing a `v*.*.*` tag (excluding `v*-nightly.*`) triggers a
  stable release automatically

**Recommended order for a new release cycle:**
1. Nightly Dry Run
2. Nightly Release
3. Stable Dry Run
4. Stable Release

You do not have to run all four. A dry-run failure is expected to be fixed before proceeding.

---

## Pre-flight checks

Before dispatching any release:

```bash
# Confirm main is clean and pushed
git status
git log origin/main..HEAD  # should be empty

# Check current development version in electron package (the nightly target
# is computed as X.Y.(Z+1) from this value; stable derives its version from the
# latest nightly tag, or from the version input when provided)
bun --print "require('./apps/electron/package.json').version"

# Confirm secrets are configured
gh secret list --repo gannonh/kata-agents
# Required: CSC_LINK, CSC_KEY_PASSWORD, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD,
#           APPLE_TEAM_ID, APPLE_SIGNING_IDENTITY
```

### Stable releases require versioned release notes

A stable release **must** ship a `What's New` note for its version, or the
`release_meta` job fails immediately (on both dry run and real release):

```
::error::Stable release <version> is missing release notes at
apps/electron/resources/release-notes/<version>.md
```

Before a stable dry run or release, promote the accumulated `next.md` into the
versioned file and reset the accumulator:

```bash
# e.g. releasing 0.10.6
mv apps/electron/resources/release-notes/next.md \
   apps/electron/resources/release-notes/0.10.6.md
# Edit 0.10.6.md: replace the "Pending Release Notes" header with
# "# v0.10.6 — <title>" and drop empty sections.
# Recreate an empty next.md (Features/Improvements/Bug Fixes/Breaking Changes).
```

Commit and push this before dispatching. Nightlies do **not** need a versioned
note (they never promote `next.md`), so the gate only applies to stable.

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

# Stable Dry Run (version auto-derived from the latest nightly)
gh workflow run release.yml --repo gannonh/kata-agents \
  --field channel=stable --field dry_run=true

# Stable Release (dispatch — version auto-derived from the latest nightly)
gh workflow run release.yml --repo gannonh/kata-agents \
  --field channel=stable --field dry_run=false

# Stable Release with an explicit version (override the derived default)
gh workflow run release.yml --repo gannonh/kata-agents \
  --field channel=stable --field version=0.10.6 --field dry_run=false

# Stable Release (tag push — alternative to dispatch)
git tag v0.10.6 && git push origin v0.10.6
```

For **stable dispatch**, the `version` input is optional. When omitted, the
`release_meta` job derives the version from the **most recent nightly tag**
(its stable core, e.g. `v0.10.6-nightly.20260622.40` → `0.10.6`) — a stable
release always ships the version last validated on nightly, so you normally
never pass a version. Pass `version` (`0.10.6` or `v0.10.6`) only to override
the derived default; the leading `v` is stripped and the tag becomes
`v<version>`. If no version is given and no nightly tag exists, the job fails
fast. Stable dispatch does not read `apps/electron/package.json`.

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
- `release_meta` fails fast for **stable** when `apps/electron/resources/release-notes/<version>.md` is missing (runs on dry run + real)
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
| `Stable release <version> is missing release notes` | No `apps/electron/resources/release-notes/<version>.md` | Promote `next.md` to `<version>.md`, commit, push, re-dispatch (see Pre-flight) |
| `GitHub Personal Access Token is not set` | electron-builder trying to auto-publish | Add `--publish never` to the electron-builder invocation in the build script |
| `Release package manifest not found: D:\D:\...` | Windows path doubling from `.pathname` | Use `fileURLToPath(import.meta.url)` instead of `new URL(import.meta.url).pathname` |
| `signing_gate` fails | Missing Apple secrets | Run `gh secret list --repo gannonh/kata-agents` and add missing secrets from `.env` |
| macOS build fails after 10+ minutes | Notarization timeout or Apple service issue | Retry; notarization can be rate-limited |
| Linux/Windows build fails | Best-effort legs; check logs | Fix if straightforward; these don't block release |

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
| `GITHUB_TOKEN` | Auto-provided by Actions — no setup needed. Creates the release and pushes the `finalize` version bump. |

`finalize` no longer uses a GitHub App; the old `RELEASE_APP_ID` /
`RELEASE_APP_PRIVATE_KEY` secrets are unused and can be deleted.

**Repo requirement:** Settings → Actions → General → Workflow permissions must
be **Read and write**, or both release creation and the `finalize` push fail
with 403 (`Resource not accessible by integration`). Verify with:
```bash
gh api repos/gannonh/kata-agents/actions/permissions/workflow
# expect: "default_workflow_permissions":"write"
```

To re-set a secret from `.env`:
```bash
gh secret set SECRET_NAME --repo gannonh/kata-agents --body "value"
```

---

## After a successful release

1. Verify the release page looks correct at https://github.com/gannonh/kata-agents/releases
2. **Stable releases**: the `finalize` job automatically bumps
   `apps/electron/package.json` + `package.json` on `main` to the shipped
   version (pushed via `GITHUB_TOKEN` as `github-actions[bot]`) and commits
   `chore(release): prepare v<version>`, so the next nightly resolves to
   `X.Y.(Z+1)-nightly.*`. No manual bump needed. If `finalize` fails, the
   fallback is to bump manually:
   ```bash
   bun run scripts/release/update-release-package-versions.ts <version>
   bun install --lockfile-only --ignore-scripts
   git add package.json apps/electron/package.json bun.lock
   git commit -m "chore(release): prepare v<version>" && git push origin main
   ```
3. Update `docs/specs/index.md` and `docs/log.md` if this release closes a project milestone
