# Specs — Roadmap

Post-fork rebrand + infra roadmap, four sequenced projects: **A** brand tail → **B** CI/release →
**C** safe code rename → **D** identity infra. Each ships as its own spec/PR.

## Active

_None._

## Planned

* **Project A — brand tail**: remaining user-facing deferrals from Phase 1 (Kata DMG background) +
  finish Phase 1 verification. Independent; ship anytime.
* **Project C — safe code rename**: `@craft-agent/*` → `@kata-sh/*` scopes, `CRAFT_*` env prefix,
  internal identifiers. Mechanical, CI-verified (depends on B). Enables npm publish.
* **Project D — identity infra**: `appId`, `craftagents://` scheme, `~/.craft-agent` config dir +
  migration, backend/publish domains. Highest risk; last.

## Completed

* [2026-06-19-ci-release-pipeline.md](2026-06-19-ci-release-pipeline.md) — **Project B**. GitHub
  Actions CI + nightly/stable desktop release pipeline (Bun toolchain) publishing to GitHub Releases
  with the kata-code auto-update shape. Status: implemented. Ops docs:
  [../operations/ci.md](../operations/ci.md), [../operations/release.md](../operations/release.md).
* [rebrand-kata-agents-phase-1.md](rebrand-kata-agents-phase-1.md) — Rename all user-facing "Craft Agents" surfaces to "Kata Agents" while preserving identity infrastructure (appId, deep-link scheme, config dir, env vars, publish URLs). See [rebrand-kata-agents-phase-1-build-report.md](rebrand-kata-agents-phase-1-build-report.md).
