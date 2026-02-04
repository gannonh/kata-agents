# Requirements: v0.6.0 Git Integration

**Milestone:** v0.6.0
**Goal:** Show developers their git context (branch, PR) in the workspace UI while working with the agent.

---

## v0.6.0 Requirements

### Git Status Display

- [x] **GIT-01**: User can see current git branch name in workspace UI
- [x] **GIT-02**: User sees no git indicator when workspace is not a git repository
- [x] **GIT-03**: User can see git status update when switching workspaces

### PR Integration

- [x] **PR-01**: User can see linked PR title when current branch has an open PR
- [x] **PR-02**: User can see PR status (open, draft, merged, closed)
- [x] **PR-03**: User can click PR badge to open PR in browser
- [x] **PR-04**: User sees graceful degradation when `gh` CLI is not available

### Real-Time Updates

- [x] **LIVE-01**: Git status refreshes automatically when .git directory changes
- [x] **LIVE-02**: PR status refreshes periodically (every 5-10 minutes)
- [x] **LIVE-03**: Git status refreshes when workspace gains focus

### AI Context

- [x] **CTX-01**: Agent receives git context (branch, PR) in conversation
- [x] **CTX-02**: Git context is workspace-specific (each workspace has its own state)

---

## Future Requirements

_Deferred to later milestones_

- Dirty indicator (uncommitted changes count)
- Ahead/behind remote count
- PR review status details (approvals, requested changes)
- Branch switching from UI
- Commit history view

## Out of Scope

_Explicit exclusions for v0.6.0_

- **Branch switching UI** — Display only, not a git client
- **Commit/staging UI** — Display only
- **Diff viewer** — Display only
- **Merge/rebase controls** — Display only
- **Multiple remote support** — Single origin assumed for v0.6.0

---

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| GIT-01 | Phase 3 | Complete ✓ |
| GIT-02 | Phase 3 | Complete ✓ |
| GIT-03 | Phase 3 | Complete ✓ |
| PR-01 | Phase 4 | Complete ✓ |
| PR-02 | Phase 4 | Complete ✓ |
| PR-03 | Phase 4 | Complete ✓ |
| PR-04 | Phase 4 | Complete ✓ |
| LIVE-01 | Phase 5 | Complete ✓ |
| LIVE-02 | Phase 5 | Complete ✓ |
| LIVE-03 | Phase 5 | Complete ✓ |
| CTX-01 | Phase 6 | Complete ✓ |
| CTX-02 | Phase 6 | Complete ✓ |

**Coverage:** 12/12 requirements mapped (12/12 complete)

---
*Updated: 2026-02-03 after Phase 6 complete*
