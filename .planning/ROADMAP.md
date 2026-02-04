# Roadmap: Kata Agents

## Overview

Native desktop client for the Kata ecosystem with integrated git context. Currently shipping v0.7.0 Testing Infrastructure to establish baseline test coverage and live E2E testing capabilities.

## Milestones

- ✅ v0.4.0 Foundation — SHIPPED 2026-01-30
- ✅ v0.6.0 Git Integration — SHIPPED 2026-02-04
- 🔄 v0.7.0 Testing Infrastructure — In Progress
- ○ v0.8.0 Kata Infrastructure — Planned

---

<details>
<summary><strong>✅ v0.6.0 Git Integration — SHIPPED 2026-02-04</strong></summary>

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
<summary><strong>✅ v0.4.0 Foundation — SHIPPED 2026-01-30</strong></summary>

**Goal:** Rebrand from Craft Agents to Kata Agents with CI/CD infrastructure and trademark compliance.

**Phases:**
- [x] Phase 1: Kata Branding (3 plans) — Completed 2026-01-29
- [x] Phase 2: CI/CD Infrastructure (3 plans) — Completed 2026-01-30

[Full archive](milestones/v0.4.0-ROADMAP.md)

</details>

---

## Planned Milestones

### v0.8.0 Kata Infrastructure

**Goal:** Set up kata.sh infrastructure (website, update server, Slack OAuth relay).

**Target features:**
- kata.sh website with documentation
- Update server for version checks
- Slack OAuth relay server
- Re-enable Slack OAuth in app

---

## Current Milestone: v0.7.0 Testing Infrastructure

**Goal:** Establish baseline test coverage and live E2E testing capabilities with real credentials.

**Target completion:** 2026-02-06

---

### Phase 1: Live E2E Test Suite ✓

**Goal:** E2E tests verify core user workflows end-to-end with real credentials.

**Status:** Completed 2026-02-04

**Requirements:** E2E-01, E2E-02, E2E-03, E2E-04, E2E-05, E2E-06, E2E-07

Plans:
- [x] 01-01-PLAN.md — Test infrastructure setup (credential validation, test script)
- [x] 01-02-PLAN.md — Auth and chat live tests (E2E-03, E2E-04)
- [x] 01-03-PLAN.md — Session, git, permission tests (E2E-05, E2E-06, E2E-07)

---

### Phase 2: Unit Test Coverage

**Goal:** Unit tests cover critical modules with documented coverage gaps.

**Depends on:** None (independent from E2E work)

**Requirements:** COV-01, COV-02, COV-03

**Success Criteria:**
1. Developer runs `bun test --coverage` and sees coverage report with module-level percentages
2. pr-service.ts has unit tests covering happy path and error cases (gh CLI unavailable, non-git directory)
3. Coverage gaps document identifies tested vs untested modules with rationale for deferred tests

**Plans:** TBD

---

## Progress Summary

| Milestone | Status | Phases | Plans | Requirements | Coverage |
|-----------|--------|--------|-------|--------------|----------|
| v0.4.0 Foundation | Shipped | 2 | 6 | 10 | 100% |
| v0.6.0 Git Integration | Shipped | 5 | 14 | 12 | 100% |
| v0.7.0 Testing Infrastructure | In Progress | 2 | 3 | 10 | 70% |
| v0.8.0 Kata Infrastructure | Planned | — | — | — | — |

---

_Last updated: 2026-02-04 after Phase 1 completion_
