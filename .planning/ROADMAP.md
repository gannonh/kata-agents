# Roadmap: Kata Agents

## Overview

Native desktop client for the Kata ecosystem with integrated git context. Building v0.7.0 Always-On Assistant to add background daemon, communication channel adapters, and a first-party plugin system.

## Milestones

- ✅ v0.4.0 Foundation — SHIPPED 2026-01-30
- ✅ v0.6.0 Git Integration — SHIPPED 2026-02-04
- ✅ v0.6.1 Testing Infrastructure — SHIPPED 2026-02-05
- ➡️ v0.7.0 Always-On Assistant — IN PROGRESS

---

### v0.7.0 Always-On Assistant

**Goal:** Run a background daemon that monitors Slack and WhatsApp channels, routes inbound messages to agent sessions, and exposes channel conversations in the desktop UI alongside direct chat sessions.

#### Phase 10: Foundation Types and Permission Mode — Completed 2026-02-07

**Goal:** Define the plugin contract, channel adapter interface, daemon types, and daemon permission mode. Pure type definitions and permission logic with no runtime behavior.

**Dependencies:** None.

**Requirements:** PLUG-01, DAEMON-04

**Plans:** 2 plans

Plans:
- [x] 10-01-PLAN.md — Plugin contract, channel adapter, and daemon event types
- [x] 10-02-PLAN.md — Daemon permission mode and unit tests

**Success Criteria:**
1. ✅ KataPlugin interface compiles with registerChannel, registerTool, registerService methods
2. ✅ ChannelAdapter interface defines poll and subscribe ingress modes
3. ✅ Daemon permission mode restricts tool access to an explicit allowlist
4. ✅ Daemon mode blocks bash, computer, and write operations by default
5. ✅ Unit tests validate shouldAllowToolInMode with daemon mode

#### Phase 11: Daemon Core and SQLite Queue — Completed 2026-02-07

**Goal:** Spawn the daemon as a Bun subprocess from Electron main process with stdin/stdout JSON communication, crash recovery via exponential backoff supervisor, and SQLite message queue for inbound channel messages.

**Dependencies:** Phase 10 (types and permission mode).

**Requirements:** DAEMON-01, DAEMON-02, DAEMON-05

**Plans:** 2 plans

Plans:
- [x] 11-01-PLAN.md — SQLite message queue and JSON-lines IPC module
- [x] 11-02-PLAN.md — Daemon entry point, DaemonManager, Electron integration

**Success Criteria:**
1. ✅ DaemonManager spawns a Bun subprocess and exchanges JSON messages over stdin/stdout
2. ✅ Daemon restarts automatically on crash with exponential backoff (1s, 2s, 4s... max 30s, pauses after 5 consecutive failures)
3. ✅ SQLite database at ~/.kata-agents/daemon.db stores inbound and outbound messages with WAL mode
4. ✅ Message queue supports enqueue, dequeue, and mark-processed operations
5. ✅ Stale daemon PID cleanup prevents zombie processes on app startup

#### Phase 12: Channel Adapters — Completed 2026-02-08

**Goal:** Implement Slack and WhatsApp channel adapters with thread-to-session mapping and configurable mention/trigger activation patterns.

**Dependencies:** Phase 11 (daemon core and message queue).

**Requirements:** CHAN-01, CHAN-02, CHAN-04, CHAN-05

**Plans:** 3 plans

Plans:
- [x] 12-01-PLAN.md — TriggerMatcher, ChannelSessionResolver, and polling state persistence (TDD)
- [x] 12-02-PLAN.md — Slack adapter, channel-runner, and daemon entry wiring
- [x] 12-03-PLAN.md — WhatsApp adapter with Bun compatibility gate

**Success Criteria:**
1. ✅ Slack adapter polls conversations.history via @slack/web-api and enqueues new messages
2. ✅ WhatsApp adapter connects via Baileys and enqueues inbound messages
3. ✅ Each channel thread maps to a persistent daemon session (daemon-{channelSlug}-{workspaceId})
4. ✅ Agent responds only to configured trigger patterns (@mention, keyword match) per channel
5. ✅ Thread context carries over across daemon restarts via session persistence

#### Phase 13: Plugin Lifecycle and Task Scheduler

**Goal:** Enable plugin enable/disable per workspace, bundle first-party plugins (Slack, WhatsApp) for daemon startup loading, and implement the task scheduler for cron, interval, and one-shot tasks.

**Dependencies:** Phase 12 (channel adapters registered as plugins).

**Requirements:** PLUG-02, PLUG-03, DAEMON-06

**Success Criteria:**
1. Workspace settings UI shows installed plugins with enable/disable toggles
2. Disabled plugins do not load channels or register tools for that workspace
3. First-party Slack and WhatsApp plugins load automatically at daemon startup
4. Task scheduler executes cron, interval, and one-shot tasks stored in SQLite
5. Scheduled tasks survive daemon restarts (persisted in daemon.db)

#### Phase 14: UI Integration

**Goal:** Surface daemon status, system tray background operation, channel configuration, unified session view, and MCP tool access in channel sessions.

**Dependencies:** Phase 13 (plugins loaded, scheduler running).

**Requirements:** DAEMON-03, DAEMON-07, CHAN-03, CHAN-06, CHAN-07

**Success Criteria:**
1. Status indicator in the UI displays daemon state (running/stopped/error) with live updates
2. System tray icon allows quick access and keeps daemon running when main window closes
3. Channel configuration UI lets users select which channels/conversations to monitor
4. Channel sessions appear alongside direct sessions in the unified session list
5. Channel sessions have MCP tools attached for contextual assistance

---

<details>
<summary><strong>v0.6.1 Testing Infrastructure — SHIPPED 2026-02-05</strong></summary>

**Goal:** Establish baseline test coverage and live E2E testing capabilities with real credentials.

**Phases:**
- [x] Phase 8: Live E2E Test Suite (3 plans) — Completed 2026-02-04
- [x] Phase 9: Unit Test Coverage (3 plans) — Completed 2026-02-05

[Full archive](milestones/v0.6.1-ROADMAP.md)

</details>

<details>
<summary><strong>v0.6.0 Git Integration — SHIPPED 2026-02-04</strong></summary>

**Goal:** Show developers their git context (branch, PR) in the workspace UI while working with the agent.

**Phases:**
- [x] Phase 3: Core Git Service (4 plans) — Completed 2026-02-02
- [x] Phase 4: PR Integration (2 plans) — Completed 2026-02-02
- [x] Phase 5: Real-Time Updates (4 plans) — Completed 2026-02-03
- [x] Phase 6: AI Context Injection (1 plan) — Completed 2026-02-03
- [x] Phase 7: Polish and Edge Cases (3 plans) — Completed 2026-02-04

[Full archive](milestones/v0.6.0-ROADMAP.md)

</details>

<details>
<summary><strong>v0.4.0 Foundation — SHIPPED 2026-01-30</strong></summary>

**Goal:** Rebrand from Craft Agents to Kata Agents with CI/CD infrastructure and trademark compliance.

**Phases:**
- [x] Phase 1: Kata Branding (3 plans) — Completed 2026-01-29
- [x] Phase 2: CI/CD Infrastructure (3 plans) — Completed 2026-01-30

[Full archive](milestones/v0.4.0-ROADMAP.md)

</details>

---

## Progress Summary

| Milestone                     | Status      | Phases | Plans | Requirements | Coverage |
| ----------------------------- | ----------- | ------ | ----- | ------------ | -------- |
| v0.4.0 Foundation             | ✅ Shipped  | 2      | 6     | 10           | 100%     |
| v0.6.0 Git Integration        | ✅ Shipped  | 5      | 14    | 12           | 100%     |
| v0.6.1 Testing Infrastructure | ✅ Shipped  | 2      | 6     | 10           | 100%     |
| v0.7.0 Always-On Assistant    | ➡️ Active   | 5      | 7     | 17           | 65%     |

---

_Last updated: 2026-02-08 after Phase 12 completed_
