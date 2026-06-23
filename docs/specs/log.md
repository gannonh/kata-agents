# Specs Update Log

## 2026-06-23

* **Quality review fixes**: [2026-06-22-complete-kata-brand-transition-build-report.md](2026-06-22-complete-kata-brand-transition-build-report.md) updated with quality review section documenting blockers fixed (broken server dist scopeDir, 2 failing tests), quoted-form conflation fixes (5 files), other residuals, and migration scripts moved to `scripts/migrations/`. Full `packages/shared` test suite now passes (2898 pass, 0 fail). Updated [index.md](index.md) active work note.

## 2026-06-22

* **Implemented**: [2026-06-22-complete-kata-brand-transition-design.md](2026-06-22-complete-kata-brand-transition-design.md) — Hard-cutover Kata identity across `@kata-sh/*`, `KATA_*`, `~/.kata-agents`, `kataagents://`, `sh.kata.agents`, `agents.kata.sh`, CLI/server binaries, bundled resources, i18n, and docs. Build report: [2026-06-22-complete-kata-brand-transition-build-report.md](2026-06-22-complete-kata-brand-transition-build-report.md). ADR: [../adrs/2026-06-22-kata-identity-hard-cutover.md](../adrs/2026-06-22-kata-identity-hard-cutover.md). Moved Active → Completed in [index.md](index.md).

* **Drafted**: [2026-06-22-complete-kata-brand-transition-design.md](2026-06-22-complete-kata-brand-transition-design.md) — One hard-cutover spec to complete the Kata brand transition across packages, env/config identity, app ID, URL scheme, CLI/server/viewer/webui, bundled resources, docs, release metadata, and verification. Supersedes the old Project A/C/D roadmap split. Adversarial review found no remaining blocker or major issues after revision.

## 2026-06-20

* **Implemented**: [2026-06-20-update-ux-parity-with-kata-code-design.md](2026-06-20-update-ux-parity-with-kata-code-design.md) — Ported Kata Code's desktop update UX to Kata Agents: stateful background checks with manual download/install, sidebar update pill, Stable/Nightly track selection, native up-to-date/error dialogs, production updater diagnostics, copyright metadata, and release/ops docs. Build report: [2026-06-20-update-ux-parity-with-kata-code-build-report.md](2026-06-20-update-ux-parity-with-kata-code-build-report.md). Independent subagent review unavailable (dispatch unstable); single-agent self-review recorded.

* **Drafted**: [2026-06-20-update-ux-parity-with-kata-code-design.md](2026-06-20-update-ux-parity-with-kata-code-design.md): Plan to port Kata Code's desktop update UX to Kata Agents: stateful background checks, manual download/install, sidebar update pill, Stable/Nightly track selection, native up-to-date/error dialogs, production updater diagnostics, and required docs updates. Added to Active in [index.md](index.md). Adversarial review found no remaining blocking or medium issues after revision. Approved 2026-06-20.

## 2026-06-19

* **Implemented**: [2026-06-19-ci-release-pipeline.md](2026-06-19-ci-release-pipeline.md) — Project B
  CI/release pipeline built across phases 1–5: green `validate:ci` + `ci.yml`, github-provider
  release config + repaired build entry points, channel-aware desktop updater, nightly/stable
  `release.yml` (signed+notarized macOS, best-effort Windows/Linux, GitHub Releases via softprops),
  disabled npm publish scaffold, and ops docs. Moved Active → Completed in [index.md](index.md). See
  [build report](2026-06-19-ci-release-pipeline-build-report.md).
* **Drafted**: [2026-06-19-ci-release-pipeline.md](2026-06-19-ci-release-pipeline.md) — Project B
  spec for GitHub Actions CI + nightly/stable desktop release pipeline (Bun toolchain) publishing to
  GitHub Releases with the kata-code auto-update shape. Revised after adversarial review (runtime
  updater channel work, build-state correction, release-upload action, GITHUB_TOKEN permissions,
  missing tsconfig/i18n infra). Added the four-project roadmap (A→B→C→D) to [index.md](index.md).
* **Implemented**: [rebrand-kata-agents-phase-1.md](rebrand-kata-agents-phase-1.md) renames all user-facing "Kata Agents" surfaces to "Kata Agents" across i18n, renderer, shared package, build scripts, docs, and app icons, while preserving identity infrastructure.
* **Build report**: Added [rebrand-kata-agents-phase-1-build-report.md](rebrand-kata-agents-phase-1-build-report.md) documenting the implementation, verification results, approved deviations, and follow-up work.
* **Status change**: Moved the Phase 1 spec from Active to Completed in [index.md](index.md).

## 2026-06-19

* **Initialization**: Created specs section with OKF index and log.
* **Migration**: Added [rebrand-kata-agents-phase-1.md](rebrand-kata-agents-phase-1.md) from root plan file.
