# Specs — Roadmap

The remaining rebrand work is consolidated into one complete brand-transition plan. The old Project A/C/D split is superseded by the active spec below; implementation can still ship as multiple smaller PRs under that plan.

## Active

* [2026-06-24-cli-rename-and-phantom-removal-design.md](2026-06-24-cli-rename-and-phantom-removal-design.md): Rename `apps/cli` to `@kata-sh/agents-cli` / bin `kata-agents-cli` and remove all phantom `kata-agent` commands-CLI references (system prompt, permission policies, feature flag, bundled docs, orphaned env vars). Plan approved 2026-06-24. Deferred-work backlog: [#4](https://github.com/gannonh/kata-agents/issues/4).

## Planned implementation phases

Completed under [2026-06-22-complete-kata-brand-transition-design.md](2026-06-22-complete-kata-brand-transition-design.md). Build report: [2026-06-22-complete-kata-brand-transition-build-report.md](2026-06-22-complete-kata-brand-transition-build-report.md). Verify report: [2026-06-23-complete-kata-brand-transition-verify-report.md](2026-06-23-complete-kata-brand-transition-verify-report.md).

## Completed

* [2026-06-22-complete-kata-brand-transition-design.md](2026-06-22-complete-kata-brand-transition-design.md): Hard-cutover Kata identity across packages, runtime, desktop app, CLI/server/viewer/webui, bundled resources, docs, and release metadata. Build report: [2026-06-22-complete-kata-brand-transition-build-report.md](2026-06-22-complete-kata-brand-transition-build-report.md). Verify report: [2026-06-23-complete-kata-brand-transition-verify-report.md](2026-06-23-complete-kata-brand-transition-verify-report.md) — all 12 ACs pass.

* [2026-06-20-update-ux-parity-with-kata-code-design.md](2026-06-20-update-ux-parity-with-kata-code-design.md): Port Kata Code's desktop update UX to Kata Agents: background checks, manual download/install, sidebar pill, Stable/Nightly update track selector, native check dialogs, production diagnostics, and update docs. Build implemented; see [build report](2026-06-20-update-ux-parity-with-kata-code-build-report.md).
* [2026-06-19-ci-release-pipeline.md](2026-06-19-ci-release-pipeline.md) — **Project B**. GitHub Actions CI + nightly/stable desktop release pipeline (Bun toolchain) publishing to GitHub Releases with the kata-code auto-update shape. Status: implemented. Ops docs: [../operations/ci.md](../operations/ci.md), [../operations/release.md](../operations/release.md).
* [rebrand-kata-agents-phase-1.md](rebrand-kata-agents-phase-1.md) — Rename all user-facing "Kata Agents" surfaces to "Kata Agents" while preserving identity infrastructure. See [rebrand-kata-agents-phase-1-build-report.md](rebrand-kata-agents-phase-1-build-report.md).
