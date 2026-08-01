# Specs — Roadmap

The remaining rebrand work is consolidated into one complete brand-transition plan. The old Project A/C/D split is superseded by the active spec below; implementation can still ship as multiple smaller PRs under that plan.

## Active

* [2026-08-01-provider-aware-reasoning-levels-design.md](2026-08-01-provider-aware-reasoning-levels-design.md): Provider-aware reasoning controls for OpenAI API, ChatGPT/Codex, and other Pi-managed models, including model capability metadata and the `minimal` level. **Status: Draft.**

* [2026-07-30-agent-quiescence-contract-design.md](2026-07-30-agent-quiescence-contract-design.md): Required backend teardown contract for destructive checkout operations. Tracks [#21](https://github.com/gannonh/kata-agents/issues/21) and replaces processing-flag polling plus the 100 ms grace delay with nested-turn completion and provider child-process exit. **Status: Implemented.**

* [2026-07-26-git-github-worktrees-v1-design.md](2026-07-26-git-github-worktrees-v1-design.md): Flag-gated V1 for Current checkout/New worktree sessions, change review and line feedback, safe commit/push/GitHub PR actions, and local/remote managed-worktree lifecycle parity. **Status: Implemented and verified.** The completed macOS `@git` tier uses real Electron and a disposable real Git repository; the serial headless-server flow covers remote ownership; and checked-in [visual evidence](../validation/git-github-worktrees-v1/README.md) covers all four vertical slices. The authenticated real-GitHub mutation pass remains conditional on `gh` availability; deterministic adapter/RPC tests and the non-mutating missing-`gh` UI path are covered. See the [build report](2026-07-26-git-github-worktrees-v1-build-report.md) and ADR [2026-07-29-server-owned-managed-worktrees.md](../adrs/2026-07-29-server-owned-managed-worktrees.md).

## Planned implementation phases

Completed under [2026-06-22-complete-kata-brand-transition-design.md](2026-06-22-complete-kata-brand-transition-design.md). Build report: [2026-06-22-complete-kata-brand-transition-build-report.md](2026-06-22-complete-kata-brand-transition-build-report.md). Verify report: [2026-06-23-complete-kata-brand-transition-verify-report.md](2026-06-23-complete-kata-brand-transition-verify-report.md).

## Completed

* [2026-06-26-mcp-oauth-callback-support-plan.md](2026-06-26-mcp-oauth-callback-support-plan.md): Stateless Cloudflare Worker relay for `https://agents.kata.sh/auth/callback`, MCP OAuth `resource` parameter support, and Electron/WebUI callback completion. Build report: [2026-06-26-mcp-oauth-callback-support-build-report.md](2026-06-26-mcp-oauth-callback-support-build-report.md).

* [e2e-foundation-adoption-plan.md](e2e-foundation-adoption-plan.md): Local-only, macOS-first Playwright + real-Electron E2E foundation (`@smoke`/`@settings`/`@agent` tiers, run isolation, no CI in V1). Implemented 2026-06-25; all 13 ACs pass. Decision record: [2026-06-24-e2e-testing-foundation-design.md](2026-06-24-e2e-testing-foundation-design.md). Build report: [e2e-foundation-adoption-build-report.md](e2e-foundation-adoption-build-report.md). Deferred: [#11](https://github.com/gannonh/kata-agents/issues/11), [#12](https://github.com/gannonh/kata-agents/issues/12), [#13](https://github.com/gannonh/kata-agents/issues/13).

* [2026-06-24-cli-rename-and-phantom-removal-design.md](2026-06-24-cli-rename-and-phantom-removal-design.md): Rename `apps/cli` to `@kata-sh/agents-cli` / bin `kata-agents-cli` and remove phantom `kata-agent` commands-CLI references. Build report: [2026-06-24-cli-rename-and-phantom-removal-build-report.md](2026-06-24-cli-rename-and-phantom-removal-build-report.md). Deferred-work backlog: [#4](https://github.com/gannonh/kata-agents/issues/4).

* [2026-06-22-complete-kata-brand-transition-design.md](2026-06-22-complete-kata-brand-transition-design.md): Hard-cutover Kata identity across packages, runtime, desktop app, CLI/server/viewer/webui, bundled resources, docs, and release metadata. Build report: [2026-06-22-complete-kata-brand-transition-build-report.md](2026-06-22-complete-kata-brand-transition-build-report.md). Verify report: [2026-06-23-complete-kata-brand-transition-verify-report.md](2026-06-23-complete-kata-brand-transition-verify-report.md) — all 12 ACs pass.

* [2026-06-20-update-ux-parity-with-kata-code-design.md](2026-06-20-update-ux-parity-with-kata-code-design.md): Port Kata Code's desktop update UX to Kata Agents: background checks, manual download/install, sidebar pill, Stable/Nightly update track selector, native check dialogs, production diagnostics, and update docs. Build implemented; see [build report](2026-06-20-update-ux-parity-with-kata-code-build-report.md).
* [2026-06-19-ci-release-pipeline.md](2026-06-19-ci-release-pipeline.md) — **Project B**. GitHub Actions CI + nightly/stable desktop release pipeline (Bun toolchain) publishing to GitHub Releases with the kata-code auto-update shape. Status: implemented. Ops docs: [../operations/ci.md](../operations/ci.md), [../operations/release.md](../operations/release.md).
* [rebrand-kata-agents-phase-1.md](rebrand-kata-agents-phase-1.md) — Rename all user-facing "Kata Agents" surfaces to "Kata Agents" while preserving identity infrastructure. See [rebrand-kata-agents-phase-1-build-report.md](rebrand-kata-agents-phase-1-build-report.md).
