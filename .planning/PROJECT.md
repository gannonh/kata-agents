# Kata Agents

## What This Is

Native desktop client for the Kata ecosystem — a hard fork of Craft Agents rebranded and positioned as the desktop interface for Kata's multi-agent orchestration platform. v0.4.0 shipped with full trademark compliance and CI/CD infrastructure.

## Core Value

A compliant, independent rebrand that preserves all existing functionality while establishing Kata Agents as its own product — ready for Kata Orchestrator integration.

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

<!-- v0.4.0 Foundation milestone -->

- ✓ Remove "Craft" from product name, metadata, and UI — v0.4.0
- ✓ Replace all Craft logos and icons with Kata branding — v0.4.0
- ✓ Update bundle ID to `sh.kata.desktop` — v0.4.0
- ✓ Remove/replace `craft.do` domain references — v0.4.0
- ✓ Configure GitHub releases for distribution — v0.4.0
- ✓ CI/CD workflows for PR validation and releases — v0.4.0
- ✓ Upstream management documentation — v0.4.0

### Active

<!-- v0.5.0 Git Integration milestone -->

- [ ] Display current git branch in workspace UI
- [ ] Show linked PR title and status when one exists
- [ ] Research and implement optimal UI placement for git status

### Future

- [ ] Set up kata.sh infrastructure (website, update server)
- [ ] Kata Orchestrator integration
- [ ] Re-enable Slack OAuth with Kata relay server

### Out of Scope

- Kata Context integration — future, not yet defined
- Custom MCP server hosting — use third-party or self-hosted

## Current Milestone: v0.5.0 Git Integration

**Goal:** Show developers their git context (branch, PR) in the workspace UI while working with the agent.

**Target features:**
- Git branch display in workspace
- Linked PR title and status
- Thoughtful UI placement (research-driven)

## Current State

**Shipped:** v0.4.0 Foundation (2026-01-30)

**Codebase:**
- 191 files changed since fork
- 8,048 lines added, 837 removed
- 2 phases, 6 plans completed

**Tech stack:**
- Electron + React + Vite + shadcn/ui
- Claude Agent SDK for AI execution
- Bun for scripts and testing

**Distribution:**
- macOS: DMG (arm64, x64) with code signing and notarization
- Windows: NSIS installer (x64)
- Linux: AppImage (x64)
- Auto-update via GitHub Releases

## Context

**Origin:** Hard fork of [Craft Agents](https://github.com/AiCodecraft/craft-agents) by Craft Docs Ltd., Apache 2.0 licensed.

**Legal obligations (from TRADEMARK.md):**
1. ✓ Choose a different name not including "Craft" (Kata Agents)
2. ✓ Remove or replace all Craft logos and icons
3. ✓ Update bundle ID from `com.lukilabs.craft-agent`
4. ✓ Remove references to `craft.do` domains

**Preserved files (Apache 2.0 requirement):**
- `LICENSE` — original copyright notice
- `NOTICE` — Craft Docs Ltd. attribution

**Kata ecosystem:**
- **Kata Orchestrator** — Multi-agent framework (Claude Code plugin)
- **Kata Agents** — Native client (this project)
- **Kata Context** — Future memory/context API

**Disabled features (await infrastructure):**
- Slack OAuth (needs HTTPS relay at kata.sh)
- External docs links (needs docs.kata.sh)
- Version manifest API (needs kata.sh endpoint)

## Constraints

- **Compatibility**: Keep all existing features working
- **Dependencies**: Maintain compatibility with Claude Agent SDK and MCP
- **Platforms**: Continue supporting macOS (arm64, x64), Windows (x64), Linux (x64)

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Bundle ID: `sh.kata.desktop` | Reversed from owned domain kata.sh, avoids conflicts | ✓ Good |
| Keep all existing features | Minimize rebrand scope, ship faster | ✓ Good |
| Apache 2.0 compliance via LICENSE/NOTICE only | Legal minimum, no UI attribution needed | ✓ Good |
| Phase rebrand before Kata integration | Clean separation of concerns, validate rebrand works | ✓ Good |
| GitHub Releases for auto-update | No custom infrastructure needed initially | ✓ Good |
| Graceful disable for Slack OAuth | Keep implementation, show clear error message | ✓ Good |
| Support both KATA_ and CRAFT_ env vars | Backward compatibility for existing users | ✓ Good |

---
*Last updated: 2026-02-01 after v0.5.0 milestone started*
