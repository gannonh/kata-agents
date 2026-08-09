# Operations Update Log

## 2026-06-19

* **Initialization**: Created the operations section with OKF index and log.
* **Added**: [ci.md](ci.md) — `ci.yml` validation gate, the `validate:ci` legs,
  the removed `lint:i18n:coverage` gate rationale, and `validate-server.yml`.
* **Added**: [release.md](release.md) — `release.yml` nightly/stable pipeline,
  channel model, GitHub Releases auto-update shape, dry-run usage, and the
  required-secrets table (Project B build).

## 2026-08-09

* **Updated**: [release.md](release.md) — release-notes promotion is now
  automated by `scripts/release/promote-release-notes.ts`. Added the
  **Release notes** section covering the three call sites (`release_meta
  --check`, build-time bundling for both channels, `finalize --reset` for
  stable), the stable-core filename rule that stops nightly What's New from
  lagging a cycle, and the build-time-only promotion that prevents ghost
  version files. Also documented the `finalize` rebase-and-retry push.

## 2026-06-21

* **Updated**: [release.md](release.md) — documented the scheduled nightly
  trigger and the new `finalize` job (ports kata-code's post-stable version
  bump to `main`) plus the `RELEASE_APP_ID` / `RELEASE_APP_PRIVATE_KEY` secrets
  it requires. Fixes the nightly-tag regression where nightlies reused the
  just-shipped stable version instead of `X.Y.(Z+1)-nightly.*`.
