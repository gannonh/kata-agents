# Specs — Roadmap

This page is the roadmap for active, planned, deferred, and completed work. GitHub issues hold work that does not yet have a repository spec.

## Active

* **Integrated browser** — parent issue [#28](https://github.com/gannonh/kata-agents/issues/28) tracks a panel-by-default browser, detachable native surfaces, secure Chrome cookie import, persistent page annotations, and agent handoff.
  * [#29 — Embedded browser panel with detachable surface](https://github.com/gannonh/kata-agents/issues/29) is the foundation: model browser instances independently from their panel or detached presentation surface.
  * [#30 — Import Chrome cookies into Kata browser profiles](https://github.com/gannonh/kata-agents/issues/30) can proceed after the profile/session contract is established.
  * [#31 — Add persistent page annotations and agent handoff](https://github.com/gannonh/kata-agents/issues/31) depends on the integrated panel and annotation overlay/selection model.

The parent issue owns cross-cutting integration, security, workspace/session behavior, and final end-to-end verification.

## Planned

No additional sequenced implementation phase is recorded after the integrated browser initiative. The deferred issues below remain available for later planning.

## Deferred

### Testing and maintenance

* [#34 — Allow running dev and production (Nightly) builds simultaneously](https://github.com/gannonh/kata-agents/issues/34): remove the Electron single-instance lock conflict for local E2E, or provide a clear launch diagnostic.
* [#25 — Fix pre-existing root Bun test failures](https://github.com/gannonh/kata-agents/issues/25): address the base-SHA failures in BrowserPaneManager mocks, RPC registration expectations, cwd-dependent workspace fallback, WebUI cross-file pollution, and Playwright test discovery.
* [#12 — E2E macOS CI runner strategy](https://github.com/gannonh/kata-agents/issues/12).
* [#11 — E2E parallel isolation for subprocess server ports](https://github.com/gannonh/kata-agents/issues/11).

### Product follow-ups

* [#24 — Refresh the Pi remote catalog for new OpenRouter models](https://github.com/gannonh/kata-agents/issues/24).
* [#19 — Git V1 WebUI and dedicated CLI parity](https://github.com/gannonh/kata-agents/issues/19).
* [#18 — Forge V2 for additional code hosts and non-Git VCS](https://github.com/gannonh/kata-agents/issues/18).
* [#17 — Worktree V2 for handoff, snapshots, cleanup, and conversation forks](https://github.com/gannonh/kata-agents/issues/17).
* [#16 — Git V2 for advanced review and conflict workflows](https://github.com/gannonh/kata-agents/issues/16).
* [#6 — Separate server binary, remote client, and TUI story](https://github.com/gannonh/kata-agents/issues/6).

### CLI and security cleanup

* [#10 — Restore the Bash config write mutation guard](https://github.com/gannonh/kata-agents/issues/10).
* [#9 — Harden the `kata-agents-cli invoke` allowlist](https://github.com/gannonh/kata-agents/issues/9).
* [#8 — Localize CLI user-facing strings](https://github.com/gannonh/kata-agents/issues/8).
* [#7 — Fix the CLI `send --stdin` completion timeout](https://github.com/gannonh/kata-agents/issues/7).
* [#4 — Build the workspace-commands CLI](https://github.com/gannonh/kata-agents/issues/4).

## Completed

* [2026-08-03-allow-new-sessions-to-use-existing-managed-worktrees-design.md](2026-08-03-allow-new-sessions-to-use-existing-managed-worktrees-design.md): new sessions can discover and bind to ready managed worktrees of the same workspace + repository as shared owners, preserving ownership and cleanup safety. Tracks [#33](https://github.com/gannonh/kata-agents/issues/33). **Status: Implemented.**

* [2026-08-01-provider-aware-reasoning-levels-design.md](2026-08-01-provider-aware-reasoning-levels-design.md): provider-aware reasoning controls for OpenAI API, ChatGPT/Codex, and other Pi-managed models, including model capability metadata and the `minimal` level. **Status: Implemented.** See the [build report](2026-08-01-provider-aware-reasoning-levels-build-report.md).

* [2026-07-30-agent-quiescence-contract-design.md](2026-07-30-agent-quiescence-contract-design.md): required backend teardown contract for destructive checkout operations, with nested-turn completion and provider child-process exit. **Status: Implemented.**

* [2026-07-26-git-github-worktrees-v1-design.md](2026-07-26-git-github-worktrees-v1-design.md): Current checkout/New worktree sessions, Changes review with line feedback, safe commit/push/GitHub PR actions, and local/remote managed-worktree lifecycle parity. **Status: Implemented and verified.** See the [build report](2026-07-26-git-github-worktrees-v1-build-report.md) and ADR [2026-07-29-server-owned-managed-worktrees.md](../adrs/2026-07-29-server-owned-managed-worktrees.md).

* [2026-08-01-pi-sdk-0.83-migration-design.md](2026-08-01-pi-sdk-0.83-migration-design.md): migrate the embedded Pi runtime to the Pi CLI-aligned `@earendil-works` 0.83 packages and use native model reasoning metadata. **Status: Implemented.** See the [build report](2026-08-01-pi-sdk-0.83-migration-build-report.md).

* [2026-06-26-mcp-oauth-callback-support-plan.md](2026-06-26-mcp-oauth-callback-support-plan.md): stateless Cloudflare Worker relay for `https://agents.kata.sh/auth/callback`, MCP OAuth `resource` parameter support, and Electron/WebUI callback completion. **Status: Implemented.** See the [build report](2026-06-26-mcp-oauth-callback-support-build-report.md).

* [e2e-foundation-adoption-plan.md](e2e-foundation-adoption-plan.md): local-only, macOS-first Playwright + real-Electron E2E foundation. Implemented 2026-06-25; all 13 acceptance criteria pass. Deferred follow-ups: [#11](https://github.com/gannonh/kata-agents/issues/11) and [#12](https://github.com/gannonh/kata-agents/issues/12). See the [build report](e2e-foundation-adoption-build-report.md) and [decision record](2026-06-24-e2e-testing-foundation-design.md).

* [2026-06-24-cli-rename-and-phantom-removal-design.md](2026-06-24-cli-rename-and-phantom-removal-design.md): rename the terminal client to `kata-agents-cli` and remove phantom `kata-agent` CLI references. **Status: Implemented.** See the [build report](2026-06-24-cli-rename-and-phantom-removal-build-report.md). Deferred follow-up: [#4](https://github.com/gannonh/kata-agents/issues/4).

* [2026-06-22-complete-kata-brand-transition-design.md](2026-06-22-complete-kata-brand-transition-design.md): hard-cutover Kata identity across packages, runtime, desktop app, CLI/server/viewer/webui, bundled resources, docs, and release metadata. **Status: Implemented and verified.** See the [build report](2026-06-22-complete-kata-brand-transition-build-report.md) and [verify report](2026-06-23-complete-kata-brand-transition-verify-report.md).

* [2026-06-20-update-ux-parity-with-kata-code-design.md](2026-06-20-update-ux-parity-with-kata-code-design.md): desktop update UX with background checks, manual installation, update channels, native dialogs, diagnostics, and documentation. **Status: Implemented.** See the [build report](2026-06-20-update-ux-parity-with-kata-code-build-report.md).

* [2026-06-19-ci-release-pipeline.md](2026-06-19-ci-release-pipeline.md): GitHub Actions CI and nightly/stable desktop release pipeline publishing to GitHub Releases. **Status: Implemented.** See [operations/ci.md](../operations/ci.md) and [operations/release.md](../operations/release.md).

* [rebrand-kata-agents-phase-1.md](rebrand-kata-agents-phase-1.md): rename user-facing Craft surfaces to Kata while preserving identity infrastructure. **Status: Implemented.** See the [build report](rebrand-kata-agents-phase-1-build-report.md).
