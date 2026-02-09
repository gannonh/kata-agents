# Project State: Kata Agents

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-07)

**Core value:** Developer-centric AI desktop client that understands your git workflow and provides contextual assistance.
**Current focus:** v0.7.0 Always-On Assistant

---

## Current Position

**Milestone:** v0.7.0 Always-On Assistant
**Phase:** 13 — Plugin Lifecycle and Task Scheduler (complete)
**Plan:** 03 of 3 (all complete)
**Status:** Phase complete
**Last activity:** 2026-02-09 — Completed 13-03-PLAN.md

```
Progress: [██████████] 100% (10 of 10 plans complete across 5 phases)
```

---

## Performance Metrics

**Milestone velocity:**
- v0.4.0: 10 requirements in 2 phases (6 plans)
- v0.6.0: 12 requirements in 5 phases (14 plans)
- v0.6.1: 10 requirements in 2 phases (6 plans) -- 2 days

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

**Phase 11 Plan 01 decisions:**
- SQLite snake_case columns mapped to camelCase QueuedMessage fields at the dequeue boundary
- Payload stored as JSON TEXT, serialized on enqueue, deserialized on dequeue

**Phase 11 Plan 02 decisions:**
- CONFIG_DIR computed inline in electron main process (no subpath export for config/paths)
- DaemonManager does not auto-start; Phase 12+ triggers start when channels are configured

**Phase 12 Plan 02 decisions:**
- ChannelRunner accepts optional AdapterFactory constructor parameter (avoids bun:test module mock cross-contamination)
- Daemon entry uses state object pattern for mutable ChannelRunner reference (TypeScript narrowing workaround)

**Phase 12 Plan 03 decisions:**
- Baileys compatible with Bun (QR received, connection events fire; ws warnings are edge cases)
- QrCallback observer pattern instead of stored QR state
- stopping flag guards against reconnect loops during shutdown

**Phase 13 Plan 03 decisions:**
- Daemon collects enabledPlugins as union across all workspace arrays; single PluginManager serves all workspaces
- Shutdown order: TaskScheduler, PluginManager, ChannelRunner, MessageQueue
- No ChannelRunner API changes needed; existing adapterFactory parameter reused

### Active Todos

None.

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

**Last session:** 2026-02-09
**Stopped at:** Completed 13-03-PLAN.md (Daemon wiring for PluginManager and TaskScheduler)
**Resume file:** None

**Next action:** v0.7.0 milestone complete. Prepare release.

---

_Last updated: 2026-02-09 after 13-03 plan complete (phase 13 complete, milestone complete)_
