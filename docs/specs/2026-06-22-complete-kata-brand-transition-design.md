---
type: Spec
title: Complete Kata Brand Transition
description: Hard-cutover plan to finish the Kata Agents brand transition across package identity, runtime identity, app surfaces, bundled resources, docs, and release infrastructure with zero legacy Craft compatibility.
tags: [rebrand, kata, package-rename, identity, cli, electron, server, hard-cutover]
timestamp: 2026-06-22T00:00:00Z
---

# Complete Kata Brand Transition

## Status

- **Plan**: Approved 2026-06-22. User intent: one spec to complete the brand transition. If implementation is too large for one PR, split Build into smaller PRs under this spec. Adversarial review completed with no remaining blocker or major issues after revision.
- **Build**: Implemented 2026-06-22. See [build report](2026-06-22-complete-kata-brand-transition-build-report.md).
- **Verify**: Completed 2026-06-23. All 12 acceptance criteria pass after fixing a broken tool icon, Craft-named brand assets, dead `CraftAppIcon` code, a `copy-assets.ts` stale-file hygiene bug, GitHub org refs, and mock/test data. See [verify report](2026-06-23-complete-kata-brand-transition-verify-report.md). Packaged `Info.plist` confirmed `sh.kata.agents` / `Kata Agents`; residual scans report only allowlisted Craft references.

## Goal

Complete the transition from Craft Agents to Kata Agents across the repository with a hard cutover and zero legacy support.

The target end state is a repository, desktop app, headless server, CLI, web UI, session viewer, bundled resources, docs, package graph, runtime identity, release pipeline, and diagnostics surface that use Kata naming as the canonical identity. Craft naming remains only where it is legally required upstream attribution or where it refers to the separate Craft document product/source integration.

## Decisions

- **One planning spec**: use this document as the complete brand-transition plan.
- **Split implementation as needed**: if the work is too large for one PR, ship smaller PRs that each complete a coherent phase from this spec.
- **Zero legacy support**: there are no current users to preserve. Do not add compatibility shims, migrations, aliases, or dual registrations for Craft-era names.
- **Kata package scope**: use `@kata-sh/*` for workspace packages, matching the existing roadmap note.
- **Config directory**: use `~/.kata-agents` as the runtime config/data directory. Use `KATA_CONFIG_DIR` as the override.
- **URL scheme**: use `kataagents://` as the desktop deep-link scheme.
- **App ID**: use `sh.kata.agents` for Electron packaged builds.
- **Env prefix**: use `KATA_*` for runtime environment variables. Every repo-owned `CRAFT_*` variable becomes the same suffix under `KATA_*`.
- **Public domains**: use `agents.kata.sh` for the viewer, docs, docs MCP endpoint, OAuth relay, release-facing homepage metadata, and app help links. This phase is blocked if the maintainer cannot provision or approve that domain before implementation.
- **Legal posture**: `LICENSE` is the source of truth. App/package author and maintainer metadata should align to `Gannon Hall` ownership. Keep the upstream Craft Agents attribution in `LICENSE`.

## Current state

The repository has completed Phase 1 user-facing desktop rebrand and CI/release work, but the brand transition is incomplete across package identity, runtime identity, and secondary app surfaces.

Verified examples from repository scans:

- Workspace package names still use `@craft-agent/*` across Electron, shared, core, server, UI, CLI, viewer, webui, messaging, and session tool packages.
- Root package name remains `craft-agent`.
- Runtime scripts and app code still use `CRAFT_*` environment variables.
- The app identity still uses `com.lukilabs.craft-agent`.
- The deep-link scheme still uses `craftagents://`.
- Runtime paths and docs still reference `~/.craft-agent` and `.craft-agent`.
- Server and release metadata still reference `agents.craft.do`.
- Bundled resources still include Craft-named docs, tool icons, binaries, logos, config descriptions, and theme authors.
- CLI, server, viewer, webui, package descriptions, comments, and generated help still include `Craft Agent(s)` references.
- `LICENSE` now records `Copyright 2026 Gannon Hall.` and keeps an upstream Craft Agents attribution.
- No root `NOTICE` file currently exists.

The DMG background asset appears to be an abstract light background. This spec does not assume it needs visual replacement unless implementation or verification finds a Craft-branded mark in the packaged installer.

## Current-to-target identity map

| Surface | Current | Target |
|---------|---------|--------|
| Root package | `craft-agent` | `kata-agents` |
| Package scope | `@craft-agent/*` | `@kata-sh/*` |
| Electron package | `@craft-agent/electron` | `@kata-sh/electron` |
| CLI package | `@craft-agent/cli` | `@kata-sh/cli` |
| CLI binary | `craft-cli` | `kata-cli` |
| Server package | `@craft-agent/server` | `@kata-sh/server` |
| Server binary | `craft-server` | `kata-server` |
| Core package | `@craft-agent/core` | `@kata-sh/core` |
| Shared package | `@craft-agent/shared` | `@kata-sh/shared` |
| Server core package | `@craft-agent/server-core` | `@kata-sh/server-core` |
| UI package | `@craft-agent/ui` | `@kata-sh/ui` |
| Viewer package | `@craft-agent/viewer` | `@kata-sh/viewer` |
| Web UI package | `@craft-agent/webui` | `@kata-sh/webui` |
| Messaging gateway package | `@craft-agent/messaging-gateway` | `@kata-sh/messaging-gateway` |
| WhatsApp worker package | `@craft-agent/messaging-whatsapp-worker` | `@kata-sh/messaging-whatsapp-worker` |
| Pi agent server package | `@craft-agent/pi-agent-server` | `@kata-sh/pi-agent-server` |
| Session MCP server package | `@craft-agent/session-mcp-server` | `@kata-sh/session-mcp-server` |
| Session tools package | `@craft-agent/session-tools-core` | `@kata-sh/session-tools-core` |
| Electron app ID | `com.lukilabs.craft-agent` | `sh.kata.agents` |
| Deep-link scheme | `craftagents://` | `kataagents://` |
| Config/data directory | `~/.craft-agent`, `.craft-agent` | `~/.kata-agents`, `.kata-agents` |
| Env prefix | `CRAFT_*` | `KATA_*` |
| Public app/docs/viewer host | `agents.craft.do` | `agents.kata.sh` |
| Docs MCP source id | `craft-agents-docs` | `kata-agents-docs` |
| Docs MCP URL | `https://agents.craft.do/docs/mcp` | `https://agents.kata.sh/docs/mcp` |
| OAuth relay callback | `https://agents.craft.do/auth/callback` | `https://agents.kata.sh/auth/callback` |
| Slack OAuth relay callback | `https://agents.craft.do/auth/slack/callback` | `https://agents.kata.sh/auth/slack/callback` |
| Co-author email | `agents-noreply@craft.do` | `agents-noreply@kata.sh` |
| App/package owner metadata | `Craft Docs Ltd. <support@craft.do>` | `Gannon Hall` or `Gannon Hall <support@kata.sh>` where an email is required |

## Environment and CRAFT_* symbol map

Every repo-owned `CRAFT_*` environment variable, constant, schema key, script variable, and generated metadata key becomes the same suffix under `KATA_*`, except names with an embedded product slug change that embedded slug too. There are no aliases or fallback reads. The baseline scan inventory for this spec is:

- `CRAFT_AGENT_CLI_VERSION` -> `KATA_AGENT_CLI_VERSION`
- `CRAFT_AGENT_CONFIG_PATTERNS` -> `KATA_AGENT_CONFIG_PATTERNS`
- `CRAFT_AGENT_DIR` -> `KATA_AGENT_DIR`
- `CRAFT_AGENT_ID` -> `KATA_AGENT_ID`
- `CRAFT_AGENT_TYPE` -> `KATA_AGENT_TYPE`
- `CRAFT_AGENT_VERSION` -> `KATA_AGENT_VERSION`
- `CRAFT_AGENTS_CLI_BASH_GUARD_SCOPE_ENTRIES` -> `KATA_AGENTS_CLI_BASH_GUARD_SCOPE_ENTRIES`
- `CRAFT_AGENTS_CLI_OWNED_BASH_GUARD_PATH_SCOPES` -> `KATA_AGENTS_CLI_OWNED_BASH_GUARD_PATH_SCOPES`
- `CRAFT_AGENTS_CLI_OWNED_WORKSPACE_PATH_SCOPES` -> `KATA_AGENTS_CLI_OWNED_WORKSPACE_PATH_SCOPES`
- `CRAFT_AGENTS_CLI_WORKSPACE_SCOPE_ENTRIES` -> `KATA_AGENTS_CLI_WORKSPACE_SCOPE_ENTRIES`
- `CRAFT_ANTHROPIC_API_KEY` -> `KATA_ANTHROPIC_API_KEY`
- `CRAFT_APP_NAME` -> `KATA_APP_NAME`
- `CRAFT_APP_ROOT` -> `KATA_APP_ROOT`
- `CRAFT_BROWSER_OPEN_SETTLE_POLL_MS` -> `KATA_BROWSER_OPEN_SETTLE_POLL_MS`
- `CRAFT_BROWSER_OPEN_SETTLE_TIMEOUT_MS` -> `KATA_BROWSER_OPEN_SETTLE_TIMEOUT_MS`
- `CRAFT_BUN` -> `KATA_BUN`
- `CRAFT_BUN_BIN` -> `KATA_BUN_BIN`
- `CRAFT_BUNDLED_ASSETS_ROOT` -> `KATA_BUNDLED_ASSETS_ROOT`
- `CRAFT_CLI_DOC_PATH` -> `KATA_CLI_DOC_PATH`
- `CRAFT_CLI_ENTRY` -> `KATA_CLI_ENTRY`
- `CRAFT_CLI_JSON_ONLY` -> `KATA_CLI_JSON_ONLY`
- `CRAFT_COMMANDS_BIN` -> `KATA_COMMANDS_BIN`
- `CRAFT_COMMANDS_DOC_PATH` -> `KATA_COMMANDS_DOC_PATH`
- `CRAFT_COMMANDS_ENTRY` -> `KATA_COMMANDS_ENTRY`
- `CRAFT_CONFIG_DIR` -> `KATA_CONFIG_DIR`
- `CRAFT_DEBUG` -> `KATA_DEBUG`
- `CRAFT_DEBUG_SSE_RAW` -> `KATA_DEBUG_SSE_RAW`
- `CRAFT_DEEPLINK_SCHEME` -> `KATA_DEEPLINK_SCHEME`
- `CRAFT_DEEPLINK_SCHEME_PREFIX` -> `KATA_DEEPLINK_SCHEME_PREFIX`
- `CRAFT_DEV_RUNTIME` -> `KATA_DEV_RUNTIME`
- `CRAFT_DISPLAY_NAME_KEY` -> `KATA_DISPLAY_NAME_KEY`
- `CRAFT_DISPLAY_NAME_SCHEMA` -> `KATA_DISPLAY_NAME_SCHEMA`
- `CRAFT_E2E_RELEASE_APP` -> `KATA_E2E_RELEASE_APP`
- `CRAFT_ERROR` -> `KATA_ERROR`
- `CRAFT_EVENT` -> `KATA_EVENT`
- `CRAFT_EVENT_DATA` -> `KATA_EVENT_DATA`
- `CRAFT_FEATURE_CRAFT_AGENTS_CLI` -> `KATA_FEATURE_KATA_AGENTS_CLI`
- `CRAFT_FEATURE_DEVELOPER_FEEDBACK` -> `KATA_FEATURE_DEVELOPER_FEEDBACK`
- `CRAFT_FEATURE_EMBEDDED_SERVER` -> `KATA_FEATURE_EMBEDDED_SERVER`
- `CRAFT_HEADLESS` -> `KATA_HEADLESS`
- `CRAFT_HEALTH_PORT` -> `KATA_HEALTH_PORT`
- `CRAFT_INSTANCE_NUMBER` -> `KATA_INSTANCE_NUMBER`
- `CRAFT_INTENT_KEY` -> `KATA_INTENT_KEY`
- `CRAFT_INTENT_SCHEMA` -> `KATA_INTENT_SCHEMA`
- `CRAFT_INTERCEPTOR_DISABLE_AUTO_INSTALL` -> `KATA_INTERCEPTOR_DISABLE_AUTO_INSTALL`
- `CRAFT_IS_FLAGGED` -> `KATA_IS_FLAGGED`
- `CRAFT_IS_PACKAGED` -> `KATA_IS_PACKAGED`
- `CRAFT_LABEL` -> `KATA_LABEL`
- `CRAFT_LLM_CALLBACK_PORT` -> `KATA_LLM_CALLBACK_PORT`
- `CRAFT_MCP_URL` -> `KATA_MCP_URL`
- `CRAFT_MCP_TOKEN` -> `KATA_MCP_TOKEN`
- `CRAFT_LOCAL_DATE` -> `KATA_LOCAL_DATE`
- `CRAFT_LOCAL_MCP_ENABLED` -> `KATA_LOCAL_MCP_ENABLED`
- `CRAFT_LOCAL_TIME` -> `KATA_LOCAL_TIME`
- `CRAFT_LOGO` -> `KATA_LOGO`
- `CRAFT_LOGO_HTML` -> `KATA_LOGO_HTML`
- `CRAFT_MESSAGE` -> `KATA_MESSAGE`
- `CRAFT_MESSAGING_NODE_BIN` -> `KATA_MESSAGING_NODE_BIN`
- `CRAFT_MESSAGING_WA_WORKER` -> `KATA_MESSAGING_WA_WORKER`
- `CRAFT_MODEL` -> `KATA_MODEL`
- `CRAFT_NEW_MODE` -> `KATA_NEW_MODE`
- `CRAFT_NEW_STATE` -> `KATA_NEW_STATE`
- `CRAFT_NODE` -> `KATA_NODE`
- `CRAFT_OLD_MODE` -> `KATA_OLD_MODE`
- `CRAFT_OLD_STATE` -> `KATA_OLD_STATE`
- `CRAFT_PI_MODEL_API` -> `KATA_PI_MODEL_API`
- `CRAFT_PI_MODEL_BASE_URL` -> `KATA_PI_MODEL_BASE_URL`
- `CRAFT_PI_MODEL_PROVIDER` -> `KATA_PI_MODEL_PROVIDER`
- `CRAFT_PORT_OFFSET` -> `KATA_PORT_OFFSET`
- `CRAFT_PROMPT` -> `KATA_PROMPT`
- `CRAFT_RESOURCES_BASE` -> `KATA_RESOURCES_BASE`
- `CRAFT_RESOURCES_PATH` -> `KATA_RESOURCES_PATH`
- `CRAFT_RPC_HOST` -> `KATA_RPC_HOST`
- `CRAFT_RPC_PORT` -> `KATA_RPC_PORT`
- `CRAFT_RPC_TLS_CA` -> `KATA_RPC_TLS_CA`
- `CRAFT_RPC_TLS_CERT` -> `KATA_RPC_TLS_CERT`
- `CRAFT_RPC_TLS_KEY` -> `KATA_RPC_TLS_KEY`
- `CRAFT_SCRIPTS` -> `KATA_SCRIPTS`
- `CRAFT_SERVER_TOKEN` -> `KATA_SERVER_TOKEN`
- `CRAFT_SERVER_URL` -> `KATA_SERVER_URL`
- `CRAFT_SESSION_DIR` -> `KATA_SESSION_DIR`
- `CRAFT_SESSION_ID` -> `KATA_SESSION_ID`
- `CRAFT_SESSION_METADATA` -> `KATA_SESSION_METADATA`
- `CRAFT_SESSION_NAME` -> `KATA_SESSION_NAME`
- `CRAFT_SOURCE` -> `KATA_SOURCE`
- `CRAFT_THEME_OBSERVER_CLEANUP__` -> `KATA_THEME_OBSERVER_CLEANUP__`
- `CRAFT_TITLE` -> `KATA_TITLE`
- `CRAFT_TLS_CA` -> `KATA_TLS_CA`
- `CRAFT_TOOL_INPUT` -> `KATA_TOOL_INPUT`
- `CRAFT_TOOL_NAME` -> `KATA_TOOL_NAME`
- `CRAFT_TOOL_RESPONSE` -> `KATA_TOOL_RESPONSE`
- `CRAFT_TRANSFER_TTL_MS` -> `KATA_TRANSFER_TTL_MS`
- `CRAFT_USER` -> `KATA_USER`
- `CRAFT_UV` -> `KATA_UV`
- `CRAFT_VCREDIST_MISSING` -> `KATA_VCREDIST_MISSING`
- `CRAFT_VCREDIST_URL` -> `KATA_VCREDIST_URL`
- `CRAFT_VERSION` -> `KATA_VERSION`
- `CRAFT_VITE_PORT` -> `KATA_VITE_PORT`
- `CRAFT_WEBUI_DIR` -> `KATA_WEBUI_DIR`
- `CRAFT_WEBUI_PASSWORD` -> `KATA_WEBUI_PASSWORD`
- `CRAFT_WEBUI_PORT` -> `KATA_WEBUI_PORT`
- `CRAFT_WEBUI_SECURE_COOKIE` -> `KATA_WEBUI_SECURE_COOKIE`
- `CRAFT_WEBUI_URL` -> `KATA_WEBUI_URL`
- `CRAFT_WEBUI_WS_URL` -> `KATA_WEBUI_WS_URL`
- `CRAFT_WH_` -> `KATA_WH_`
- `CRAFT_WH_API_TOKEN` -> `KATA_WH_API_TOKEN`
- `CRAFT_WH_CLIENT_ID` -> `KATA_WH_CLIENT_ID`
- `CRAFT_WH_CLIENT_SECRET` -> `KATA_WH_CLIENT_SECRET`
- `CRAFT_WH_DISCORD_TOKEN` -> `KATA_WH_DISCORD_TOKEN`
- `CRAFT_WH_DISCORD_URL` -> `KATA_WH_DISCORD_URL`
- `CRAFT_WH_EVENT` -> `KATA_WH_EVENT`
- `CRAFT_WH_PASS` -> `KATA_WH_PASS`
- `CRAFT_WH_SESSION_ID` -> `KATA_WH_SESSION_ID`
- `CRAFT_WH_SLACK_PATH` -> `KATA_WH_SLACK_PATH`
- `CRAFT_WH_SLACK_URL` -> `KATA_WH_SLACK_URL`
- `CRAFT_WH_TOKEN` -> `KATA_WH_TOKEN`
- `CRAFT_WH_USER` -> `KATA_WH_USER`
- `CRAFT_WORKSPACE_ID` -> `KATA_WORKSPACE_ID`
- `CRAFT_WORKSPACE_PATH` -> `KATA_WORKSPACE_PATH`

If Build discovers another repo-owned `CRAFT_*` symbol outside historical completed docs, upstream attribution, or Craft document/source integration examples, it must rename it to the same `KATA_*` suffix and include it in the Build report. Discovery of a variable that cannot be renamed locally blocks that phase until the target is approved.
## Residual Craft allowlist

After Build, Craft references are allowed only in these forms:

| Category | Allowed examples | Notes |
|----------|------------------|-------|
| Upstream attribution | `LICENSE` line naming Craft Agents and Craft Docs Ltd. | Required by Apache attribution posture. |
| Historical completed specs/build reports | Completed OKF specs and build reports documenting previous Craft-era work, including quoted product-owned slugs such as `SearchCraftAgents` when they appear as historical evidence | Do not rewrite history solely to satisfy scans. This allowance applies only under completed historical docs, not active docs or source code. |
| Craft document/source integration | `{source:Craft}`, example text about a user's Craft workspace, source setup docs for the Craft product | These refer to the Craft document platform, not this app. |
| Third-party names or unrelated prose | Existing examples such as a user's project named `Craft iOS` | Keep if the reference is not this product identity. |

Everything else is presumed product-owned and should be renamed or removed. Product-owned slugs such as `craft-agents-docs`, `SearchCraftAgents`, `craft-agent` tool icons, `craft-agent` binaries, and `craft-logos/` are not allowed residuals.

## Scope

### Rename to Kata

- Workspace package names, imports, exports, lockfile references, build aliases, scripts, and generated metadata, following the current-to-target map above.
- Root package name and package descriptions.
- CLI package, binary names, command names, help output, docs, and server-spawn labels.
- Electron app identity including app ID, product metadata, deep-link scheme, app protocol comments, diagnostics names, log paths, and packaged resource references.
- Runtime environment variables from `CRAFT_*` to `KATA_*`.
- Runtime config/data paths from `~/.craft-agent` and `.craft-agent` to `~/.kata-agents` and `.kata-agents`.
- Headless server package, logs, startup messages, docs, webui labels, and public metadata.
- Session viewer labels, metadata, docs, package description, and UI logo labels.
- Bundled resource docs, default config descriptions, theme author strings, tool icon display names, CLI docs, resource binary names, and Craft-specific logo assets for this app.
- i18n keys and values where key names still encode Craft product naming and can be safely renamed with callsites.
- Release, update, CI, operations docs, GitHub workflow comments, artifact metadata, release notes references, and roadmap entries. This spec supersedes the old Project A/C/D split in `docs/specs/index.md`.
- Repository docs, package-level agent context files, architecture/reference docs, and OKF roadmap entries.
- Internal identifiers where they represent this product identity and can be renamed without creating avoidable churn.

### Keep Craft references only when approved

Craft may remain only in these categories:

- `LICENSE` upstream attribution to Craft Agents.
- Historical completed specs or build reports that document past work, when changing them would reduce historical accuracy.
- References to the Craft document product/source integration, including user prompts or examples that intentionally describe a user's Craft workspace, document, or source.
- Third-party package names, URLs, or source identifiers that are not this product's brand.

Every remaining Craft reference after Build must be listed in the completion report with a category and rationale.

## Out of scope

- Backward compatibility for Craft-era users, paths, env vars, package names, domains, or schemes.
- Migration from `~/.craft-agent` to `~/.kata-agents`.
- Aliases from `CRAFT_*` to `KATA_*`.
- Dual deep-link scheme registration.
- Dual package publishing under both scopes.
- Preserving old CLI binary names.
- Trademark or legal policy work beyond metadata alignment with `LICENSE`.
- Rewriting historical completed specs solely to remove accurate references to past Craft-era names.

## Acceptance criteria

1. No user-facing app, CLI, server, viewer, webui, bundled docs, release notes, package metadata, generated help text, or active repository docs refer to this product as Craft Agent or Craft Agents.
2. Workspace packages use the `@kata-sh/*` scope, root package metadata uses Kata naming, and TypeScript imports, package exports, build scripts, tests, and lockfile references no longer rely on `@craft-agent/*`.
3. CLI binaries, command docs, package scripts, packaged resources, tool icon entries, and generated help use Kata naming and no longer expose Craft-era binary names for this product.
4. Runtime environment variables use the exact `KATA_*` replacements from the environment variable map, and a repo scan for `CRAFT_[A-Z0-9_]+` finds only approved historical docs or Craft document/source references. No `CRAFT_*` aliases or fallback reads remain for this product's runtime configuration.
5. Runtime config and data paths use `~/.kata-agents` and `.kata-agents`; `KATA_CONFIG_DIR` is the only override; app/server startup creates or reads Kata paths only; no migration or fallback reads from `~/.craft-agent` remain.
6. Desktop app identity uses `sh.kata.agents`, URL scheme `kataagents://`, Kata protocol registration, Kata app metadata, Kata update metadata, Kata diagnostics/log labels, and packaged app metadata. A scan finds no active `craftagents://` registration or support path.
7. Release, update, CI, docs, OAuth relay, docs MCP, help links, homepage metadata, and publish metadata use `agents.kata.sh` targets from the identity map, and docs describe the new hard-cutover identity contract.
8. App/package author and maintainer metadata use `Gannon Hall` ownership, with `support@kata.sh` only where an email is required. Upstream Craft attribution remains only in `LICENSE` unless the maintainer explicitly approves an additional attribution file.
9. Bundled resources are cleaned so product-owned docs, config defaults, theme metadata, logos, tool icons, scripts, and binary names use Kata naming. Any retained Craft resource must be justified as a Craft document/source integration or upstream attribution.
10. i18n remains valid: all renamed user-facing strings go through translation keys present in every locale, and renamed keys remain sorted and in parity across locales.
11. Automated verification passes for package graph/import consistency, package-level typechecks, i18n parity/sort, CLI help output containing `kata-cli` and no `Craft Agent`, server startup labels containing `Kata Agent` and no `Craft Agent`, and Electron build/startup paths. Any pre-existing failing broad test suite must be documented with base-SHA evidence.
12. A final repository scan for `Craft Agent`, `Craft Agents`, `@craft-agent`, `CRAFT_`, `.craft-agent`, `craftagents`, `agents.craft.do`, `craft-cli`, and `craft-server` reports only approved residuals from the allowlist. The Build report lists each category with examples and rationale.

## Architecture and identity model

```mermaid
flowchart TD
  Brand[Kata Agents canonical brand] --> Packages[@kata-sh/* packages]
  Brand --> Runtime[KATA_* env and ~/.kata-agents]
  Brand --> Desktop[Kata app ID and kataagents:// scheme]
  Brand --> Apps[Electron, CLI, Server, Viewer, WebUI]
  Brand --> Release[CI, release, update, publish metadata]
  Brand --> Resources[Bundled docs, themes, icons, binaries]
  License[LICENSE] --> Upstream[Craft Agents upstream attribution]
  Sources[Craft document/source integration] --> ApprovedCraft[Allowed Craft references]
```

The Build should treat the brand transition as an identity graph rather than a string-replacement pass. Package names, env vars, config paths, protocol schemes, release metadata, and docs should be updated together when they form one runtime contract.

## Implementation phases

### Phase 1 - Package graph and source imports

- Rename root package name from `craft-agent` to `kata-agents`.
- Rename workspace packages from `@craft-agent/*` to `@kata-sh/*` using the current-to-target table.
- Update package descriptions for Kata naming.
- Update imports, exports, test imports, scripts, esbuild externals, Vite aliases, workflow comments, generated manifests, and lockfile entries.
- Update package-level README and CLAUDE/AGENTS context files.

Acceptance tie-in: AC 1, AC 2, AC 8, AC 11, AC 12.

### Phase 2 - Runtime identity hard cutover

- Rename `CRAFT_*` environment variables to `KATA_*` across app, server, scripts, tests, docs, and workflows using the environment variable map.
- Rename config/data directory handling from `~/.craft-agent` / `.craft-agent` to `~/.kata-agents` / `.kata-agents`, with `KATA_CONFIG_DIR` as the only override and multi-instance paths derived from the Kata directory name.
- Update config path validators, default workspace paths, release notes sync paths, credentials/config docs, and tests.
- Remove old env var reads, old path reads, and migration helpers that only support Craft-era names.

Acceptance tie-in: AC 4, AC 5, AC 11, AC 12.

### Phase 3 - Desktop app identity and release metadata

- Change Electron app identity from `com.lukilabs.craft-agent` to `sh.kata.agents`.
- Change deep-link scheme from `craftagents://` to `kataagents://`.
- Update protocol registration, OAuth callback URLs, auth-complete links, app metadata, update metadata, logging labels, diagnostics, and packaged config.
- Update release/update docs and workflows for the new identity and `agents.kata.sh` endpoints.
- Verify no release or update code still assumes Craft-era naming.

Acceptance tie-in: AC 6, AC 7, AC 11, AC 12.

### Phase 4 - Apps, CLI, server, viewer, webui, and bundled resources

- Rename CLI binary names and help output: `craft-cli` -> `kata-cli`, `craft-server` -> `kata-server`.
- Update headless server startup labels, package descriptions, docs, Docker scripts, installer scripts, and webui labels.
- Update viewer package metadata, page title, descriptions, UI labels, and logo labels.
- Update bundled resource docs, `config-defaults.json`, theme author metadata, tool icon display names, resource binary names, and app-owned logo assets.
- Re-check the DMG background during packaged verification; replace only if a Craft brand mark is visible.
- Rename product-owned docs MCP identifiers such as `craft-agents-docs` and `SearchCraftAgents` to Kata equivalents.

Acceptance tie-in: AC 1, AC 3, AC 7, AC 9, AC 11, AC 12.

### Phase 5 - i18n, docs, and OKF closeout

- Rename i18n keys that still encode Craft product naming where callsites can move safely.
- Update all locale values and keep locale files sorted and in parity.
- Update README, CONTRIBUTING, SECURITY if needed, package docs, architecture docs, reference docs, operations docs, release docs, and OKF roadmap/log files. Mark this spec as superseding the old Project A/C/D roadmap split.
- Preserve historical completed specs where Craft references are historically accurate.
- Add or update an ADR if the hard-cutover identity decision needs durable architecture record.

Acceptance tie-in: AC 1, AC 7, AC 8, AC 10, AC 12.

### Phase 6 - Verification and residual scan

- Run package-level typechecks and targeted test suites.
- Run package graph/import checks for `@craft-agent` remnants.
- Run i18n parity and sorting checks.
- Run CLI help smoke tests and server startup smoke tests.
- Run Electron build/startup checks and packaged metadata inspection.
- Run final `Craft Agent`/`Craft Agents`/`@craft-agent`/`CRAFT_`/`.craft-agent`/`craftagents`/`agents.craft.do`/`craft-cli`/`craft-server` scans, classify approved remnants against the allowlist, and attach the scan summary to the Build report.

Acceptance tie-in: AC 11, AC 12.

## Key files and areas

Likely affected areas include:

- `package.json`, `bun.lock`, workspace `package.json` files.
- `apps/electron/electron-builder.yml`, Electron main/preload/renderer source, build scripts, updater config, and resources.
- `apps/cli/**`.
- `apps/viewer/**`.
- `apps/webui/**`.
- `packages/core/**`, `packages/shared/**`, `packages/server-core/**`, `packages/server/**`, `packages/ui/**`, `packages/messaging-*`, `packages/pi-agent-server/**`, `packages/session-*`.
- `apps/electron/resources/**`.
- `.github/workflows/**`.
- `scripts/**`.
- `docs/**`, `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `TRADEMARK.md` if still relevant.
- `AGENTS.md`, package-level `CLAUDE.md` / `AGENTS.md` files.
- `LICENSE` only if an additional attribution note is required; do not remove the upstream Craft attribution.

## Verification plan

Required command-level checks:

- `bun install` or equivalent lockfile refresh after package renames.
- `bun run typecheck:all` if root config is fixed; otherwise package-level typechecks with documented base-SHA limitation.
- `cd packages/core && bun run tsc --noEmit`.
- `cd packages/shared && bun run tsc --noEmit`.
- `cd packages/ui && bun run tsc --noEmit`.
- `cd apps/cli && bun run typecheck`.
- `cd apps/electron && bun run typecheck`.
- `cd apps/viewer && bun run typecheck`.
- `cd apps/webui && bun run typecheck`.
- `cd packages/messaging-gateway && bun run typecheck`.
- `cd packages/messaging-whatsapp-worker && bun run typecheck`.
- `cd packages/pi-agent-server && bun run typecheck`.
- `cd packages/server-core && bun run typecheck`.
- `cd packages/server && bun run typecheck`.
- `cd packages/session-tools-core && bun run typecheck`.
- `cd packages/session-mcp-server && bun run build`.
- `bun run lint:i18n:parity`.
- `bun run lint:i18n:sorted`.
- CLI help smoke test for the renamed binary/entry point, for example `bun run apps/cli/src/index.ts --help`, with output containing `kata-cli` and no `Craft Agent`.
- Headless server startup smoke test using `KATA_CONFIG_DIR=$(mktemp -d)` and the renamed server entry point, with logs containing Kata labels and no `Craft Agent`.
- Electron build/startup smoke test using `KATA_CONFIG_DIR=$(mktemp -d)`, proving app name, app ID metadata, scheme registration, and config path behavior.
- Package metadata check, for example a script that reads all workspace `package.json` files and fails on `@craft-agent`, `Craft Agent`, `Craft Agents`, `craft-cli`, or `craft-server`.
- Final scan commands for `Craft Agent`, `Craft Agents`, `@craft-agent`, `CRAFT_`, `.craft-agent`, `craftagents`, `agents.craft.do`, `craft-cli`, and `craft-server`; all matches must be categorized against the residual allowlist.

Manual or packaged checks:

- Packaged macOS app metadata shows Kata identity.
- Deep link opens via `kataagents://`; `craftagents://` is not registered by this app.
- App creates or reads only `~/.kata-agents` for new runtime data.
- DMG title and visible installer contents use Kata identity. Replace DMG background only if visible Craft branding is confirmed.

## Risks and mitigations

- **Large package rename blast radius**: split Build into phases, keep each PR mechanically verifiable, and run import/package graph checks after each phase.
- **Hidden runtime assumptions around config paths or env vars**: update tests that cover config loading, credentials, release notes sync, server startup, and Electron launch env.
- **Release/update identity coupling**: update release docs and workflows in the same phase as Electron identity changes.
- **Craft document integration false positives**: classify allowed Craft references before removing them. Keep references that describe the user's Craft source or workspace.
- **Historical docs churn**: do not rewrite completed specs solely for brand scans. Final scans should classify historical docs separately.
- **Broken broad validation on base SHA**: if broad commands fail for pre-existing reasons, record base-SHA evidence and run targeted checks that prove the changed surfaces.

## Build handoff

- **Approved scope**: complete hard-cutover brand transition to Kata across packages, runtime identity, desktop identity, CLI/server/viewer/webui, bundled resources, release metadata, docs, and verification.
- **Non-goals**: compatibility shims, old env aliases, config migration, dual schemes, dual package scopes, broad legal restructuring, historical-doc rewrites.
- **Required implementation posture**: zero legacy support.
- **Recommended PR split**: package graph -> runtime identity -> desktop/release identity -> apps/resources -> docs/i18n -> verification scan. Each PR must include its phase-level acceptance evidence and must not leave that phase with mixed Craft/Kata canonical names.
- **Required final evidence**: command results, packaged/runtime smoke evidence, and classified residual Craft scan.
- **Blocking questions**: none. If a phase discovers an external service or domain dependency that cannot be renamed locally, stop and ask for the target Kata domain/service identity before implementing that portion.
