# Roadmap: Kata Agents

## Current Milestone: v0.6.0 Git Integration

**Goal:** Show developers their git context (branch, PR) in the workspace UI while working with the agent.

**Phases:** 5 (Phases 3-7, continuing from v0.4.0)
**Requirements:** 12
**Depth:** Standard

---

## Milestone: v0.6.0 Git Integration

### Phase 3: Core Git Service

**Goal:** Workspace UI displays current git branch, with graceful handling of non-git directories.

**Depends on:** None (foundation for this milestone)

**Plans:** 4 plans

Plans:
- [x] 03-01-PLAN.md — Create GitService module with simple-git
- [x] 03-02-PLAN.md — Wire GitService to IPC layer
- [x] 03-03-PLAN.md — Create renderer state management (Jotai atoms)
- [x] 03-04-PLAN.md — Create GitStatusBadge UI component

**Requirements:**
- GIT-01: User can see current git branch name in workspace UI
- GIT-02: User sees no git indicator when workspace is not a git repository
- GIT-03: User can see git status update when switching workspaces

**Success Criteria:**
1. User sees branch name (e.g., "main", "feature/auth") in workspace header area
2. User sees no git badge/indicator when workspace directory is not a git repository
3. User sees correct branch for each workspace when switching between workspaces
4. Branch display handles detached HEAD state gracefully (shows commit hash)

**Implementation Notes:**
- GitService module using simple-git in main process
- IPC handler for GIT_STATUS channel
- Workspace-scoped state (Map<workspaceId, GitState>)
- Must include debouncing (300-500ms) and async-only execution from day one

---

### Phase 4: PR Integration

**Goal:** User sees linked PR information when current branch has an open pull request.

**Depends on:** Phase 3 (requires git branch detection)

**Plans:** 2 plans

Plans:
- [x] 04-01-PLAN.md — Create PR service module and wire to IPC layer
- [x] 04-02-PLAN.md — Create PrBadge UI component

**Requirements:**
- PR-01: User can see linked PR title when current branch has an open PR
- PR-02: User can see PR status (open, draft, merged, closed)
- PR-03: User can click PR badge to open PR in browser
- PR-04: User sees graceful degradation when gh CLI is not available

**Success Criteria:**
1. User sees PR title inline when current branch has an open pull request
2. User sees visual status indicator (green/yellow/red) reflecting PR state
3. User can click PR badge to open the pull request in their default browser
4. User sees helpful message (not error) when gh CLI is unavailable or unauthenticated
5. PR information loads without blocking git branch display

**Implementation Notes:**
- Uses gh CLI (already authenticated on developer machines)
- Cache PR data with 5-10 minute TTL to avoid rate limiting
- Must detect gh CLI availability before attempting PR lookup

---

### Phase 5: Real-Time Updates

**Goal:** Git and PR status stay current without manual refresh.

**Depends on:** Phase 4 (real-time updates apply to both git and PR)

**Plans:** 4 plans

Plans:
- [x] 05-01-PLAN.md — Create GitWatcher with chokidar and IPC broadcast
- [x] 05-02-PLAN.md — Add focus-aware PR polling to renderer
- [x] 05-03-PLAN.md — Connect useGitStatus to GitWatcher events and focus
- [x] 05-04-PLAN.md — Wire GitBranchBadge to live git state (gap closure)

**Requirements:**
- LIVE-01: Git status refreshes automatically when .git directory changes
- LIVE-02: PR status refreshes periodically (every 5-10 minutes)
- LIVE-03: Git status refreshes when workspace gains focus

**Success Criteria:**
1. User sees branch change reflected in UI within 1 second of git checkout/branch operation
2. User sees PR status updates reflected within configured refresh interval (5-10 min)
3. User sees fresh git status when returning to Kata Agents from another application
4. File watching does not cause CPU spikes or excessive process spawning

**Implementation Notes:**
- Watch selective .git paths only (.git/index, .git/HEAD, .git/refs/)
- Debounce file system events (100ms)
- Clean up watchers on workspace switch
- chokidar v4.x for cross-platform file watching

---

### Phase 6: AI Context Injection

**Goal:** Agent receives git context and can reference it in responses.

**Depends on:** Phase 4 (needs both branch and PR data)

**Plans:** 1 plan

Plans:
- [x] 06-01-PLAN.md — Create formatGitContext, wire into CraftAgent and SessionManager

**Requirements:**
- CTX-01: Agent receives git context (branch, PR) in conversation
- CTX-02: Git context is workspace-specific (each workspace has its own state)

**Success Criteria:**
1. Agent can reference current branch name in responses (e.g., "I see you're on feature/auth")
2. Agent can reference PR information when available (e.g., "Your PR #42 is still in draft")
3. Agent context updates when user switches workspaces
4. Git context does not bloat system prompt (concise format)

**Implementation Notes:**
- Inject into user messages (not system prompt) for prompt caching
- Format: `<git_context>Current branch: feature/user-auth\nPR #42: Fix user auth (OPEN)</git_context>`
- Update context when git state changes via fresh fetch before each message

---

### Phase 7: Polish and Edge Cases

**Goal:** Handle edge cases and improve reliability of git integration.

**Depends on:** Phase 6 (all core functionality complete)

**Plans:** (created by /kata:plan-phase)

**Requirements:** None (polish phase, no new requirements)

**Success Criteria:**
1. Cross-platform compatibility verified (macOS, Windows, Linux)
2. Large repository performance acceptable (test with 10k+ files)
3. Error states show user-friendly messages
4. All automated tests pass

**Implementation Notes:**
- This phase handles integration testing and edge cases discovered during Phases 3-6
- No new requirements mapped; derived from acceptance criteria

---

## Coverage Map

| Requirement | Phase | Description |
|-------------|-------|-------------|
| GIT-01 | 3 | User can see current git branch name in workspace UI |
| GIT-02 | 3 | User sees no git indicator when workspace is not a git repository |
| GIT-03 | 3 | User can see git status update when switching workspaces |
| PR-01 | 4 | User can see linked PR title when current branch has an open PR |
| PR-02 | 4 | User can see PR status (open, draft, merged, closed) |
| PR-03 | 4 | User can click PR badge to open PR in browser |
| PR-04 | 4 | User sees graceful degradation when gh CLI is not available |
| LIVE-01 | 5 | Git status refreshes automatically when .git directory changes |
| LIVE-02 | 5 | PR status refreshes periodically (every 5-10 minutes) |
| LIVE-03 | 5 | Git status refreshes when workspace gains focus |
| CTX-01 | 6 | Agent receives git context (branch, PR) in conversation |
| CTX-02 | 6 | Git context is workspace-specific (each workspace has its own state) |

**Coverage:** 12/12 requirements mapped

---

## Progress

| Phase | Name | Status | Requirements |
|-------|------|--------|--------------|
| 3 | Core Git Service | Complete | GIT-01, GIT-02, GIT-03 |
| 4 | PR Integration | Complete | PR-01, PR-02, PR-03, PR-04 |
| 5 | Real-Time Updates | Complete | LIVE-01, LIVE-02, LIVE-03 |
| 6 | AI Context Injection | Complete | CTX-01, CTX-02 |
| 7 | Polish and Edge Cases | Ready | — |

---

## Previous Milestones

### v0.4.0 Foundation (SHIPPED 2026-01-30)

See: `.planning/milestones/v0.4.0-ROADMAP.md`

**Phases:** 1-2
- Phase 1: Setup and Tooling (CI/CD, upstream management)
- Phase 2: Rebranding (trademark compliance, distribution)

---

*Last updated: 2026-02-03 after Phase 6 execution complete*
