# Specs Update Log

## 2026-06-26

* **Drafted**: [mcp-oauth-callback-support-plan.md](mcp-oauth-callback-support-plan.md) — converted the MCP OAuth callback visual plan into the local OKF spec format. Captures the free-tier Cloudflare Worker relay decision, hosted plus localhost return-target policy, MCP `resource` requirement, acceptance criteria, and Build handoff.

## 2026-06-25

* **loadEnv inline-comment fix**: fixed `e2e/src/config/loadEnv.ts` to strip `\s+#` inline comments after .env values and honor quoted-value interiors, preventing a trailing comment from baking into the parsed model name and stalling `@agent`. See [e2e-foundation-adoption-build-report.md](e2e-foundation-adoption-build-report.md) addendum.
* **Quality review fixes**: tightened [e2e-foundation-adoption-plan.md](e2e-foundation-adoption-plan.md) implementation after strict review. Moved Playwright fixtures out of `harness/`, attached renderer fatal-error tracking before window resolution, collapsed single-caller wrapper modules into `devStack`/`isolatedRun`, removed the dead setup project and dead exports, hardened release-app re-signing, and refreshed docs/skill boundaries. Verified with `bunx tsc --noEmit -p e2e/tsconfig.json` and `bun run e2e --list`.
* **Release channel implemented**: completed `desktop-release` parity for [e2e-foundation-adoption-plan.md](e2e-foundation-adoption-plan.md). The same specs now run under both `desktop-dev` and `desktop-release`; all three tiers pass green against a packaged `.app`. Added `releaseTarget.ts` + `file://` renderer detection, configurable agent provider/model (`KATA_E2E_AGENT_PROVIDER`/`MODEL`, openai support), timeout knobs, and `bun run e2e:build-release` (stages SDK + ad-hoc debugger re-sign). Routed `e2e:*` scripts through Node (Bun cannot complete the packaged-app inspector attach). Closed deferred issue [#13](https://github.com/gannonh/kata-agents/issues/13). See build report addendum.
* **Implemented**: [e2e-foundation-adoption-plan.md](e2e-foundation-adoption-plan.md) — built the local Electron E2E foundation: Playwright harness (isolated runs, Vite-only dev stack, plain electron launch, build gate, release scaffold), flows (deferred-setup + real API-key onboarding, appearance settings, deterministic agent reply), and `@smoke`/`@settings`/`@agent` specs. Added stable id markers (`#onboarding-wizard`, `#app-ready`, `#workspace-picker`). All 13 ACs pass on macOS. Build report: [e2e-foundation-adoption-build-report.md](e2e-foundation-adoption-build-report.md). Deferred work filed: [#11](https://github.com/gannonh/kata-agents/issues/11), [#12](https://github.com/gannonh/kata-agents/issues/12), [#13](https://github.com/gannonh/kata-agents/issues/13). Moved Active → Completed in [index.md](index.md).
* **Drafted + Approved**: [e2e-foundation-adoption-plan.md](e2e-foundation-adoption-plan.md) — added OKF frontmatter, `## Status: Approved`, and a formal `## Acceptance criteria` section (13 observable criteria). Added decision record [2026-06-24-e2e-testing-foundation-design.md](2026-06-24-e2e-testing-foundation-design.md) (V1 constraints, `KATA_*` env contract, verification matrix).

## 2026-06-24

* **Implemented**: [2026-06-24-cli-rename-and-phantom-removal-design.md](2026-06-24-cli-rename-and-phantom-removal-design.md) — Renamed `@kata-sh/cli` / `kata-cli` to `@kata-sh/agents-cli` / `kata-agents-cli`; removed `kataAgentsCli` feature flag, pre-tool-use redirects, phantom bundled docs, orphaned env vars, and `kata-agent` bash allowlist patterns (replaced with `kata-agents-cli invoke` allowlist). Build report: [2026-06-24-cli-rename-and-phantom-removal-build-report.md](2026-06-24-cli-rename-and-phantom-removal-build-report.md). Moved Active → Completed in [index.md](index.md).

## 2026-06-23

* **Verified**: [2026-06-23-complete-kata-brand-transition-verify-report.md](2026-06-23-complete-kata-brand-transition-verify-report.md) — Verify-phase UAT for the Complete Kata brand transition. First pass found 3 failing ACs (broken `kata-agent.svg` tool icon, Craft-named `kata-logos` assets, dead `CraftAppIcon` code) plus blocked AC 6 and minor AC 7. Fixed all, plus a `copy-assets.ts` stale-file hygiene bug, GitHub org refs, and mock/test data. Re-run: all 12 ACs pass. Packaged `Info.plist` = `sh.kata.agents` / `Kata Agents`. Updated [index.md](index.md) and [../index.md](../index.md) active/recent work; spec moved Implemented -> Completed.

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
