# Research Summary: Git Status UI Integration

**Project:** Kata Agents v0.6.0 - Git Status UI Integration
**Synthesized:** 2026-02-02
**Overall Confidence:** HIGH

---

## Executive Summary

This feature adds git context awareness to Kata Agents, displaying branch information and PR status to both users and the AI agent. Expert consensus shows this is table-stakes functionality for modern developer tools (VS Code, JetBrains, GitHub Desktop all prominently display branch status), with high user expectations for visibility without requiring interaction.

The recommended approach leverages existing infrastructure: use simple-git (8.5M weekly downloads, TypeScript-native) for git operations and gh CLI (already authenticated on developer machines) for PR data. Both run in the main process following established patterns for subprocess management. The architecture extends existing IPC/Jotai patterns without introducing new paradigms, minimizing integration risk.

Key risks center on performance: naive polling can spawn 85-120+ git processes causing CPU spikes and UI lag (verified in GitHub issues). Mitigation requires debouncing (300-500ms), selective file watching (.git/index and .git/HEAD only), and async-only execution to prevent main process blocking. GitHub API rate limiting (5,000 requests/hour) demands aggressive caching with ETags. The app's multi-workspace architecture requires workspace-scoped state to prevent cross-contamination during workspace switching.

---

## Key Findings

### Technology Stack (from STACK.md)

**Core Dependencies:**
- **simple-git ^3.30.0** - Wraps git CLI with TypeScript support; returns structured StatusResult with branch, tracking, ahead/behind counts. Chosen over isomorphic-git (pure JS, slower) and nodegit (native bindings, compile issues with Electron).
- **gh CLI** (zero new dependencies) - Already authenticated on user machines, JSON output available. App's existing shell-env.ts loads PATH including /opt/homebrew/bin. Preferred over @octokit/rest which requires OAuth device flow setup.

**Integration Pattern:**
```typescript
interface GitContext {
  branch: string | null;          // From simple-git status()
  tracking: string | null;
  ahead: number;
  behind: number;
  isDetached: boolean;
  pullRequest?: {                 // From gh CLI (optional)
    number: number;
    title: string;
    state: 'open' | 'closed' | 'merged';
    url: string;
    isDraft: boolean;
  };
  hasGit: boolean;
  hasGhCli: boolean;
}
```

**Recommended module location:** `packages/shared/src/git/` with exports for git-status.ts (simple-git wrapper), github-pr.ts (gh CLI wrapper), and types.ts (GitContext interface).

### Feature Priorities (from FEATURES.md)

**Table Stakes (user expectation = 100%):**
| Feature | Complexity | Evidence |
|---------|------------|----------|
| Current branch name display | Low | VS Code bottom-left status bar, JetBrains toolbar widget, GitHub Desktop "Current Branch" button |
| Linked PR display | Medium | GitHub Desktop 3.0+, GitLens, VS Code GitHub extension all show PR association |
| PR status indicator | Medium | Green check/yellow pending/red X is universal convention |
| Click-to-copy branch name | Low | Common workflow for PR titles, Jira tickets |

**Differentiators (competitive advantage):**
- **AI context awareness** (STRONGEST) - Inject git context into agent system prompt: "I see you're on feature/user-auth with PR #42 open." No existing tool provides this. Turns passive display into active assistance.
- **PR title inline** - Most tools show PR number only, requiring click. Showing title gives instant context.
- **One-click PR open** - Click badge opens PR in browser (GitHub Desktop has this, opportunity for parity).

**Anti-Features (deliberately exclude for v0.6.0):**
- Branch switching UI - Kata Agents is an AI chat tool, not a Git client
- Commit history view - GitHub Desktop owns this domain
- Diff viewer - VS Code already excellent
- Merge/rebase controls - Complex operations that can destroy work
- Stash management - Niche use case, easy data loss

**MVP Recommendation:**
1. Branch name display (table stakes, immediate value)
2. Linked PR title + status (differentiator when combined with AI context)
3. Click to open PR (low complexity, high convenience)

Defer to post-MVP: dirty indicator, ahead/behind count, PR review status (all add complexity without core value).

### Architecture Approach (from ARCHITECTURE.md)

**Foundation exists:** Git branch detection already implemented at line 743-756 of ipc.ts using GET_GIT_BRANCH channel. Extension follows established patterns without architectural changes.

**Component Boundaries:**
| Component | Location | Responsibility |
|-----------|----------|----------------|
| GitService | `apps/electron/src/main/git.ts` (NEW) | Execute git commands via simple-git, parse output |
| IPC Handlers | `apps/electron/src/main/ipc.ts` (MODIFY) | Add GIT_STATUS channel, wire to GitService |
| Preload API | `apps/electron/src/preload/index.ts` (MODIFY) | Expose getGitStatus() and onGitStatusChanged() |
| gitAtom | `apps/electron/src/renderer/atoms/git.ts` (NEW) | Workspace-keyed state (Map<workspaceId, GitState>) |
| useGitStatus | `apps/electron/src/renderer/hooks/useGitStatus.ts` (NEW) | Hook for accessing git state |
| GitStatusBadge | `apps/electron/src/renderer/components/git/` (NEW) | UI component for branch/status display |

**Key Patterns to Follow:**
1. **Event-Based Updates** - Matches existing patterns for sources, skills, themes. Watch .git directory with debouncing, broadcast status changes via IPC.
2. **Workspace-Scoped State** - Git state keyed by workspaceId in Map, not global. Matches existing workspace-scoped patterns (sources, sessions, labels).
3. **Graceful Degradation** - Return null for non-git directories, cache isRepo check. Existing getGitBranch returns null for non-repos.

**Anti-Patterns to Avoid:**
- Renderer-side git execution (violates security sandbox)
- Excessive polling (use .git directory file watching with debouncing)
- Global git state (breaks multi-workspace)
- Synchronous git calls in render path (UI freezes)

**UI Placement:** Add to workspace header area near WorkspaceSwitcher (consistent with "workspace context" information pattern). Small, unobtrusive badge/text showing "[PR #42] Fix user auth - Passing".

### Critical Pitfalls (from PITFALLS.md)

**Must address in Phase 1 (Core Git Status):**

1. **Naive Polling Without Throttling** - Calling git status without rate limiting spawns excessive subprocesses. Real-world example: 85-120+ git processes causing CPU spikes. **Prevention:** Debounce 300-500ms, watch .git/index and .git/HEAD only, use simple-git's maxConcurrentProcesses: 5, add --no-optional-locks flag.

2. **Blocking the Main Process** - Running git synchronously freezes entire app. Git Extensions users reported "up to a minute" waits in large repos. **Prevention:** Always async subprocess execution, never execSync, set 5s timeouts with retry, show loading states.

3. **Not Detecting Non-Git Directories** - Running git commands in non-repos causes error spam. **Prevention:** Pre-check with `git rev-parse --is-inside-work-tree`, cache result, design UI for non-git state, handle exit code 128 gracefully.

4. **Workspace State Confusion** (Kata Agents specific) - Git status from one workspace leaks to another in multi-workspace scenarios. **Prevention:** Scope all git state to workspace ID, cancel pending operations on workspace switch, test rapid switching.

**Must address in Phase 2 (PR Integration):**

5. **GitHub API Rate Limit Exhaustion** - 5,000 requests/hour authenticated (60 unauthenticated). Search API even stricter: 30 requests/minute. **Prevention:** Always authenticate, use conditional requests with ETags (cached responses don't count against limit), cache for 5-10 minutes, monitor X-RateLimit-Remaining header, implement exponential backoff.

**Cross-cutting concerns (all phases):**

6. **Cross-Platform Path/Line Ending Issues** - CRLF vs LF causes false positives. Windows paths use backslashes. **Prevention:** Use --porcelain -z for NUL-separated output, normalize paths internally, respect .gitattributes, enable long paths on Windows.

7. **Race Conditions in Status Updates** - Async operations complete out of order, UI shows stale state. **Prevention:** Cancel pending requests on new user action, use request IDs to discard stale responses, debounce aggressively, atomic state updates.

8. **Detached HEAD State** - UI assumes HEAD always points to branch. **Prevention:** Parse `git status --porcelain=v2 --branch` which includes detached HEAD info, show "HEAD detached at abc1234", test rebase/checkout scenarios.

---

## Implications for Roadmap

### Suggested Phase Structure

Based on dependencies and incremental value delivery:

#### Phase 1: Core Git Service (Main Process)
**Duration:** 2-3 days
**Deliverables:**
- GitService module with getGitStatus() using simple-git
- GIT_STATUS IPC handler in ipc.ts
- Preload API extensions (getGitStatus, onGitStatusChanged)
- Type definitions in shared/types.ts

**Rationale:** Foundation layer - all UI work depends on this. Must include throttling/debouncing from day one to prevent performance pitfalls. Workspace-scoped architecture is core requirement for multi-workspace app.

**Features from FEATURES.md:**
- Branch name detection
- Dirty/clean status
- Non-git directory handling

**Pitfalls to address:**
- Blocking main process (#2) - async-only from start
- Non-git directories (#3) - pre-check before operations
- Workspace state confusion (#14) - scope to workspace ID
- Cross-platform issues (#6) - use porcelain -z

**Research needs:** Standard patterns, no additional research required.

---

#### Phase 2: State Management (Renderer)
**Duration:** 1-2 days
**Deliverables:**
- gitAtom with workspace-keyed state (Map<workspaceId, GitState>)
- useGitStatus hook
- IPC listener for status updates
- State update coordination

**Rationale:** State layer - UI components depend on this. Follows established Jotai patterns from existing atoms (sources, sessions). Clear separation from Phase 1 allows parallel work if needed.

**Features from FEATURES.md:**
- State container for branch/status data
- Multi-workspace state isolation

**Pitfalls to address:**
- Race conditions (#7) - request cancellation, debouncing
- IPC overhead (#13) - batch updates, send diffs not full state

**Research needs:** None, established patterns.

---

#### Phase 3: Basic UI (Branch Display)
**Duration:** 2-3 days
**Deliverables:**
- GitStatusBadge component showing branch name
- Integration into WorkspaceSwitcher/workspace header
- Simple dirty/clean indicator
- Click-to-copy branch name

**Rationale:** First visible value. Low scope, table-stakes feature. Proves integration works before adding PR complexity.

**Features from FEATURES.md:**
- Current branch name display (table stakes)
- Branch display location (workspace header)
- Click-to-copy branch name (table stakes)

**Pitfalls to address:**
- Detached HEAD state (#5) - show "HEAD detached at abc1234"
- Poor error messaging (#8) - user-friendly messages for common errors

**Research needs:** None, straightforward UI implementation.

---

#### Phase 4: PR Integration
**Duration:** 3-4 days
**Deliverables:**
- GitHub PR info via gh CLI
- PR badge with status indicator (green check/yellow/red X)
- PR title display inline
- Click to open PR in browser
- Fallback for missing/unauthenticated gh CLI

**Rationale:** Differentiator feature - combines with AI context awareness. More complex due to external dependency (gh CLI) and rate limiting concerns. Clear separation from core git status allows deferral if needed.

**Features from FEATURES.md:**
- Linked PR display (table stakes)
- PR status indicator (table stakes)
- PR title inline (differentiator)
- One-click PR open (differentiator)

**Pitfalls to address:**
- Rate limit exhaustion (#4) - cache, ETags, exponential backoff
- Hardcoded default branch (#10) - query from remote/API
- Poor error messaging (#8) - graceful degradation if gh CLI unavailable

**Research needs:** May need `/kata:research-phase` if gh CLI integration patterns are unclear or if rate limiting strategy needs validation.

---

#### Phase 5: Real-Time Updates
**Duration:** 2-3 days
**Deliverables:**
- .git directory file watching (selective: .git/index, .git/HEAD, .git/refs/)
- Debounced status broadcasts (300-500ms)
- Watch cleanup on workspace switch
- Performance testing with active agent sessions

**Rationale:** Polish - improves UX but not blocking for core value. Separated from Phase 1 to allow incremental rollout. High risk of performance issues if not implemented carefully.

**Features from FEATURES.md:**
- Real-time status updates without manual refresh

**Pitfalls to address:**
- Naive polling (#1) - selective file watching, debouncing
- File watcher resource exhaustion (#11) - watch .git paths only, exclude node_modules
- Conflicting subprocess management (#12) - coordinate with SessionManager

**Research needs:** Likely yes - file watching patterns in Electron with performance constraints. Consider `/kata:research-phase` for file watching strategy.

---

#### Phase 6: AI Context Injection (DIFFERENTIATOR)
**Duration:** 1-2 days
**Deliverables:**
- Inject git context into agent system prompt
- Context format: "Current branch: feature/user-auth, PR #42 (Fix user auth) - Passing"
- Agent can reference git state in responses
- Update when git state changes

**Rationale:** Unique value proposition - no existing tool provides AI-aware git context. Relatively simple implementation once Phase 1-4 complete. Turns passive display into active assistance.

**Features from FEATURES.md:**
- AI context awareness (strongest differentiator)

**Pitfalls to address:**
- Stale context (#7) - update prompt when status changes
- Over-verbose prompts - keep git context concise

**Research needs:** None, straightforward prompt injection.

---

### Phase Dependency Graph

```
Phase 1: Core Git Service (Main Process)
    ↓
Phase 2: State Management (Renderer)
    ↓
Phase 3: Basic UI (Branch Display) ←— First user-visible value
    ↓
Phase 4: PR Integration ←— Can be deferred if needed
    ↓
Phase 5: Real-Time Updates ←— Polish, can be deferred
    ↓
Phase 6: AI Context Injection ←— DIFFERENTIATOR, requires Phases 1-4
```

**Critical path:** Phases 1-2-3 deliver table-stakes branch display. Phase 4 adds PR features. Phase 6 adds unique AI value. Phase 5 is polish and can float.

**Parallelization opportunities:**
- Phases 1 and 2 can overlap slightly (start Phase 2 once Phase 1 types are defined)
- Phase 6 can start once Phase 4 delivers PR data (doesn't depend on Phase 5)

---

### Research Flags

| Phase | Research Needed? | Rationale |
|-------|------------------|-----------|
| Phase 1 | NO | Standard git operations, established patterns |
| Phase 2 | NO | Follows existing Jotai patterns |
| Phase 3 | NO | Straightforward UI implementation |
| Phase 4 | MAYBE | gh CLI integration and rate limiting strategy. Consider `/kata:research-phase` if patterns unclear. |
| Phase 5 | YES | File watching performance in Electron with active agent sessions needs validation. Recommend `/kata:research-phase` for file watching strategy. |
| Phase 6 | NO | Simple prompt injection |

**Recommendation:** Phase 4 and Phase 5 are candidates for deeper research if implementation uncertainty arises. Phase 5 especially benefits from research given file watching performance risks.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | simple-git is ecosystem standard (8.5M weekly downloads), gh CLI documented. Both actively maintained. |
| Features | HIGH | Based on official documentation from VS Code, GitHub Desktop, JetBrains, GitLens. Table stakes well-established. |
| Architecture | HIGH | Extends existing patterns in codebase. GET_GIT_BRANCH already implemented, proving viability. |
| Pitfalls | HIGH | Verified with real-world GitHub issues (Git Extensions #5439, GitHub Desktop #11614, WSL #184). Official docs for rate limits and porcelain format. |

**Overall confidence: HIGH**

### Gaps to Address During Planning

1. **Exact UI placement** - Research shows header/status bar patterns, but specific positioning in Kata Agents workspace header needs UX decision. Mock up placement near WorkspaceSwitcher.

2. **gh CLI availability detection** - Need concrete strategy for detecting gh CLI presence and authentication status. Fallback message when unavailable: "Install and authenticate gh CLI for PR info."

3. **PR status refresh frequency** - Research recommends 5-10 minute cache, but actual user expectation unclear. Consider user preference or manual refresh button.

4. **Integration with existing agent context** - Phase 6 requires understanding current system prompt structure. Review prompts/ directory during Phase 6 planning.

5. **Performance baseline** - Test simple-git performance with typical repos (10k-100k files) to validate assumptions about debounce timing and concurrency limits.

6. **File watching scope** - Phase 5 needs specific decision on which .git paths to watch. Research suggests .git/index, .git/HEAD, .git/refs/ but validate against common workflows (rebase, merge, etc.).

---

## Sources

All research based on official documentation and verified real-world issues:

**Stack Research:**
- [simple-git npm](https://www.npmjs.com/package/simple-git) - Version 3.30.0
- [steveukx/git-js GitHub](https://github.com/steveukx/git-js) - TypeScript types
- [gh pr view documentation](https://cli.github.com/manual/gh_pr_view) - JSON fields
- Existing codebase: `apps/electron/src/main/shell-env.ts`, `ipc.ts:743-756`

**Features Research:**
- [VS Code Source Control Overview](https://code.visualstudio.com/docs/sourcecontrol/overview)
- [GitHub Desktop PR Viewing](https://docs.github.com/en/desktop/working-with-your-remote-repository-on-github-or-github-enterprise/viewing-a-pull-request-in-github-desktop)
- [JetBrains IntelliJ New UI](https://www.jetbrains.com/help/idea/new-ui.html)
- [GitLens Side Bar Views](https://help.gitkraken.com/gitlens/side-bar/)
- [GitHub Desktop 3.0 PR Integration](https://github.blog/2022-04-26-github-desktop-3-0-brings-better-integration-for-your-pull-requests/)

**Architecture Research:**
- Existing codebase patterns in `apps/electron/src/`
- Current implementation at `ipc.ts:743-756` (GET_GIT_BRANCH)
- Jotai atom patterns from `atoms/sessions.ts` and `atoms/sources.ts`

**Pitfalls Research:**
- [Git Status Documentation](https://git-scm.com/docs/git-status) - Porcelain format
- [GitHub Rate Limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [GitHub API Best Practices](https://docs.github.com/rest/guides/best-practices-for-using-the-rest-api)
- [Git Extensions #5439](https://github.com/gitextensions/gitextensions/issues/5439) - Status refresh performance
- [GitHub Desktop #11614](https://github.com/desktop/desktop/issues/11614) - Index refresh indicator
- [WSL #184](https://github.com/microsoft/WSL/issues/184) - Cross-platform line ending issues

---

## Ready for Roadmap Creation

This research summary provides sufficient detail for the kata-roadmapper agent to:

1. Structure phases with clear deliverables and dependencies
2. Identify which phases need deeper research
3. Understand critical pitfalls to embed in milestone acceptance criteria
4. Prioritize features (table stakes vs differentiators vs anti-features)
5. Make informed technology choices (simple-git + gh CLI)

**Key recommendations for roadmapper:**
- Start with Phases 1-2-3 for MVP (branch display)
- Add Phase 4 for PR integration
- Defer Phase 5 (real-time updates) to post-MVP if time-constrained
- Include Phase 6 (AI context) as key differentiator

**Next step:** Kata-roadmapper creates milestone breakdown with acceptance criteria incorporating pitfall prevention strategies.
