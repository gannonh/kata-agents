---
okf_version: "0.1"
---

# Kata Agents — Documentation

Kata Agents is an open-source Electron desktop app, headless server, and CLI client for AI agent sessions.

## Sections

* [specs/](specs/) — GitHub Issue roadmap and pre-migration spec archive
* [architecture/](architecture/) — System maps, package responsibilities, agent backends
* [reference/](reference/) — CLI reference, APIs, config schemas
* [operations/](operations/) — CI and release pipelines, required secrets
* [../apps/online-docs/](../apps/online-docs/) — Mintlify source for the hosted product documentation

## Roadmap

* **Worktree V2 in progress**: phase 1 [#40](https://github.com/gannonh/kata-agents/issues/40) is implemented on this branch, covering custom identity, server-owned roots, registry authority, and local/headless parity. Sequential phases [#41](https://github.com/gannonh/kata-agents/issues/41), [#42](https://github.com/gannonh/kata-agents/issues/42), and [#43](https://github.com/gannonh/kata-agents/issues/43) cover snapshot-backed lifecycle, checkout handoff, and isolated conversation forks. Phase 2 [#41](https://github.com/gannonh/kata-agents/issues/41) is implemented on this branch: snapshot-backed management with automatic cleanup (see [ADR](adrs/2026-08-05-snapshot-backed-worktree-lifecycle.md)). Phase 3 [#42](https://github.com/gannonh/kata-agents/issues/42) is implemented on this branch: conflict-safe checkout handoff between current and managed checkouts (see [ADR](adrs/2026-08-07-conflict-safe-checkout-handoff.md)). Phase 4 [#43](https://github.com/gannonh/kata-agents/issues/43) is implemented on this branch: isolated conversation forks with a pending provider-fork intent and first-Send establishment (see [ADR](adrs/2026-08-08-isolated-conversation-forks.md)).
* **Next planned initiative: integrated browser** — parent issue [#28](https://github.com/gannonh/kata-agents/issues/28) tracks a panel-by-default browser, secure Chrome cookie import, persistent page annotations, and agent handoff. The issue's implementation breakdown starts with [#29](https://github.com/gannonh/kata-agents/issues/29) for the embedded panel and detachable surface, allows [#30](https://github.com/gannonh/kata-agents/issues/30) to proceed after the profile/session contract is established, and places [#31](https://github.com/gannonh/kata-agents/issues/31) after the panel and annotation overlay model.
* **Supporting test work** — [#25](https://github.com/gannonh/kata-agents/issues/25) is implemented and awaiting Verify; [#34](https://github.com/gannonh/kata-agents/issues/34) covers running development and production builds together.
* **Deferred product backlog** — Git V2 ([#16](https://github.com/gannonh/kata-agents/issues/16)), Forge V2 ([#18](https://github.com/gannonh/kata-agents/issues/18)), Git V1 WebUI/CLI parity ([#19](https://github.com/gannonh/kata-agents/issues/19)), and the standalone server/remote client/TUI story ([#6](https://github.com/gannonh/kata-agents/issues/6)) remain tracked for later planning.

## Recently implemented

* **Worktree V2 Phase 4** — [#43](https://github.com/gannonh/kata-agents/issues/43) — isolated conversation forks: the Branch action offers **New isolated worktree** next to the default **Shared worktree** for capable providers, previewing the source conversation head/branch/HEAD/owners and destination identity with typed blockers; confirm commits a durable child session bound to a `kata-agent/<name>` managed worktree at the source HEAD through a journaled fork transaction; the child carries a durable pending provider-fork intent (provider identity shown as **Pending**) and first Send establishes the native fork with a persisted idempotency key, exactly-once provider/message creation, and an orphan ledger for unlinkable provider artifacts (see [ADR](adrs/2026-08-08-isolated-conversation-forks.md)). Production provider adapters remain disabled until credentialed UAT.

* **Share managed worktrees across sessions** — [specs/archive/2026-08-03-allow-new-sessions-to-use-existing-managed-worktrees-design.md](specs/archive/2026-08-03-allow-new-sessions-to-use-existing-managed-worktrees-design.md) — **Implemented.** A new empty session can pick an existing managed worktree from the composer Workspace control and bind to it as a shared owner; discovery is scoped to the workspace + repository and cleanup guards keep shared checkouts intact. Tracks [#33](https://github.com/gannonh/kata-agents/issues/33).
* **Pi SDK 0.83 migration** — [specs/archive/2026-08-01-pi-sdk-0.83-migration-design.md](specs/archive/2026-08-01-pi-sdk-0.83-migration-design.md) — **Implemented.** Migrated the embedded Pi runtime to the current Pi CLI-aligned `@earendil-works` packages and adopted native model reasoning metadata. [Build report](specs/archive/2026-08-01-pi-sdk-0.83-migration-build-report.md).
* **Provider-aware reasoning levels** — [specs/archive/2026-08-01-provider-aware-reasoning-levels-design.md](specs/archive/2026-08-01-provider-aware-reasoning-levels-design.md) — **Implemented.** OpenAI API, ChatGPT/Codex, Copilot, and Pi-managed model controls expose reported reasoning capabilities, including `minimal`. [Build report](specs/archive/2026-08-01-provider-aware-reasoning-levels-build-report.md).
* **Awaitable agent teardown quiescence** — [specs/archive/2026-07-30-agent-quiescence-contract-design.md](specs/archive/2026-07-30-agent-quiescence-contract-design.md) — **Implemented.** The backend contract from [#21](https://github.com/gannonh/kata-agents/issues/21) makes destructive managed-worktree operations wait for nested turn completion and provider child-process exit.
* **Worktree V2 Phase 2** — [#41](https://github.com/gannonh/kata-agents/issues/41) — snapshot-backed management and automatic cleanup: verified capture/restore, per-server auto-delete policy (off by default), LRU retention sweeps, path leases and journal recovery, a compact delete-only active-worktree UI, and session-delete integration.
* **Worktree V2 Phase 3** — [#42](https://github.com/gannonh/kata-agents/issues/42) — conflict-safe checkout handoff: fingerprint-bound previews with typed blockers, three server-owned directions (current → managed, managed → current, hand-back), journaled idempotent steps with snapshot-backed rollback, path/transaction fencing of Send and Git mutations, provider-proven execution-CWD rebinding with the immutable transcript preserved, session runtime reconstruction proof before Send, and an Electron preview/confirm/recovery UI. Production provider adapters remain disabled until credentialed UAT (see [ADR](adrs/2026-08-07-conflict-safe-checkout-handoff.md)).
* **Worktree V2 Phase 1** — [#40](https://github.com/gannonh/kata-agents/issues/40) — implementation covers exact named branches, server-owned configurable roots, fixed-registry upgrades, capability-aware Electron controls, and headless/local parity. The real-Electron local UAT passes after the required Electron artifact is built; see the issue's Verify matrix for current evidence.
* **Git and GitHub V1 with managed worktrees** — [specs/archive/2026-07-26-git-github-worktrees-v1-design.md](specs/archive/2026-07-26-git-github-worktrees-v1-design.md) — **Implemented and verified**, enabled by default. Build report: [specs/archive/2026-07-26-git-github-worktrees-v1-build-report.md](specs/archive/2026-07-26-git-github-worktrees-v1-build-report.md).
* **Complete Kata brand transition** — [specs/archive/2026-06-22-complete-kata-brand-transition-design.md](specs/archive/2026-06-22-complete-kata-brand-transition-design.md) — completed. Build report: [specs/archive/2026-06-22-complete-kata-brand-transition-build-report.md](specs/archive/2026-06-22-complete-kata-brand-transition-build-report.md). Verify report: [specs/archive/2026-06-23-complete-kata-brand-transition-verify-report.md](specs/archive/2026-06-23-complete-kata-brand-transition-verify-report.md).
* **ADRs** — [adrs/](adrs/) — accepted decisions cover the Kata identity hard cutover and server-owned managed worktrees.

## Earlier completed work

* **Online docs site** — [apps/online-docs/](../apps/online-docs/) — Mintlify documentation site seeded from the upstream introduction, rewritten for Kata Agents, and linked to the existing product-doc routes used by the app.
* **MCP OAuth callback support** — [specs/archive/2026-06-26-mcp-oauth-callback-support-plan.md](specs/archive/2026-06-26-mcp-oauth-callback-support-plan.md) — Cloudflare Worker callback relay plus MCP OAuth `resource` handling. Build report: [specs/archive/2026-06-26-mcp-oauth-callback-support-build-report.md](specs/archive/2026-06-26-mcp-oauth-callback-support-build-report.md).
* **CLI rename and phantom removal** — [specs/archive/2026-06-24-cli-rename-and-phantom-removal-design.md](specs/archive/2026-06-24-cli-rename-and-phantom-removal-design.md) — renamed terminal client to `kata-agents-cli`, removed phantom `kata-agent` CLI references and feature flag. Build report: [specs/archive/2026-06-24-cli-rename-and-phantom-removal-build-report.md](specs/archive/2026-06-24-cli-rename-and-phantom-removal-build-report.md).
* **Update UX parity** — [specs/archive/2026-06-20-update-ux-parity-with-kata-code-design.md](specs/archive/2026-06-20-update-ux-parity-with-kata-code-design.md) — Kata Code-style desktop update UX. Status: implemented. Build report: [specs/archive/2026-06-20-update-ux-parity-with-kata-code-build-report.md](specs/archive/2026-06-20-update-ux-parity-with-kata-code-build-report.md).
* **Project B — CI/release pipeline** — [specs/archive/2026-06-19-ci-release-pipeline.md](specs/archive/2026-06-19-ci-release-pipeline.md) — GitHub Actions CI + nightly/stable desktop release pipeline publishing to GitHub Releases. Status: implemented. See [operations/ci.md](operations/ci.md) and [operations/release.md](operations/release.md).
* **Rebrand Phase 1** — [specs/archive/rebrand-kata-agents-phase-1.md](specs/archive/rebrand-kata-agents-phase-1.md) — renamed user-facing Craft surfaces to Kata while preserving identity infrastructure. Status: completed. Build report: [specs/archive/rebrand-kata-agents-phase-1-build-report.md](specs/archive/rebrand-kata-agents-phase-1-build-report.md).

## Root project files

| File | Purpose |
|------|---------|
| [README.md](../README.md) | Full product overview, setup, architecture, and feature reference |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Branch naming, PR process, code style |
| [SECURITY.md](../SECURITY.md) | Security policy and vulnerability disclosure |
| [TRADEMARK.md](../TRADEMARK.md) | Gannon Hall trademark usage guidelines |

## Package-level agent context

| Package | File |
|---------|------|
| `@kata-sh/shared` | [packages/shared/CLAUDE.md](../packages/shared/CLAUDE.md) |
| `@kata-sh/core` | [packages/core/CLAUDE.md](../packages/core/CLAUDE.md) |
| Electron resources | [apps/electron/resources/AGENTS.md](../apps/electron/resources/AGENTS.md) |
