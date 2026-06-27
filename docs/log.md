# Documentation Bundle Update Log

## 2026-06-27

* **Devbox**: added [reference/devbox.md](reference/devbox.md) runbook for `scripts/devbox.sh` — single-command isolated worktree dev containers (OrbStack/Docker) solving port collisions between concurrent Electron/Vite worktrees. Updated [reference/index.md](reference/index.md) and [reference/log.md](reference/log.md).

## 2026-06-25

* **loadEnv fix**: documented the `.env` inline-comment parser fix in the E2E build report and [specs/log.md](specs/log.md).
* **Quality review fixes**: Updated E2E foundation docs after strict review: fixture layer boundary, collapsed harness helper inventory, release build-script guidance, and validation evidence. See [specs/log.md](specs/log.md) and [specs/e2e-foundation-adoption-build-report.md](specs/e2e-foundation-adoption-build-report.md).

## 2026-06-23

* **Verified**: Complete Kata brand transition — Verify phase passed. New [specs/2026-06-23-complete-kata-brand-transition-verify-report.md](specs/2026-06-23-complete-kata-brand-transition-verify-report.md). Fixed broken `kata-agent.svg` tool icon, Craft-named `kata-logos` assets, dead `CraftAppIcon`/`craft_logo_c.svg`, a `copy-assets.ts` stale-file hygiene bug, GitHub org refs (`lukilabs` -> `gannonh`), and mock/test data. All 12 ACs pass; packaged `Info.plist` = `sh.kata.agents`. Updated [specs/index.md](specs/index.md), [index.md](index.md), [specs/log.md](specs/log.md), build/verify/spec status, and root `AGENTS.md` active context.

* **Quality review fixes**: Updated [specs/2026-06-22-complete-kata-brand-transition-build-report.md](specs/2026-06-22-complete-kata-brand-transition-build-report.md) with quality review section (blockers, quoted-form conflation, other residuals, migration scripts moved). Updated [specs/index.md](specs/index.md) and [index.md](index.md) active work notes. Updated [specs/log.md](specs/log.md). Updated root `AGENTS.md` active context.

## 2026-06-22

* **Implemented**: Complete Kata brand transition.
  * Spec: [specs/2026-06-22-complete-kata-brand-transition-design.md](specs/2026-06-22-complete-kata-brand-transition-design.md)
  * Build report: [specs/2026-06-22-complete-kata-brand-transition-build-report.md](specs/2026-06-22-complete-kata-brand-transition-build-report.md)
  * ADR: [adrs/2026-06-22-kata-identity-hard-cutover.md](adrs/2026-06-22-kata-identity-hard-cutover.md)
  * **Updated**: [specs/index.md](specs/index.md), [index.md](index.md), [specs/log.md](specs/log.md), [adrs/index.md](adrs/index.md), [adrs/log.md](adrs/log.md)
  * Scope: hard-cutover rebrand with zero Craft-era compatibility shims.

* **Drafted**: Complete Kata brand transition spec.
  * Spec: [specs/2026-06-22-complete-kata-brand-transition-design.md](specs/2026-06-22-complete-kata-brand-transition-design.md)
  * **Updated**: [specs/index.md](specs/index.md) consolidates the old Project A/C/D split into this active spec; [index.md](index.md) lists it under active work; [specs/log.md](specs/log.md) records the planning entry.
  * Scope: hard-cutover rebrand across package scope, runtime env/config identity, Electron app identity, CLI/server/viewer/webui surfaces, bundled resources, docs, release metadata, and residual Craft scan verification.

## 2026-06-20

* **Drafted**: Update UX parity spec.
  * Spec: [specs/2026-06-20-update-ux-parity-with-kata-code-design.md](specs/2026-06-20-update-ux-parity-with-kata-code-design.md)
  * **Updated**: [specs/index.md](specs/index.md) moved the spec into Active; [specs/log.md](specs/log.md) records the planning entry.
  * Scope: port Kata Code's desktop update UX to Kata Agents while preserving Project B release feed semantics and identity infrastructure.
* **Implemented**: Update UX parity spec.
  * Spec: [specs/2026-06-20-update-ux-parity-with-kata-code-design.md](specs/2026-06-20-update-ux-parity-with-kata-code-design.md)
  * Build report: [specs/2026-06-20-update-ux-parity-with-kata-code-build-report.md](specs/2026-06-20-update-ux-parity-with-kata-code-build-report.md)
  * **Updated**: [specs/index.md](specs/index.md) moves the spec to implemented; [specs/log.md](specs/log.md) records the build and the earlier planning entry; [operations/release.md](operations/release.md) documents the new selected-channel runtime contract.
  * Scope: ported Kata Code's desktop update UX to Kata Agents while preserving Project B release feed semantics and identity infrastructure.

## 2026-06-19

* **Implemented**: Project B CI/release pipeline.
  * Spec: [specs/2026-06-19-ci-release-pipeline.md](specs/2026-06-19-ci-release-pipeline.md)
  * Build report: [specs/2026-06-19-ci-release-pipeline-build-report.md](specs/2026-06-19-ci-release-pipeline-build-report.md)
  * **New section**: [operations/](operations/) with [ci.md](operations/ci.md) and [release.md](operations/release.md) (CI gate, release pipeline, auto-update shape, required secrets).
  * **Updated**: [index.md](index.md) (added operations section + recent work), [specs/index.md](specs/index.md) moved Project B from Active to Completed.
* **Completed**: Phase 1 user-facing rebrand from Kata Agents to Kata Agents.
  * Spec: [specs/rebrand-kata-agents-phase-1.md](specs/rebrand-kata-agents-phase-1.md)
  * Build report: [specs/rebrand-kata-agents-phase-1-build-report.md](specs/rebrand-kata-agents-phase-1-build-report.md)
  * Changes include i18n rebranding for all 7 locales, Electron app identity strings and icon assets, React component symbol and splash, shared package agent identity prompts, OAuth consent label, README/CONTRIBUTING, and OKF spec status.
* **Updated**: [specs/index.md](specs/index.md) moved Phase 1 from Active to Completed.

## 2026-06-19

* **Initialization**: Created OKF v0.1 bundle at `./docs`.
* **Migration**: Moved `docs/cli.md` → [reference/cli.md](reference/cli.md) with OKF frontmatter.
* **Migration**: Moved root `rebrand-fork-to-kata-agents-phase-1-user-facing.md` → [specs/rebrand-kata-agents-phase-1.md](specs/rebrand-kata-agents-phase-1.md) with OKF frontmatter.
* **Creation**: [architecture/system-overview.md](architecture/system-overview.md) — monorepo structure, package responsibilities, agent backends, tech stack.
* **Creation**: Root `AGENTS.md` with OKF consumption and maintenance instructions.
