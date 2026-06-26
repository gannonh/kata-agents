---
okf_version: "0.1"
---

# Kata Agents — Documentation

Kata Agents is an open-source Electron desktop app, headless server, and CLI client for AI agent sessions. It is a fork of Kata Agents being rebranded to Kata Agents.

## Sections

* [specs/](specs/) — Product specs, rebrand plans, and active work roadmap
* [architecture/](architecture/) — System maps, package responsibilities, agent backends
* [reference/](reference/) — CLI reference, APIs, config schemas
* [operations/](operations/) — CI and release pipelines, required secrets

## Active work

* **MCP OAuth callback support** — [specs/mcp-oauth-callback-support-plan.md](specs/mcp-oauth-callback-support-plan.md) — draft plan for a free-tier Cloudflare Worker callback relay plus MCP OAuth callback/token completion.

* **Complete Kata brand transition** — [specs/2026-06-22-complete-kata-brand-transition-design.md](specs/2026-06-22-complete-kata-brand-transition-design.md) — completed. Build report: [specs/2026-06-22-complete-kata-brand-transition-build-report.md](specs/2026-06-22-complete-kata-brand-transition-build-report.md). Verify report: [specs/2026-06-23-complete-kata-brand-transition-verify-report.md](specs/2026-06-23-complete-kata-brand-transition-verify-report.md).
* **ADRs** — [adrs/](adrs/) — one accepted (kata-identity hard-cutover); seed is in place for future decisions

## Recent work

* **CLI rename and phantom removal** — [specs/2026-06-24-cli-rename-and-phantom-removal-design.md](specs/2026-06-24-cli-rename-and-phantom-removal-design.md) — renamed terminal client to `kata-agents-cli`, removed phantom `kata-agent` commands-CLI references and feature flag. Build report: [specs/2026-06-24-cli-rename-and-phantom-removal-build-report.md](specs/2026-06-24-cli-rename-and-phantom-removal-build-report.md).
* **Complete Kata brand transition** — [specs/2026-06-22-complete-kata-brand-transition-design.md](specs/2026-06-22-complete-kata-brand-transition-design.md) — hard-cutover Kata identity across packages, runtime, desktop, CLI/server, resources, docs. Verify passed 2026-06-23 (all 12 ACs). Verify report: [specs/2026-06-23-complete-kata-brand-transition-verify-report.md](specs/2026-06-23-complete-kata-brand-transition-verify-report.md).
* **Update UX parity** — [specs/2026-06-20-update-ux-parity-with-kata-code-design.md](specs/2026-06-20-update-ux-parity-with-kata-code-design.md) — Kata Code-style desktop update UX. Status: implemented. Build report: [specs/2026-06-20-update-ux-parity-with-kata-code-build-report.md](specs/2026-06-20-update-ux-parity-with-kata-code-build-report.md)
* **Project B — CI/release pipeline** — [specs/2026-06-19-ci-release-pipeline.md](specs/2026-06-19-ci-release-pipeline.md) — GitHub Actions CI + nightly/stable desktop release pipeline (Bun) publishing to GitHub Releases. Status: implemented. Ops docs: [operations/ci.md](operations/ci.md), [operations/release.md](operations/release.md)
* **Rebrand Phase 1** — [specs/rebrand-kata-agents-phase-1.md](specs/rebrand-kata-agents-phase-1.md) — rename all user-facing "Craft" surfaces to "Kata" while preserving identity infrastructure. Status: completed. Build report: [specs/rebrand-kata-agents-phase-1-build-report.md](specs/rebrand-kata-agents-phase-1-build-report.md)

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
