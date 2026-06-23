# Specs — Roadmap

The remaining rebrand work is consolidated into one complete brand-transition plan. The old Project A/C/D split is superseded by the active spec below; implementation can still ship as multiple smaller PRs under that plan.

## Active

* [2026-06-22-complete-kata-brand-transition-design.md](2026-06-22-complete-kata-brand-transition-design.md): Complete the Kata brand transition with a hard cutover and zero legacy support across package scope, runtime env/config identity, Electron app identity, CLI/server/viewer/webui surfaces, bundled resources, docs, release metadata, and residual Craft scan verification.

## Planned implementation phases

Tracked inside the active spec:

1. Package graph and source imports.
2. Runtime identity hard cutover.
3. Desktop app identity and release metadata.
4. Apps, CLI, server, viewer, webui, and bundled resources.
5. i18n, docs, and OKF closeout.
6. Verification and residual scan.

## Completed

* [2026-06-20-update-ux-parity-with-kata-code-design.md](2026-06-20-update-ux-parity-with-kata-code-design.md): Port Kata Code's desktop update UX to Kata Agents: background checks, manual download/install, sidebar pill, Stable/Nightly update track selector, native check dialogs, production diagnostics, and update docs. Build implemented; see [build report](2026-06-20-update-ux-parity-with-kata-code-build-report.md).
* [2026-06-19-ci-release-pipeline.md](2026-06-19-ci-release-pipeline.md) — **Project B**. GitHub Actions CI + nightly/stable desktop release pipeline (Bun toolchain) publishing to GitHub Releases with the kata-code auto-update shape. Status: implemented. Ops docs: [../operations/ci.md](../operations/ci.md), [../operations/release.md](../operations/release.md).
* [rebrand-kata-agents-phase-1.md](rebrand-kata-agents-phase-1.md) — Rename all user-facing "Craft Agents" surfaces to "Kata Agents" while preserving identity infrastructure. See [rebrand-kata-agents-phase-1-build-report.md](rebrand-kata-agents-phase-1-build-report.md).
