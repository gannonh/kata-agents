# Kata Desktop

## What This Is

Native desktop client for the Kata ecosystem — a hard fork of Craft Agents rebranded and positioned as the desktop interface for Kata's multi-agent orchestration platform. Initially meeting Apache 2.0 trademark obligations, then evolving into the native Kata client.

## Core Value

A compliant, independent rebrand that preserves all existing functionality while establishing Kata Desktop as its own product — ready for Kata Orchestrator integration.

## Requirements

### Validated

<!-- Inherited from Craft Agents codebase -->

- ✓ Multi-process Electron desktop app (main/renderer/preload) — existing
- ✓ Claude Agent SDK integration for AI code execution — existing
- ✓ Chat interface with real-time message streaming — existing
- ✓ Session persistence to disk with conversation history — existing
- ✓ Multi-workspace support with independent sessions — existing
- ✓ OAuth authentication (Google, Slack, Microsoft) — existing
- ✓ API key authentication for Anthropic — existing
- ✓ MCP (Model Context Protocol) server integration — existing
- ✓ Tool permissions management with user approval — existing
- ✓ Auto-update mechanism via electron-updater — existing
- ✓ Cross-platform builds (macOS, Windows, Linux) — existing
- ✓ Sentry error tracking integration — existing

### Active

<!-- Rebrand phase -->

- [ ] Remove "Craft" from product name, metadata, and UI
- [ ] Replace all Craft logos and icons with Kata branding
- [ ] Update bundle ID to `sh.kata.desktop`
- [ ] Remove/replace `craft.do` domain references
- [ ] Set up kata.sh update server endpoint
- [ ] Configure GitHub releases for distribution

### Out of Scope

- Feature additions during rebrand phase — keep scope minimal, just trademark compliance
- Removing existing features (OAuth, MCP, etc.) — keep everything working
- Kata Orchestrator integration — Phase 2, after clean rebrand ships
- Kata Context integration — future, not yet defined

## Current Milestone: v0.4.0 Foundation

**Goal:** Establish Kata Desktop as an independent, compliant fork with proper tooling before any feature work.

**Target features:**
- CI/CD pipelines and build automation
- Upstream management strategy and documentation
- Complete trademark compliance (remove all Craft references)
- Kata branding (logos, icons, bundle ID)
- Domain and distribution infrastructure setup

## Context

**Origin:** Hard fork of [Craft Agents](https://github.com/AiCodecraft/craft-agents) by Craft Docs Ltd., Apache 2.0 licensed.

**Legal obligations (from TRADEMARK.md):**
1. Choose a different name not including "Craft" ✓ (Kata Desktop)
2. Remove or replace all Craft logos and icons
3. Update bundle ID from `com.lukilabs.craft-agent`
4. Remove references to `craft.do` domains

**Files requiring changes:**
- `apps/electron/electron-builder.yml` — product name, bundle ID, copyright
- `apps/electron/resources/` — application icons
- `packages/shared/src/branding.ts` — service URLs

**Preserved files (Apache 2.0 requirement):**
- `LICENSE` — original copyright notice
- `NOTICE` — Craft Docs Ltd. attribution

**Kata ecosystem:**
- **Kata Orchestrator** — Multi-agent framework (currently Claude Code plugin)
- **Kata Desktop** — Native client (this project)
- **Kata Context** — Future memory/context API

**Infrastructure planned:**
- Website: kata.sh
- Update server: TBD (host auto-update releases)
- Distribution: GitHub releases

## Constraints

- **Legal**: Must meet TRADEMARK.md obligations before any public release
- **Compatibility**: Keep all existing features working during rebrand
- **Dependencies**: Maintain compatibility with Claude Agent SDK and MCP
- **Platforms**: Continue supporting macOS (arm64, x64), Windows (x64), Linux (x64)

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Bundle ID: `sh.kata.desktop` | Reversed from owned domain kata.sh, avoids conflicts | — Pending |
| Keep all existing features | Minimize rebrand scope, ship faster | — Pending |
| Apache 2.0 compliance via LICENSE/NOTICE only | Legal minimum, no UI attribution needed | — Pending |
| Phase rebrand before Kata integration | Clean separation of concerns, validate rebrand works | — Pending |

---
*Last updated: 2026-01-29 after initialization*
