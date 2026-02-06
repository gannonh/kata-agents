# Requirements: Kata Agents v0.7.0 Multi-Agent Orchestration

## v0.7.0 Requirements

### Sub-Agent Display (DISPLAY)

- [ ] **DISPLAY-01**: Sub-agent appears as collapsible group in message tree with agent type badge
- [ ] **DISPLAY-02**: Running sub-agent shows elapsed time indicator
- [ ] **DISPLAY-03**: Completed sub-agent shows completion summary
- [ ] **DISPLAY-04**: Failed sub-agent shows error state with clear failure reason
- [ ] **DISPLAY-05**: Nested tool calls within sub-agent displayed with depth indentation

### Sub-Agent Execution (EXEC)

- [ ] **EXEC-01**: Agent can spawn sub-agents via SDK Task tool with task-specific instructions
- [ ] **EXEC-02**: Multiple sub-agents can execute in parallel within a single session
- [ ] **EXEC-03**: Parallel sub-agent events are properly ordered and attributed in the UI
- [ ] **EXEC-04**: Sub-agent type (general-purpose, Explore, Plan) is extracted and displayed
- [ ] **EXEC-05**: Concurrent sub-agent limit prevents resource exhaustion

### Background Execution (BG)

- [ ] **BG-01**: Background vs foreground sub-agent distinction visible in UI
- [ ] **BG-02**: Background sub-agent completion notification displayed to user
- [ ] **BG-03**: Background sub-agent result (TaskOutput) rendered when complete

## Future Requirements (v0.8.0+)

- Custom agent definition management (CRUD, templates, settings panel)
- Agent activity dashboard with persistent panel
- Per-sub-agent token attribution and budget management
- Context window gauge per sub-agent
- Agent teams (multi-session coordination)
- Parallel agent comparison/evaluation view
- Agent memory/persistence (cross-session learning)

## Out of Scope

- Custom agent definition visual editor — markdown files suffice
- Agent teams — experimental SDK feature, defer until stable
- Sub-agents spawning sub-agents — SDK explicitly prevents this
- Git worktree isolation for parallel agents — infrastructure too heavy for v0.7.0

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| DISPLAY-01  | Phase 1: Sub-Agent Execution Foundation | Pending |
| DISPLAY-02  | Phase 2: Sub-Agent Lifecycle Display | Pending |
| DISPLAY-03  | Phase 2: Sub-Agent Lifecycle Display | Pending |
| DISPLAY-04  | Phase 2: Sub-Agent Lifecycle Display | Pending |
| DISPLAY-05  | Phase 1: Sub-Agent Execution Foundation | Pending |
| EXEC-01     | Phase 1: Sub-Agent Execution Foundation | Pending |
| EXEC-02     | Phase 3: Parallel Execution | Pending |
| EXEC-03     | Phase 3: Parallel Execution | Pending |
| EXEC-04     | Phase 1: Sub-Agent Execution Foundation | Pending |
| EXEC-05     | Phase 3: Parallel Execution | Pending |
| BG-01       | Phase 4: Background Sub-Agent Support | Pending |
| BG-02       | Phase 4: Background Sub-Agent Support | Pending |
| BG-03       | Phase 4: Background Sub-Agent Support | Pending |

---

_13 requirements across 3 categories, mapped to 4 phases with 100% coverage_
