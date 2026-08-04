---
type: Report
title: Provider-aware reasoning levels build report
description: Build evidence for provider-aware reasoning settings across OpenAI, ChatGPT/Codex, Copilot, and Pi-managed models.
status: Completed
migrated: false
archived_at: 2026-08-04T16:24:02Z
---

> **Completed before migration** (status: Completed). Retained as history. Not tracked in GitHub Issues.

# Provider-aware reasoning levels build report

## Spec

[2026-08-01-provider-aware-reasoning-levels-design.md](2026-08-01-provider-aware-reasoning-levels-design.md)

Base SHA: `56f446a3`
Initial implementation HEAD: `d5098b200088d5729a9c1baa782574493364f3e9`
Pi 0.83 reconciliation: `a7c69c50` adopts native Pi model metadata and native `max` mapping while retaining model-ID normalization.

## Completed work

- Added the shared `minimal` level, Anthropic low-effort mapping, Pi minimal mapping, validation, persistence, automation, spawn, and locale coverage.
- Added renderer-safe `supportedThinkingLevels` metadata for native Pi catalogs, Anthropic, and Copilot model paths.
- Added provider-scoped hydration for persisted string-only Pi model entries.
- Updated the full composer, compact selector, app settings, and workspace settings to filter and normalize model-specific levels.
- Preserved provider-reported Pi capabilities, including native `max`, and normalized `pi/`-prefixed and bare model IDs before resolving renderer capabilities.
- Restored persisted app-level defaults for new sessions while preserving existing session values when the app default changes.
- Added bundle smoke verification at `scripts/verify-pi-agent-server-bundle.ts`.
- Added the pending release-note entry.

## Verification evidence

- Focused reasoning/provider/renderer suite: **161 passed, 0 failed** across 15 files, including native Pi catalog, native `max`, and model-ID normalization regressions.
- `cd packages/shared && bun run tsc --noEmit`: passed.
- `cd packages/server-core && bun run typecheck`: passed.
- `cd packages/pi-agent-server && bun run typecheck`: passed.
- `cd apps/electron && bun run typecheck`: passed.
- `bun run lint:i18n:parity`: passed.
- `bun run lint:i18n:sorted`: passed.
- `bun run server:build:subprocess && bun apps/electron/scripts/stage-subprocesses.ts`: passed.
- `bun run verify:pi-agent-server-bundle`: passed. The generated resource contains the `minimal` Pi mapping, `set_thinking_level` handling, and passes `node --check`.

The generated Electron Pi resource is intentionally ignored by `.gitignore`; the repository build path regenerates it before packaging and the smoke script verifies the generated artifact.

## Review gates

- Independent spec-compliance review: passed after the nearest-level, renderer-test, provider-DTO, status, documentation, native Pi catalog, and model-ID normalization fixes.
- Independent code-quality review: passed after provider identity, malformed capability, session-default preservation, generated-resource verification, native Pi catalog, and model-ID normalization concerns were addressed.

## Manual verification

Credential-backed Electron model-menu review was not run in this build because no provider credentials or E2E session were supplied. The renderer capability helper has focused coverage for OpenAI/Codex-style capabilities, native `xhigh` and `max`, `minimal`, compatibility fallback, non-reasoning models, and `pi/`-prefixed model IDs.

## Approved deviations

None. The generated Pi server resource remains untracked by the repository's existing generated-resource ignore rule.
