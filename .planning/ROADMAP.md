# Roadmap: Kata Agents

## Overview

Native desktop client for the Kata ecosystem with integrated git context. Current milestone: v0.7.0 Multi-Agent Orchestration, enabling parallel sub-agent execution with full UI visibility.

## Milestones

- ✅ v0.4.0 Foundation — SHIPPED 2026-01-30
- ✅ v0.6.0 Git Integration — SHIPPED 2026-02-04
- ✅ v0.6.1 Testing Infrastructure — SHIPPED 2026-02-05
- 🔄 v0.7.0 Multi-Agent Orchestration — In Progress

---

## v0.7.0 Multi-Agent Orchestration

**Goal:** Enable the agent to spawn and manage sub-agents that execute in parallel, each with their own context, with full visibility in the chat UI.

**Requirements:** 13 across 3 categories (DISPLAY, EXEC, BG)

### Phase Overview

| Phase | Name | Requirements | Depends On |
|-------|------|-------------|------------|
| 1 | Sub-Agent Execution Foundation | EXEC-01, EXEC-04, DISPLAY-01, DISPLAY-05 | — |
| 2 | Sub-Agent Lifecycle Display | DISPLAY-02, DISPLAY-03, DISPLAY-04 | Phase 1 |
| 3 | Parallel Execution | EXEC-02, EXEC-03, EXEC-05 | Phase 2 |
| 4 | Background Sub-Agent Support | BG-01, BG-02, BG-03 | Phase 3 |

#### Phase 1: Sub-Agent Execution Foundation

**Goal**: A sub-agent spawned via the SDK Task tool appears in the message tree as a collapsible group with its agent type visible and nested tool calls indented.

**Requirements**: EXEC-01, EXEC-04, DISPLAY-01, DISPLAY-05

**Success Criteria** (what must be TRUE):
  1. User sends a message that triggers the agent to spawn a sub-agent; the sub-agent executes and its events appear in the session
  2. The sub-agent renders as a collapsible group in the message tree (collapsed by default, expandable)
  3. The agent type badge (general-purpose, Explore, or Plan) displays on the sub-agent group header
  4. Tool calls within the sub-agent render with visible depth indentation relative to the parent

#### Phase 2: Sub-Agent Lifecycle Display

**Goal**: Running, completed, and failed sub-agents each show distinct, informative states so the user always knows what happened.

**Requirements**: DISPLAY-02, DISPLAY-03, DISPLAY-04

**Success Criteria** (what must be TRUE):
  1. A running sub-agent displays an elapsed time indicator that updates while the sub-agent executes
  2. A completed sub-agent displays a completion summary (token count, duration, or SDK-provided summary text)
  3. A failed sub-agent displays an error state with the failure reason visible without expanding the group

#### Phase 3: Parallel Execution

**Goal**: Multiple sub-agents execute concurrently within a single session with events correctly ordered and a hard limit preventing resource exhaustion.

**Requirements**: EXEC-02, EXEC-03, EXEC-05

**Success Criteria** (what must be TRUE):
  1. The agent can spawn two or more sub-agents that run in parallel (overlapping execution, not sequential)
  2. Events from concurrent sub-agents are attributed to the correct sub-agent group in the UI (no cross-contamination)
  3. A configurable concurrent sub-agent limit (default 3-5) prevents unbounded spawning; additional requests queue until a slot opens
  4. The UI remains responsive during parallel sub-agent execution (no render blocking or event loss)

#### Phase 4: Background Sub-Agent Support

**Goal**: Background sub-agents are visually distinct from foreground sub-agents, notify the user on completion, and render their results inline.

**Requirements**: BG-01, BG-02, BG-03

**Success Criteria** (what must be TRUE):
  1. Background sub-agents display a distinct visual indicator separating them from foreground sub-agents
  2. When a background sub-agent completes, the user receives a visible notification (toast, badge, or inline indicator)
  3. The background sub-agent's TaskOutput result renders inline in the conversation when complete

---

<details>
<summary><strong>v0.6.1 Testing Infrastructure — SHIPPED 2026-02-05</strong></summary>

**Goal:** Establish baseline test coverage and live E2E testing capabilities with real credentials.

**Phases:**
- [x] Phase 1: Live E2E Test Suite (3 plans) — Completed 2026-02-04
- [x] Phase 2: Unit Test Coverage (3 plans) — Completed 2026-02-05

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

| Milestone | Status | Phases | Plans | Requirements | Coverage |
|-----------|--------|--------|-------|--------------|----------|
| v0.4.0 Foundation | Shipped | 2 | 6 | 10 | 100% |
| v0.6.0 Git Integration | Shipped | 5 | 14 | 12 | 100% |
| v0.6.1 Testing Infrastructure | Shipped | 2 | 6 | 10 | 100% |
| v0.7.0 Multi-Agent Orchestration | In Progress | 4 | — | 13 | 0% |

---

_Last updated: 2026-02-06 after v0.7.0 roadmap created_
