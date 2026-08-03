# Documentation Bundle Update Log

## 2026-08-03

* **OSS legal distribution compliance**: restored Craft Agents' upstream `LICENSE`/`NOTICE` attribution, added the generated `THIRD-PARTY-NOTICES.md` inventory, packaged the legal files in desktop/server outputs, and added CI/release verification.

## 2026-08-02

* **Expanded tool activity preference**: added an Appearance → Interface setting persisted in `preferences.json`; chat turns now follow the app default while explicit per-turn expansion and collapse overrides remain persisted independently.

* **Claude model picker catalog**: direct Anthropic connections now use the requested Fable 5, Opus 5, Opus 4.8, Opus 4.7, Sonnet 5, Sonnet 4.6, and Haiku 4.5 order, remove retired Opus 4.1, and retain active provider entries when a persisted catalog is stale; user-owned model lists remain unchanged.

* **Claude Opus 5 and Sonnet 5**: upgraded the Claude Agent SDK to 0.3.220 and registered both models in direct Anthropic and Bedrock-aware catalogs with 1M-token metadata; Sonnet 5 uses the always-on adaptive-thinking path.

* **OpenAI model picker order**: ChatGPT/Codex models now display in the requested GPT-5.6 Sol, Terra, Luna, GPT-5.5, GPT-5.4, GPT-5.4 mini, and GPT-5.3 Codex Spark order, including startup synchronization for existing automatically managed connections.

* **Managed worktree push fix**: worktrees created from a remote-tracking base ref (for example `origin/main`) inherited `branch.<branch>.merge=refs/heads/main` via `branch.autoSetupMerge`, and the resulting plain `git push` failed with the upstream-name mismatch fatal. `ManagedWorktreeService.createWorktree` now passes `--no-track`, and `GitActionService.push` heals a mismatched upstream by pushing to the branch's same-named remote counterpart while preserving matching upstreams on non-primary remotes (fork workflows). The GitHub E2E flow now selects the remote-tracking base ref, covering the UAT path.

* **WebUI OAuth relay E2E unblocked**: the Node-launched WebUI harness crashed on `Bun.password`; `packages/server-core/src/webui/auth.ts` now keeps Bun Argon2id as primary and falls back to Node `crypto.scrypt` in-memory hashing only when `Bun.password` is unavailable. The relay specs were updated to the real local OAuth/MCP fixture and pass.

* **Root test baseline recorded**: root `bun run test` fails 24 tests that reproduce identically on the base SHA (BrowserPaneManager mock drift, stale RPC registration expected-channel sets, cwd-dependent workspace-slug fallback, webui http-server cross-file pollution, Playwright specs swept into the Bun run). Filed as deferred work in GitHub issue #25; the `validate:ci` gate is green.

* **Git/GitHub E2E verification**: updated the Git/GitHub V1 roadmap, build report, and validation evidence to record the passing macOS local lifecycle flow and authenticated real-GitHub commit/push/pull-request cleanup flow. The authenticated fixture clones the configured UAT repository and cleans up its PR and remote branch.

* **Agent E2E OAuth default**: documented that `openai-codex` with the existing `chatgpt-plus` OAuth credential is the default `@agent` path; Anthropic API-key onboarding requires an explicit provider override.

## 2026-08-01

* **Stable feature defaults**: enabled the Git/GitHub V1 managed-worktree experience and the Server settings page by default. Both remain disableable through their `KATA_FEATURE_*` environment overrides; updated the release documentation for the 0.10.8 stable rollout.

* **Online sharing feature gate**: hid the unfinished Share Online affordances by default behind `KATA_FEATURE_SHARE_ONLINE`, with renderer injection and a local `.env` value of `0`.

* **ChatGPT/Codex OAuth bundle fix**: registered Pi's statically bundled OAuth loaders in the embedded server so bundled OpenAI Codex sessions do not attempt missing sibling-module imports. The generated bundle verifier and a fake-token subprocess smoke test cover the path.

* **ChatGPT/Codex OAuth fix**: corrected Pi subprocess credential injection so `openai-codex` receives Pi 0.83's native OAuth credential shape during startup and token refresh, while regular OpenAI API-key connections retain API-key auth. Added regression coverage for credential shaping and the Pi runtime auth contract.

* **Pi SDK 0.83 migration implemented**: migrated the embedded Pi runtime to the Pi CLI-aligned `@earendil-works` 0.83 package family, adopted native GPT-5.6 model catalogs and reasoning metadata, mapped native `max`, and verified the generated bundle. See the [migration spec](specs/2026-08-01-pi-sdk-0.83-migration-design.md) and [build report](specs/2026-08-01-pi-sdk-0.83-migration-build-report.md).

* **Pi SDK 0.83 migration approved**: added the [Pi SDK migration spec](specs/2026-08-01-pi-sdk-0.83-migration-design.md) for the current Pi CLI-aligned `@earendil-works` package family, native model catalogs, and native reasoning levels.

* **Provider-aware reasoning levels implemented**: model-specific OpenAI, ChatGPT/Codex, Copilot, and Pi-managed reasoning controls now expose supported levels, restore persisted app defaults for new sessions, preserve existing session values, use native Pi `max` when reported, and resolve prefixed model IDs. See the [build report](specs/2026-08-01-provider-aware-reasoning-levels-build-report.md).

* **Provider-aware reasoning levels planned**: added the draft [provider-aware reasoning levels spec](specs/2026-08-01-provider-aware-reasoning-levels-design.md) for model-specific OpenAI, ChatGPT/Codex, and Pi-managed reasoning controls, including the `minimal` level and renderer capability metadata.

* **Managed worktree deletion confirmation**: preparing a worktree now updates renderer session state immediately, so the session delete action can offer its worktree-aware confirmation without waiting for a restart or full session reload. The worktree icon and supporting text remain aligned when the label wraps.

* **GPT-5.6 model catalog**: added GPT-5.6 Sol, Terra, and Luna to the OpenAI API-key and ChatGPT/Codex catalogs, including Pi runtime registration and updated defaults. Added the preview Git workspace flag to `.env.example`.

## 2026-07-31

* **Agent quiescence implemented**: issue #21's awaitable teardown contract shipped on the existing feature branch and draft PR, with the shared barrier, provider teardown, SessionManager boundary, deterministic lifecycle regression coverage, and full affected verification matrix.

## 2026-07-30

* **Agent quiescence plan drafted**: added the approval-gated [awaitable agent teardown quiescence spec](specs/2026-07-30-agent-quiescence-contract-design.md), linked it from the specs roadmap and documentation index, and mapped issue #21 to a required backend teardown contract, provider process-exit guarantees, SessionManager integration, deterministic safety tests, and a lesser-model Build handoff.

## 2026-07-29

* **Git/GitHub V1 final review hardening**: documented complete ignored-file destructive inventory, final-snapshot ordering, and cleanup-exception containment in the [managed-worktree ADR](adrs/2026-07-29-server-owned-managed-worktrees.md), with regression coverage for all three findings from the final-head review.

* **Git/GitHub V1 post-review hardening**: appended a "Post-review hardening" section to the [build report](specs/2026-07-26-git-github-worktrees-v1-build-report.md) mapping the six resolved review findings to their fixes, logged the detail in [specs/log.md](specs/log.md), and refreshed [validation/git-github-worktrees-v1/README.md](validation/git-github-worktrees-v1/README.md) with six playground captures (adding the checkout directory-lock comparison and a dark-theme delete dialog), reproduction steps, a table mapping non-visual invariants to their tests, and the host limitations that shaped the evidence.

* **Git/GitHub V1 implemented (Phase 4)**: marked [specs/2026-07-26-git-github-worktrees-v1-design.md](specs/2026-07-26-git-github-worktrees-v1-design.md) status **Implemented**, added the [build report](specs/2026-07-26-git-github-worktrees-v1-build-report.md) mapping AC1–AC21 to implementation/tests, updated the specs roadmap ([specs/index.md](specs/index.md)) and [docs index](index.md), and logged the change in [specs/log.md](specs/log.md). Extended [architecture/system-overview.md](architecture/system-overview.md) with a "Git & GitHub worktrees (preview)" section, added the user-facing [git-worktrees](../apps/online-docs/core-concepts/git-worktrees.mdx) Mintlify page (nav + docs.json), documented remote-server Git/`gh` requirements in [server/headless](../apps/online-docs/server/headless.mdx), and appended a flag-gated release-note bullet. Real-GitHub UAT and the macOS `@git` E2E GUI flow are deferred to Verify (recorded in the build report).

## 2026-07-26

* **Drafted Git/GitHub V1 spec**: added [specs/2026-07-26-git-github-worktrees-v1-design.md](specs/2026-07-26-git-github-worktrees-v1-design.md), updated the documentation and specs roadmaps, recorded independent adversarial review closure, and filed deferred follow-ups [#16](https://github.com/gannonh/kata-agents/issues/16) through [#19](https://github.com/gannonh/kata-agents/issues/19).

## 2026-06-29

* **Help link routes**: updated app Help dropdown links to use hosted Mintlify routes on `https://agents.kata.sh/docs`, added missing [sources](../apps/online-docs/sources/overview.mdx), [statuses](../apps/online-docs/statuses/overview.mdx), [labels](../apps/online-docs/labels/overview.mdx), config, and sharing docs pages, and unignored those route directories for tracking.
* **Online docs site**: created [apps/online-docs/](../apps/online-docs/) as the Mintlify source for hosted product documentation. Seeded the site with a Kata-rebranded introduction derived from upstream Craft Agents docs, added pages for sources, skills, statuses, permissions, automations, messaging, workspaces, themes, and headless server usage, and validated with Mintlify.

## 2026-06-28

* **Devbox -> devcontainer standard**: reworked the isolated worktree boxes onto `.devcontainer/devcontainer.json` + `@devcontainers/cli`, MS TS-Node base image, full dev toolchain, and Pi agent (config + extensions). Updated [reference/devbox.md](reference/devbox.md) and [reference/log.md](reference/log.md).

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
