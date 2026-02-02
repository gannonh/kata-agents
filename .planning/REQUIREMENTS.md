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

- [ ] **PR-01**: User can see linked PR title when current branch has an open PR
- [ ] **PR-02**: User can see PR status (open, draft, merged, closed)
- [ ] **PR-03**: User can click PR badge to open PR in browser
- [ ] **PR-04**: User sees graceful degradation when `gh` CLI is not available

### Real-Time Updates

- [ ] **LIVE-01**: Git status refreshes automatically when .git directory changes
- [ ] **LIVE-02**: PR status refreshes periodically (every 5-10 minutes)
- [ ] **LIVE-03**: Git status refreshes when workspace gains focus

### AI Context

- [ ] **CTX-01**: Agent receives git context (branch, PR) in conversation
- [ ] **CTX-02**: Git context is workspace-specific (each workspace has its own state)

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
| PR-01 | Phase 4 | Pending |
| PR-02 | Phase 4 | Pending |
| PR-03 | Phase 4 | Pending |
| PR-04 | Phase 4 | Pending |
| LIVE-01 | Phase 5 | Pending |
| LIVE-02 | Phase 5 | Pending |
| LIVE-03 | Phase 5 | Pending |
| CTX-01 | Phase 6 | Pending |
| CTX-02 | Phase 6 | Pending |

**Coverage:** 12/12 requirements mapped (3/12 complete)

---
*Updated: 2026-02-02 after Phase 3 complete*
