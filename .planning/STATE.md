# Project State: Kata Agents

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-07)

**Core value:** Developer-centric AI desktop client that understands your git workflow and provides contextual assistance.
**Current focus:** v0.7.0 Always-On Assistant

---

## Current Position

**Milestone:** v0.7.0 Always-On Assistant
**Phase:** 10 — Foundation Types and Permission Mode
**Plan:** N/A
**Status:** Roadmap created, ready to plan Phase 10

```
Progress: [          ] 0% (roadmap created, 5 phases defined)
```

---

## Performance Metrics

**Milestone velocity:**
- v0.4.0: 10 requirements in 2 phases (6 plans)
- v0.6.0: 12 requirements in 5 phases (14 plans)
- v0.6.1: 10 requirements in 2 phases (6 plans) — 2 days

---

## Accumulated Context

### Key Decisions

See PROJECT.md Key Decisions table for full history.

**v0.7.0 architecture decision (brainstorm 2026-02-07):**
- Hybrid architecture selected over minimal (NanoClaw-style) and gateway (OpenClaw-style)
- Daemon as Bun subprocess of Electron (not WebSocket gateway)
- Plugin contract with 3 registration methods (registerChannel/registerTool/registerService)
- Dual ingress channel adapter (poll/subscribe)
- New `daemon` permission mode with tool allowlist
- SQLite for daemon state, first-party plugins only
- launchd/systemd deferred to v0.8.0+
- Full brainstorm: .planning/brainstorms/2026-02-07T06-16-brainstorm/SUMMARY.md

### Active Todos

None — defining requirements.

### Known Blockers

None.

### Technical Debt

**From v0.6.0:**
- GitStatusBadge.tsx exists but unused (inline GitBranchBadge used instead)
- Deprecated GET_GIT_BRANCH channel retained for backward compatibility
- isGitRepository() exported but not called externally

**From v0.6.1:**
- Coverage thresholds set conservatively (regression guard, not aspirational)
- MCP and workspace switching E2E tests deferred
- Mock infrastructure for CI-based chat/MCP testing deferred (issue #49)

---

## Session Continuity

**Last session:** 2026-02-07
**Stopped at:** Roadmap created for v0.7.0 (5 phases, 17 requirements mapped)
**Resume file:** None

**Next action:** Plan Phase 10 (Foundation Types and Permission Mode)

---

_Last updated: 2026-02-07 after v0.7.0 roadmap created_
