# Kata Agents — State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-02)

**Core value:** A compliant, independent rebrand preserving all functionality
**Current focus:** v0.6.0 Git Integration

## Current Position

```
Milestone: v0.6.0 Git Integration
Phase: 7 - Polish and Edge Cases (COMPLETE)
Plan: 03 of 03 (complete)
Status: Phase 7 complete. All v0.6.0 plans executed.
Progress: [██████████] 15/15 plans (5/5 phases complete)
```

**Last activity:** 2026-02-04 -- Completed 07-03-PLAN.md (GitWatcher integration tests)

## Quick Tasks

| ID | Name | Status | Summary |
|----|------|--------|---------|
| 001 | Fill test coverage gaps | Complete | [001-SUMMARY.md](./quick/001-fill-test-coverage-gaps/001-SUMMARY.md) |

## Shipped Milestones

| Version | Name | Shipped | Phases | Requirements |
|---------|------|---------|--------|--------------|
| v0.5.0 | — | 2026-02 | — | — |
| v0.4.0 | Foundation | 2026-01-30 | 2 | 10/10 |

## Performance Metrics

| Metric | Value |
|--------|-------|
| Milestones shipped | 2 |
| Total phases | 6 |
| Total plans | 17 |
| Total requirements | 13 |

## Current Milestone Overview

**v0.6.0 Git Integration**

| Phase | Name | Status | Requirements |
|-------|------|--------|--------------|
| 3 | Core Git Service | Complete | GIT-01, GIT-02, GIT-03 |
| 4 | PR Integration | Complete | PR-01, PR-02, PR-03, PR-04 |
| 5 | Real-Time Updates | Complete | LIVE-01, LIVE-02, LIVE-03 |
| 6 | AI Context Injection | Complete | CTX-01, CTX-02 |
| 7 | Polish and Edge Cases | Complete (3/3 plans) | — |

**Critical path:** 3 -> 4 -> 5 -> 6 -> 7
**Differentiator phase:** Phase 6 (AI Context) - complete

## Phase 6 Summary

**Git context injection into agent messages:**
- `formatGitContext()` produces compact XML-tagged context from GitState + PrInfo
- CraftAgent injects git context into both text and SDK user messages
- SessionManager fetches fresh git state before each `agent.chat()` call
- Git context refreshes on working directory change
- Non-git directories produce empty context (graceful absence)
- 10 unit tests covering all formatting edge cases

**Plans:**
- 06-01: formatGitContext + CraftAgent wiring + SessionManager integration

**Commits:** 4 commits on feat/v0.6.0-06-ai-context-injection
**Verification:** 5/5 must-haves passed

## Accumulated Context

### Decisions Made

See PROJECT.md Key Decisions table for full list with outcomes.

**v0.6.0 Decisions:**
- Use simple-git for git operations (8.5M weekly downloads, TypeScript-native)
- Use gh CLI for PR data (already authenticated on developer machines)
- Workspace-scoped state (Map<workspaceId, GitState>) for multi-workspace support
- Selective file watching (.git/index, .git/HEAD, .git/refs/) to avoid performance issues
- Keep GET_GIT_BRANCH handler for backward compatibility (FreeFormInput.tsx uses it)
- Git branch badge placed in chat input toolbar (better visibility than sidebar)
- PR badge colors match GitHub conventions (green/purple/red/gray)
- Focus-aware PR polling: useGitStatus in FreeFormInput provides branch to PrBadge
- GitBranchBadge as pure display component (no local fetch, receives gitState prop)
- Use chokidar v4 for cross-platform .git file watching (native fs.watch unreliable)
- Auto-start git watcher on first GIT_STATUS request (lazy initialization)
- 100ms delay on focus refresh to deduplicate with file watcher events
- XML-tagged git context (~100-200 chars) injected per user message, matching existing patterns
- Parse .git file gitdir pointer for worktree/submodule resolution (statSync + readFileSync)

### Research Flags

| Phase | Research Needed | Notes |
|-------|-----------------|-------|
| 3 | NO | Complete |
| 4 | NO | Complete |
| 5 | NO | Complete |
| 6 | NO | Complete |
| 7 | NO | Complete |

### Open Questions

_None_

### Blockers

_None_

## Disabled Features

| Feature | Status | Dependency |
|---------|--------|------------|
| Slack OAuth | Disabled with error message | Needs HTTPS relay server |
| External docs links | Empty/GitHub fallback | Needs docs.kata.sh |
| Version manifest | Disabled | Needs version API at kata.sh |
| MCP docs server | Commented out | Needs docs MCP at kata.sh |

## Session Continuity

Last session: 2026-02-04T13:04Z
Stopped at: Completed 07-03-PLAN.md
Resume file: None

## Next Steps

All Phase 7 plans complete. v0.6.0 milestone ready for final review.

---
*Last updated: 2026-02-04 after 07-03 plan execution*
