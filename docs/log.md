# Documentation Bundle Update Log

## 2026-06-20

* **Implemented**: Update UX parity spec.
  * Spec: [specs/2026-06-20-update-ux-parity-with-kata-code-design.md](specs/2026-06-20-update-ux-parity-with-kata-code-design.md)
  * Build report: [specs/2026-06-20-update-ux-parity-with-kata-code-build-report.md](specs/2026-06-20-update-ux-parity-with-kata-code-build-report.md)
  * **Updated**: [specs/index.md](specs/index.md) moves the spec to implemented; [specs/log.md](specs/log.md) records the build and the earlier planning entry; [operations/release.md](operations/release.md) documents the new selected-channel runtime contract.
  * Scope: ported Kata Code's desktop update UX to Kata Agents while preserving Project B release feed semantics and identity infrastructure.

## 2026-06-20

* **Drafted**: Update UX parity spec.
  * Spec: [specs/2026-06-20-update-ux-parity-with-kata-code-design.md](specs/2026-06-20-update-ux-parity-with-kata-code-design.md)
  * **Updated**: [specs/index.md](specs/index.md) moved the spec into Active; [specs/log.md](specs/log.md) records the planning entry.
  * Scope: port Kata Code's desktop update UX to Kata Agents while preserving Project B release feed semantics and identity infrastructure.

## 2026-06-19

* **Implemented**: Project B CI/release pipeline.
  * Spec: [specs/2026-06-19-ci-release-pipeline.md](specs/2026-06-19-ci-release-pipeline.md)
  * Build report: [specs/2026-06-19-ci-release-pipeline-build-report.md](specs/2026-06-19-ci-release-pipeline-build-report.md)
  * **New section**: [operations/](operations/) with [ci.md](operations/ci.md) and [release.md](operations/release.md) (CI gate, release pipeline, auto-update shape, required secrets).
  * **Updated**: [index.md](index.md) (added operations section + recent work), [specs/index.md](specs/index.md) moved Project B from Active to Completed.
* **Completed**: Phase 1 user-facing rebrand from Craft Agents to Kata Agents.
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
