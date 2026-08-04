---
type: Spec
title: Rename CLI and remove phantom kata-agent commands references
description: Rename apps/cli to @kata-sh/agents-cli / bin kata-agents-cli and remove all references to the never-implemented kata-agent workspace-commands binary across the system prompt, permission policies, bundled docs, and orphaned env vars. Defer the commands-CLI build to a backlog issue.
tags: [cli, rename, branding, system-prompt, release]
timestamp: 2026-06-24T00:00:00Z
migrated: false
archived_at: 2026-08-04T16:24:02Z
status: Completed
---

> **Completed before migration** (status: Completed). Retained as history. Not tracked in GitHub Issues.

# Rename CLI and remove phantom kata-agent commands references

- **Plan**: Approved 2026-06-24. Adversarial review completed with 6 valid findings, all addressed in revision. Deferred-work backlog issue: [#4](https://github.com/gannonh/kata-agents/issues/4).

## Goal

Rename the WebSocket terminal client (`apps/cli`) from package `@kata-sh/cli` / binary `kata-cli` to package `@kata-sh/agents-cli` / binary `kata-agents-cli`, and remove every phantom reference to the never-implemented `kata-agent` workspace-commands binary across the system prompt, permission policies, bundled docs, and orphaned environment variables.

After this change, everything shipped in the repo is truthful regardless of feature-flag state: the only CLI/server binaries are `kata-agents-cli` (terminal client) and `kata-server`. The in-app agent is no longer instructed to call a binary that does not exist, and the flag-gated redirect/guardrail code that emitted `Use kata-agent ...` messages is removed entirely. Building a first-class `kata-agent` commands CLI is deferred to a backlog issue.

**Two distinct workstreams, one spec:** (1) the mechanical rename of CLI A; (2) full removal of the phantom `kata-agent` CLI infrastructure, including the `kataAgentsCli` feature flag and all code it gates. They ship together but are tracked as separate phases so an implementer does not widen scope mid-build.

## Source of truth and verified current state

- **CLI A (`apps/cli`)** is the WebSocket terminal client. Package `@kata-sh/cli`, bin `kata-cli`. Commands: `ping`, `health`, `versions`, `workspaces`, `sessions`, `connections`, `sources`, `session create/messages/delete`, `send` (streaming), `cancel`, `invoke`, `listen`, `run` (self-contained, spawns a server via `apps/cli/src/server-spawner.ts`), and `--validate-server`. ~2,075 lines in `apps/cli/src/index.ts`.
- **CLI B (phantom `kata-agent`)** is referenced but does not exist as code. Verified across this repo and the upstream `/Volumes/EVO/repos/craft-agents-oss`:
  - No `package.json` declares a `kata-agent` (or upstream `craft-agent`) bin.
  - No file parses `label`/`source`/`skill`/`automation` as top-level CLI subcommands.
  - Upstream `apps/electron/src/main/index.ts:172-175` sets the same phantom env vars (`CRAFT_COMMANDS_ENTRY` → `packages/craft-agents-commands/src/main.ts`, `CRAFT_CLI_ENTRY` → `packages/craft-cli/src/cli.ts`); neither package exists upstream either.
  - The real capability is **RPC channels** in `packages/shared/src/protocol/channels.ts` (`labels:list`, `labels:create`, `sources:create`, `skills:get`, etc.), invoked today via CLI A's `invoke` command or the desktop UI.
- **System prompt instructs the agent to call the phantom (flag-gated):** `packages/shared/src/prompts/system.ts:589,592,596,598-601` — *"Prefer `kata-agent` CLI over direct file edits… `kata-agent label --help`…"*, rendered only when `FEATURE_FLAGS.kataAgentsCli` is on.
- **Feature flag gates the entire phantom surface (defaults off):** `packages/shared/src/feature-flags.ts:43-47,75-81` defines `kataAgentsCli` (`KATA_FEATURE_KATA_AGENTS_CLI`). It gates: `system.ts` prompt block; `permissions-config.ts:379` `shouldCompileBashPattern` skipping `^kata-agent\s` patterns when off; `pre-tool-use.ts:813,827` redirect functions (`getConfigDomainBashRedirect`/`getConfigCliRedirect`); the `Use \`kata-agent ${namespace} ...\`` message at `pre-tool-use.ts:426`; the `/^kata-agent\s+(label|automation|source|skill)\b/` allowlist at `pre-tool-use.ts:535`. In the default (flag-off) configuration the agent is *not* told to call `kata-agent`, but the dead redirect/guardrail code still ships. This spec removes the flag and all gated code so truthfulness does not depend on flag state.
- **Permission policies encode the phantom:** `packages/shared/src/config/cli-domains.ts` sets `helpCommand: 'kata-agent <domain> --help'`, `quickExamples` (`kata-agent label list`, etc.), and `readActions` across all 6 domains; `packages/shared/src/config/sync-kata-agent-bash-patterns.ts` derives `^kata-agent\s...` patterns via `getKataAgentReadOnlyBashPatterns()`; `packages/shared/tests/permissions-kata-agent-sync.test.ts` asserts the sync.
- **Tests assert phantom behavior:** `packages/shared/src/agent/core/__tests__/pre-tool-use-checks.isolated.ts` (asserts `kata-agent label`/`automation --help`/`source`/`skill` redirect reasons, lines ~480-644; allowlists `kata-agent label list` line ~625); `packages/shared/tests/shellguard-corpus.test.ts` (51 `kata-agent` refs, "Group 27: kata-agent CLI allowlist"); `packages/shared/src/agent/__tests__/pi-agent-pretool-labels.test.ts` (sets the flag, tests label redirects); `packages/shared/src/agent/__tests__/permissions-config-kata-cli-flag.test.ts` (tests flag-gated pattern compilation); plus `packages/shared/src/__tests__/feature-flags.test.ts` (flag unit test).
- **Bundled docs describe the phantom:** `apps/electron/resources/docs/kata-cli.md` opens *"`kata-agent` is the preferred interface for managing workspace config domains"* with full `kata-agent label/source/skill/automation` command listings. The domain docs (`labels.md`, `sources.md`, `skills.md`, `automations.md`, `permissions.md`) link to it as "Canonical command reference".
- **Orphaned env vars:** `apps/electron/src/main/index.ts:172-181` sets `KATA_COMMANDS_ENTRY`, `KATA_CLI_ENTRY`, `KATA_COMMANDS_DOC_PATH`, `KATA_CLI_DOC_PATH` pointing at `packages/kata-agents-commands` and `packages/kata-cli`, neither of which exists. Carried forward from `CRAFT_*` by the brand transition without verification.
- **Release workflow:** `.github/workflows/release.yml` `publish_cli` job is `if: false` with a stale comment citing "Project B" and "after the scope/env rename" as the reason for deferral. The rename is now complete (verify report 2026-06-23, all 12 ACs pass) and Project A/C/D was superseded by the single complete-brand-transition plan, so the comment is inaccurate.
- **Desktop app architecture:** `apps/electron/src/main/index.ts:627` bootstraps an in-process WS server via `bootstrapServer`. The CLI's `--url`/`--token` flags target an already-running server. This is the product loop the e2e demo validates.

## Constraints

- Runtime: Bun. Type-check via per-package `tsc --noEmit` (root `typecheck:all` is broken on base SHA per `AGENTS.md`).
- Surgical changes only: no refactor of CLI behavior, no new command surface, no npm publishing enablement.
- Prior brand-transition specs/build reports/verify reports are historical record and are **not** edited to scrub `kata-cli` mentions (excluded from the grep AC).
- `uat-evidence/` and generated `apps/electron/dist/`, `apps/electron/release/`, `apps/electron/packages/` artifacts are excluded from grep ACs.
- The `kata-agent` *assistant product* name (in-app identity, navigation events like `kata-agent-navigate`) is unrelated to the phantom CLI binary and is **not** touched.

## Out of scope

- Building the `kata-agent` workspace-commands CLI from scratch — deferred, tracked via backlog issue.
- Enabling `publish_cli` / npm publishing — separate product decision.
- Changing the CLI command surface or `run`/`send`/`validate-server` behavior.
- `kata-server` binary (already correctly named).

## Architecture

No new components. The change is identity, documentation, and dead-reference removal.

```mermaid
graph LR
  subgraph Desktop["Desktop app (electron main)"]
    Bootstrap["bootstrapServer() → in-process WS server"]
  end
  Bootstrap -->|ws:// + token| UI["Desktop UI (renderer)"]
  Bootstrap -->|ws:// + token| CLI["kata-agents-cli<br/>(renamed terminal client)"]
  CLI -->|invoke labels:* / sources:* / skills:*| Channels["RPC channels<br/>protocol/channels.ts"]
  UI --> Channels
  Phantom["kata-agent commands CLI<br/>REMOVED from all refs<br/>build DEFERRED → backlog issue"]:::deferred
  classDef deferred stroke-dasharray: 5 5,opacity:0.6;
```

The renamed CLI and the desktop UI are peers against the same server RPC channels. The phantom `kata-agent` (dashed) is removed from all references; the deferred issue captures building it.

## Components and file groups

1. **Package identity** — `apps/cli/package.json` (`name` → `@kata-sh/agents-cli`, `bin.kata-cli` → `bin.kata-agents-cli`); `apps/cli/src/index.ts:1379` hardcoded `description: "Validation skill created by kata-cli"` string.
2. **CLI help/usage text** — `apps/cli/src/index.ts`: header comment (`:3`), help string (`:1894` `kata-cli — Terminal client for Kata Agent server`), usage line (`:1896`), example invocations (`:1939-1953`); residual `craft-kb`/`craft-public` example source names (`:1940-1941`).
3. **Reference docs** — `docs/reference/cli.md` (~40 `kata-cli` invocations, title, frontmatter), `docs/reference/index.md` entry, `README.md` (~7 invocations).
4. **Bundled doc** — rename `apps/electron/resources/docs/kata-cli.md` → `kata-agents-cli.md`; update `packages/shared/src/docs/index.ts` `kataCli` key and `${APP_ROOT}/docs/kata-cli.md` path; rewrite content to document CLI A's real `invoke`-based label/source/skill/automation access (e.g. `kata-agents-cli invoke labels:list`) with no `kata-agent` binary references.
5. **Domain docs** — `labels.md`, `sources.md`, `skills.md`, `automations.md`, `permissions.md`: replace the "Canonical command reference: [kata-cli.md]" line with a link to `kata-agents-cli.md` invoke guidance (or remove the false-canonical framing).
6. **Feature flag + gated redirect/guardrail code (full removal)** — `packages/shared/src/feature-flags.ts`: remove the `kataAgentsCli` getter, its `isKataAgentsCliEnabled()` helper, and the `KATA_FEATURE_KATA_AGENTS_CLI` env parsing. `packages/shared/src/agent/core/pre-tool-use.ts`: remove `getConfigDomainBashRedirect`/`getConfigCliRedirect` and the `kata-agent ${namespace} ...` message block (`:426`), the `/^kata-agent\s+(label|automation|source|skill)\b/` allowlist (`:535`), and the two `FEATURE_FLAGS.kataAgentsCli` branches (`:813,827`). `packages/shared/src/agent/permissions-config.ts:379`: remove the `shouldCompileBashPattern` `^kata-agent\s` special-case and the flag read.
7. **System prompt** — `packages/shared/src/prompts/system.ts:589-601`: remove the flag-gated "Prefer `kata-agent` CLI" block and the four `kata-agent <domain> --help` lines entirely (no replacement prompt block — the agent uses the generic `kata-agents-cli invoke <channel>` documented in the rewritten bundled doc, or the desktop UI). Do not introduce a new flag-gated block.
8. **Permission policies** — `packages/shared/src/config/cli-domains.ts`: drop the phantom-grammar metadata (`helpCommand`, `quickExamples`, `readActions`) since `kata-agents-cli invoke` has no namespace/action subcommands to mirror; retain only the workspace path scopes (`workspacePathScopes`, `bashGuardPaths` — file-ownership metadata independent of any CLI binary). Rewrite `getKataAgentReadOnlyBashPatterns()` in `sync-kata-agent-bash-patterns.ts` to emit `^kata-agents-cli\s+invoke\s+(labels:list|labels:create|sources:get|...)` against an explicit RPC-channel allowlist, OR remove the function and the sync script entirely if the invariant no longer holds (build-time decision per build handoff). Decide the fate of `KATA_AGENTS_CLI_OWNED_WORKSPACE_PATH_SCOPES` (currently a dead export consumed only by the sync test) — remove if unused after the rewrite.
9. **Phantom-asserting tests** — update or remove all of: `packages/shared/src/agent/core/__tests__/pre-tool-use-checks.isolated.ts` (remove `kata-agent` redirect/allowlist assertions, lines ~480-644, ~625); `packages/shared/tests/shellguard-corpus.test.ts` (remove Group 27 + 51 refs); `packages/shared/src/agent/__tests__/pi-agent-pretool-labels.test.ts` (remove — tested only flag-gated redirects); `packages/shared/src/agent/__tests__/permissions-config-kata-cli-flag.test.ts` (remove — tested only the flag); `packages/shared/tests/permissions-kata-agent-sync.test.ts` (update to new patterns or remove); `packages/shared/src/__tests__/feature-flags.test.ts` (remove the `kataAgentsCli` cases).
10. **Orphaned env vars** — `apps/electron/src/main/index.ts:172-181`: delete `KATA_COMMANDS_ENTRY`, `KATA_CLI_ENTRY`, `KATA_COMMANDS_DOC_PATH`, `KATA_CLI_DOC_PATH` and their `packages/kata-cli` / `packages/kata-agents-commands` path targets.
11. **Release workflow** — `.github/workflows/release.yml` `publish_cli`: fix the stale "Project B / after the scope/env rename" comment to state publishing is deferred pending a product decision; update the disabled `echo` to reference `@kata-sh/agents-cli`.
12. **Release notes** — append to `apps/electron/resources/release-notes/next.md`: Improvements bullet for the rename; Breaking Changes bullet that the `kata-cli` binary is now `kata-agents-cli`, the `kata-agent` commands-CLI references and the `kataAgentsCli` feature flag have been removed pending a future build.

## Implementation phases

1. **Package + CLI source rename** (components 1–2). Verify: `bun run apps/cli/src/index.ts --help` shows `kata-agents-cli`; no `kata-cli` or `craft` strings in help/usage/example output.
2. **Reference docs + README** (component 3). Verify: targeted grep clean in `docs/reference/` and `README.md`.
3. **Bundled doc rename + rewrite, domain docs** (components 4–5). Verify: `cd packages/shared && bun test` passes; doc lookup resolves the new filename.
4. **Feature flag + gated redirect/guardrail code** (component 6). Verify: feature-flag grep gate returns zero matches.
5. **System prompt block removal** (component 7). Verify: no `kata-agent` CLI refs in `prompts/system.ts`.
6. **Permission policies rewrite** (component 8). Verify: `cli-domains.ts` and `sync-kata-agent-bash-patterns.ts` contain no `kata-agent` binary references.
7. **Phantom-asserting tests** (component 9). Verify: `cd packages/shared && bun test` passes with the removed/updated tests.
8. **Orphaned env vars** (component 10). Verify: env-var grep gate returns zero matches.
9. **Workflow comment + release notes** (components 11–12).
10. **E2e demo + gate** (criteria 10–12): run the demo, capture UAT evidence, run type-check/test gates.

## Sequencing

Workstream 1 (rename, phases 1–3) and Workstream 2 (phantom removal, phases 4–8) are internally sequential; the two workstreams are independent and could be parallelized by different implementers. Closeout (phases 9–10) runs after both. The deferred-work backlog issue is created after the spec is approved (separate from the build phases).

## Verification and testing

All grep gates use the same exclusion set: `node_modules/`, `dist/`, `release/`, `apps/electron/packages/` (generated, gitignored), `uat-evidence/`, and the historical records `docs/specs/*brand-transition*`, `docs/specs/2026-06-19-ci-release-pipeline*.md`, `docs/adrs/2026-06-22-kata-identity-hard-cutover.md`. Tests are **not** excluded (they must be updated/removed, not hidden).

- **`kata-cli` grep gate:** `grep -rn "kata-cli" apps/ docs/ packages/ scripts/ .github/ README.md` with the exclusion set above returns zero matches.
- **Phantom grep gate:** `grep -rn "kata-agent CLI\|kata-agent label\|kata-agent source\|kata-agent skill\|kata-agent automation\|kata-agent permission\|kata-agent theme" packages/ apps/` with the exclusion set above returns zero matches.
- **Feature-flag grep gate:** `grep -rn "kataAgentsCli\|KATA_FEATURE_KATA_AGENTS_CLI\|isKataAgentsCliEnabled" packages/ apps/` (excluding dist/release) returns zero matches.
- **Env-var grep gate:** `grep -rn "KATA_COMMANDS_ENTRY\|KATA_CLI_ENTRY\|KATA_COMMANDS_DOC_PATH\|KATA_CLI_DOC_PATH\|packages/kata-cli\|packages/kata-agents-commands" .` (excluding node_modules/dist/release) returns zero matches.
- **Unit/integration:** `cd apps/cli && bun run tsc --noEmit`; `cd apps/cli && bun test`; `cd packages/shared && bun test`.
- **CLI smoke:** `bun run apps/cli/src/index.ts --help` and `--version`.
- **E2e demo:** criterion 10, captured as UAT evidence.

## Risks and mitigations

- **Removing the `kataAgentsCli` flag removes dead-but-shipping redirect code** — intended. The flag defaulted off, so no live agent behavior changes for default users; flag-on users (if any) lose a redirect that pointed at a non-existent binary, which is the correct outcome. Verify no other code reads the flag via the feature-flag grep gate.
- **`cli-domains.ts` rewrite changes the policy shape** — `helpCommand`/`quickExamples`/`readActions` are phantom-grammar metadata with no `invoke` equivalent. Retaining only `workspacePathScopes`/`bashGuardPaths` keeps file-ownership semantics intact. `getKataAgentReadOnlyBashPatterns` either emits `invoke`-based patterns or is removed; the build handoff flags this as a build-time decision with a verify gate (`bun test`).
- **Multiple tests break** — expected and listed (component 9). Each is updated to the new truth or removed with rationale; `cd packages/shared && bun test` is the gate.
- **Bundled doc lookup by old filename** — `packages/shared/src/docs/index.ts` `kataCli` key and path must change together; any code reading the file by a hardcoded `kata-cli.md` string must be found via grep and updated in the same phase.
- **Breaking change for `kata-cli` users** — anyone who `bun link`-ed `kata-cli` must re-link as `kata-agents-cli`. Covered by the release-notes Breaking Changes bullet. No migration tooling provided (pre-1.0, small user base).
- **Over-removing `kata-agent` (product name)** — the product/assistant name `kata-agent` (e.g. `kata-agent-navigate`, `~/.kata-agents`, recent-working-dirs playground paths) is unrelated and must not be touched. The phantom grep targets CLI-command forms (`kata-agent label`, `kata-agent source`, etc.) specifically, not the bare product name.
- **E2e demo token acquisition** — the desktop app prints `KATA_SERVER_URL`/`KATA_SERVER_TOKEN` only in headless mode (`main/index.ts:1030`, gated on `isHeadless`); non-headless skips the print but creates windows. The demo (criterion 10) runs headless so the CLI can target the server, with a separate non-headless boot to confirm the app launches.

## Key files

- `apps/cli/package.json`
- `apps/cli/src/index.ts`
- `apps/cli/src/server-spawner.ts` (comment only)
- `docs/reference/cli.md`, `docs/reference/index.md`
- `README.md`
- `apps/electron/resources/docs/kata-cli.md` (rename → `kata-agents-cli.md`)
- `apps/electron/resources/docs/{labels,sources,skills,automations,permissions}.md`
- `packages/shared/src/docs/index.ts`
- `packages/shared/src/feature-flags.ts`
- `packages/shared/src/agent/core/pre-tool-use.ts`
- `packages/shared/src/agent/permissions-config.ts`
- `packages/shared/src/prompts/system.ts`
- `packages/shared/src/config/cli-domains.ts`
- `packages/shared/src/config/sync-kata-agent-bash-patterns.ts`
- `packages/shared/tests/permissions-kata-agent-sync.test.ts`
- `packages/shared/src/agent/core/__tests__/pre-tool-use-checks.isolated.ts`
- `packages/shared/tests/shellguard-corpus.test.ts`
- `packages/shared/src/agent/__tests__/pi-agent-pretool-labels.test.ts`
- `packages/shared/src/agent/__tests__/permissions-config-kata-cli-flag.test.ts`
- `packages/shared/src/__tests__/feature-flags.test.ts`
- `apps/electron/src/main/index.ts`
- `.github/workflows/release.yml`
- `apps/electron/resources/release-notes/next.md`

## Explicitly deferred work

- **Build the `kata-agent` workspace-commands CLI from scratch** — a real binary wrapping the RPC channels (`label`, `source`, `skill`, `automation`, `permission`, `theme` subcommands) so `kata-agent label list` etc. work without the generic `invoke` form. Tracked via backlog issue. Not a port from upstream (upstream has the same phantom). If built later, it would re-introduce a `kata-agent` bin and a (truthful) system-prompt block; that is a future decision, not part of this spec.
- **Enable `publish_cli` / npm publishing** of `@kata-sh/agents-cli` — separate product decision; requires `NPM_TOKEN` and dist-tag policy.

## Build handoff

**Approved scope:** rename CLI A to `@kata-sh/agents-cli` / `kata-agents-cli`; remove the `kataAgentsCli` feature flag and all code it gates (pre-tool-use redirects, permission compilation special-case); remove all phantom `kata-agent` CLI references (system prompt block, cli-domains grammar metadata, sync patterns, six test files, bundled doc, domain docs, orphaned env vars); fix the `publish_cli` comment; update release notes.

**Non-goals:** build the commands CLI; enable npm publishing; change CLI behavior; touch the `kata-agent` product name.

**Ordered phases:** Workstream 1 (rename): 1 package+source → 2 reference docs+README → 3 bundled doc+domain docs. Workstream 2 (phantom removal): 4 flag+gated code → 5 system prompt → 6 policies → 7 tests → 8 env vars. Closeout: 9 workflow+release notes → 10 e2e demo+gates.

**Required verification:** grep gates (above), `apps/cli` typecheck + tests, `packages/shared` tests, CLI smoke, e2e demo UAT evidence.

**Blocking questions:** none at spec time. Build should confirm two build-time decisions: (a) whether `getKataAgentReadOnlyBashPatterns`/the sync script emits `invoke`-based patterns or is removed entirely; (b) whether `permissions-kata-agent-sync.test.ts` and the other five phantom-asserting tests have a meaningful invariant after the rewrite, or are removed with rationale.

## Acceptance criteria

1. **Package renamed.** `apps/cli/package.json` `name` is `@kata-sh/agents-cli` and `bin` exposes `kata-agents-cli` → `src/index.ts`. No `@kata-sh/cli` package name remains in the repo.
2. **Binary name updated in CLI output.** `bun run apps/cli/src/index.ts --help` prints `kata-agents-cli` in the header and usage line, with zero `kata-cli` strings and zero `craft` strings in help/usage/example output.
3. **No `kata-cli` references remain in source or docs.** `grep -rn "kata-cli" apps/ docs/ packages/ scripts/ .github/ README.md` (excluding `node_modules/`, `dist/`, `release/`, `apps/electron/packages/`, `uat-evidence/`, and prior `docs/specs/*brand-transition*`, `docs/specs/2026-06-19-ci-release-pipeline*.md`, `docs/adrs/2026-06-22-kata-identity-hard-cutover.md` historical records) returns zero matches.
4. **Bundled doc renamed and rewritten.** `apps/electron/resources/docs/kata-cli.md` is renamed to `kata-agents-cli.md`; `packages/shared/src/docs/index.ts` `kataCli` key/path updated to the new filename; content documents CLI A's real `invoke`-based label/source/skill/automation access (e.g. `kata-agents-cli invoke labels:list`) with no `kata-agent` binary references.
5. **Phantom `kata-agent` CLI references removed.** `system.ts` no longer contains "Prefer `kata-agent` CLI" or `kata-agent label/skill/...` help lines (the flag-gated block is gone, not replaced); `cli-domains.ts` `helpCommand`/`quickExamples`/`readActions` are removed (only workspace path scopes retained); `sync-kata-agent-bash-patterns.ts` no longer references the `kata-agent` binary (emits `invoke` patterns or is removed). The phantom grep gate returns zero matches.
6. **`kataAgentsCli` feature flag and gated code removed.** `FEATURE_FLAGS.kataAgentsCli`, `isKataAgentsCliEnabled()`, `KATA_FEATURE_KATA_AGENTS_CLI`, the `pre-tool-use.ts` redirect functions/allowlist/branches, and the `permissions-config.ts` `^kata-agent\s` special-case are all deleted. The feature-flag grep gate returns zero matches. No shipped code emits `Use \`kata-agent ...\`` messages.
7. **Orphaned env vars removed.** `apps/electron/src/main/index.ts` no longer sets `KATA_COMMANDS_ENTRY`, `KATA_CLI_ENTRY`, `KATA_COMMANDS_DOC_PATH`, or `KATA_CLI_DOC_PATH`; the env-var grep gate returns zero matches.
8. **Domain docs no longer claim a phantom canonical reference.** `labels.md`, `sources.md`, `skills.md`, `automations.md`, `permissions.md` no longer link to `kata-cli.md` as a "Canonical command reference" for a `kata-agent` binary; links updated to the renamed `kata-agents-cli.md` invoke guidance or removed.
9. **Release workflow comment is accurate.** The `publish_cli` job comment no longer references "Project B" or the completed rename as the blocker; it states publishing is deferred pending a product decision, and the disabled `echo` references `@kata-sh/agents-cli`.
10. **Deferred-work backlog issue created.** A GitHub issue (using `.github/ISSUE_TEMPLATE/deferred_work.yml`, or a filed issue if no such template exists) captures "Build the `kata-agent` workspace-commands CLI from scratch" with context: phantom references were removed, capability lives behind RPC channels in `protocol/channels.ts`, agent prompt now uses `kata-agents-cli invoke`, this is a from-scratch build not a port.
11. **End-to-end demo passes.** A demo proves the full product loop with the renamed binary, captured as UAT evidence (terminal transcript + screenshot/recording). The desktop app prints `KATA_SERVER_URL`/`KATA_SERVER_TOKEN` only in headless mode, so the server is run headless for CLI targeting and a separate non-headless boot confirms the app launches:
    a. **App launch smoke (non-headless):** run `bun run electron:dev`, confirm the desktop app window opens and boots without errors (screenshot). Stop it.
    b. **Headless server + CLI loop:** run the desktop app's in-process server headless (`KATA_HEADLESS=1 bun run electron:dev` or equivalent), which prints `KATA_SERVER_URL=...` and `KATA_SERVER_TOKEN=...` to stdout; capture both.
    c. `kata-agents-cli --url <ws://...> --token <token> ping` → successful connectivity response (clientId + latency).
    d. `kata-agents-cli --url <ws://...> --token <token> workspaces` (or `sessions`) → returns data from the server.
    e. `kata-agents-cli --url <ws://...> --token <token> session create --name "demo"` → returns a session id; then `kata-agents-cli ... sessions` lists it and `kata-agents-cli ... session messages <id>` returns its (empty) history, proving the CLI↔server round-trip.
    f. `kata-agents-cli --url <ws://...> --token <token> invoke labels:list` → JSON response (validates the redirect target from criterion 5; handler exists at `packages/server-core/src/handlers/rpc/labels.ts`).
    g. `kata-agents-cli --url <ws://...> --token <token> invoke system:homeDir` → JSON response.
12. **Type-checks and tests green.** `cd apps/cli && bun run tsc --noEmit` passes; `cd apps/cli && bun test` passes; `cd packages/shared && bun test` passes (covering the updated/removed phantom-asserting tests).
13. **Release notes updated.** A bullet is appended to `apps/electron/resources/release-notes/next.md` under Improvements (rename) and Breaking Changes (`kata-cli` → `kata-agents-cli`; `kata-agent` commands-CLI references and `kataAgentsCli` feature flag removed pending a future build), following the file's existing format.
