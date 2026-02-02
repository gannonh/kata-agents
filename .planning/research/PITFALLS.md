# Domain Pitfalls: Git Status UI Integration

**Domain:** Git status display in developer tools (Electron desktop app)
**Researched:** 2026-02-02
**Confidence:** HIGH (verified with official docs and real-world examples)

---

## Critical Pitfalls

Mistakes that cause rewrites, performance degradation, or major user experience issues.

---

### Pitfall 1: Naive Polling Without Throttling

**What goes wrong:** Calling `git status` on every keystroke, file save, or timer tick without rate limiting. This spawns excessive subprocess calls, consuming CPU and causing UI lag.

**Why it happens:** Developers want "real-time" status updates and implement the simplest solution: poll frequently. They underestimate the cost of subprocess spawning in Node.js/Electron.

**Consequences:**
- High CPU utilization (especially on large repositories)
- UI becomes unresponsive during rapid file changes
- Battery drain on laptops
- In extreme cases, 85-120+ git processes competing for resources ([source](https://github.com/steveyegge/gastown/issues/503))

**Warning signs:**
- CPU spikes when typing in editor or saving files
- Noticeable delay between file change and UI update
- Multiple `git` processes visible in Activity Monitor

**Prevention:**
1. **Debounce git status calls** - Wait 300-500ms after last change before refreshing
2. **Use file system watchers selectively** - Watch `.git/index` and `.git/HEAD` instead of entire working tree
3. **Limit concurrent git processes** - simple-git supports `{ maxConcurrentProcesses: 5 }` ([source](https://www.npmjs.com/package/simple-git))
4. **Use `--no-optional-locks`** - Prevents lock conflicts when running status in background ([source](https://git-scm.com/docs/git-status))

**Which phase should address:** Phase 1 (Core Git Status) - Build with throttling from the start

---

### Pitfall 2: Blocking the Main Process with Git Commands

**What goes wrong:** Running `git status` synchronously or in the Electron main process, freezing the entire app while waiting for git to complete.

**Why it happens:** Simplest implementation uses `execSync` or awaits subprocess in main process. Works fine in small repos but fails catastrophically in large ones.

**Consequences:**
- App freezes for seconds in large repositories
- "Application Not Responding" dialogs on macOS/Windows
- Users think app has crashed
- Git Extensions reported users waiting "up to a minute" for status in repos with many ignored files ([source](https://github.com/gitextensions/gitextensions/issues/5439))

**Warning signs:**
- App unresponsive during git operations
- Window stops redrawing while switching workspaces
- Cursor freezes momentarily

**Prevention:**
1. **Always use async subprocess execution** - Never `execSync` for git commands
2. **Run git operations in renderer or worker** - Keep main process responsive
3. **Show loading states** - GitHub Desktop shows "Refreshing repository" during long operations ([source](https://github.com/desktop/desktop/issues/11614))
4. **Set timeouts** - Kill git processes that take too long (suggest 5s timeout with retry)

**Which phase should address:** Phase 1 (Core Git Status) - Architecture decision from day one

---

### Pitfall 3: Not Detecting Non-Git Directories

**What goes wrong:** Running git commands in directories without a `.git` folder, causing error spam and confusing error handling.

**Why it happens:** Developers test in git repos and forget to handle the non-git case. The "fatal: not a git repository" error is unexpected in happy-path testing.

**Consequences:**
- Error dialogs for users with non-git workspaces
- Log spam from git errors
- Potential crashes if error handling is incomplete
- Confusing UI showing partial/broken git status

**Warning signs:**
- Errors in logs mentioning "fatal: not a git repository"
- Git status UI appearing then disappearing
- Inconsistent behavior based on workspace type

**Prevention:**
1. **Pre-check with `git rev-parse --is-inside-work-tree`** - Verify git repo before other commands
2. **Cache the result** - Don't re-check on every operation
3. **Design UI for non-git state** - Show "Not a git repository" or hide git UI entirely
4. **Handle gracefully** - Catch the exit code 128 from git commands in non-repos ([source](https://www.git-tower.com/learn/git/faq/fatal-not-a-git-repository))

**Which phase should address:** Phase 1 (Core Git Status) - Core requirement before any git features

---

### Pitfall 4: GitHub API Rate Limit Exhaustion

**What goes wrong:** Hitting the 5,000 requests/hour limit (authenticated) or 60/hour (unauthenticated) when fetching PR information, causing features to stop working.

**Why it happens:**
- Polling for PR status too frequently
- Not caching responses
- Multiple workspaces each making independent requests
- Forgetting that unauthenticated requests share a global limit

**Consequences:**
- PR status stops updating for 1+ hours
- Error messages confuse users
- Features appear broken ("no PR found") when rate limited
- Search API has even stricter limit: 30 requests/minute ([source](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api))

**Warning signs:**
- `X-RateLimit-Remaining` header approaching zero
- 403 responses with rate limit error message
- Features work intermittently

**Prevention:**
1. **Always authenticate requests** - 5,000/hour vs 60/hour
2. **Use conditional requests (ETags)** - Cached responses don't count against limit when data unchanged ([source](https://docs.github.com/rest/guides/best-practices-for-using-the-rest-api))
3. **Cache aggressively** - PR data changes infrequently; cache for 5-10 minutes
4. **Monitor rate limit headers** - Implement exponential backoff when approaching limit
5. **Consider webhooks for production** - Push instead of poll for real-time updates ([source](https://docs.github.com/rest/guides/best-practices-for-using-the-rest-api))

**Which phase should address:** Phase 2 (PR Integration) - Must design API layer with rate limits in mind

---

## Moderate Pitfalls

Mistakes that cause technical debt, poor UX, or significant rework.

---

### Pitfall 5: Ignoring Detached HEAD State

**What goes wrong:** UI assumes HEAD always points to a branch, breaking when user is in detached HEAD state (common when checking out commits or during rebases).

**Why it happens:** Developers test with normal branch workflows and forget that HEAD can point directly to a commit.

**Consequences:**
- UI shows empty or "undefined" for branch name
- Features that depend on branch name fail silently
- Crashes if code assumes branch name is always a string

**Warning signs:**
- Blank branch name in UI
- Errors when user checks out a specific commit
- Broken behavior during `git rebase`

**Prevention:**
1. **Parse `git status --porcelain=v2 --branch`** - Includes detached HEAD info ([source](https://git-scm.com/docs/git-status))
2. **Check for detached state explicitly** - `.git/HEAD` contains commit SHA instead of `ref: refs/heads/...`
3. **Design UI for detached state** - Show "HEAD detached at abc1234" like git does ([source](https://www.cloudbees.com/blog/git-detached-head))
4. **Test rebase and checkout scenarios** - Common user workflows that trigger detached HEAD

**Which phase should address:** Phase 1 (Core Git Status) - Handle during branch name implementation

---

### Pitfall 6: Cross-Platform Path and Line Ending Issues

**What goes wrong:** Git status shows false positives for changed files due to line ending differences (CRLF vs LF) or path handling differences between Windows, macOS, and Linux.

**Why it happens:**
- Windows uses `\r\n` (CRLF), Unix uses `\n` (LF)
- Windows paths use backslashes, Unix uses forward slashes
- Case sensitivity differs: Linux is case-sensitive, Windows/macOS are not ([source](https://learn.microsoft.com/en-us/azure/devops/repos/git/os-compatibility))

**Consequences:**
- Files appear modified when unchanged
- Git status shows all files as changed on Windows/WSL ([source](https://github.com/microsoft/WSL/issues/184))
- Users on different platforms see different status for same repo
- Incorrect file counts in UI

**Warning signs:**
- "All files modified" after checkout on different platform
- Path-related errors on Windows
- File not found errors with valid-looking paths

**Prevention:**
1. **Normalize paths** - Use forward slashes internally, convert for display
2. **Respect `.gitattributes`** - Let git handle line ending normalization
3. **Use `--porcelain -z`** - NUL-separated output handles special characters ([source](https://www.npmjs.com/package/parse-git-status))
4. **Enable long paths on Windows** - `git config --system core.longpaths true` ([source](https://www.shadynagy.com/solving-windows-path-length-limitations-in-git/))
5. **Test on all platforms** - Cross-platform bugs are subtle

**Which phase should address:** Phase 1 (Core Git Status) - Use portable parsing from start

---

### Pitfall 7: Race Conditions in Status Updates

**What goes wrong:** UI shows stale or incorrect status because git status result arrives after user has made more changes, or multiple status requests return out of order.

**Why it happens:**
- Async operations complete in unpredictable order
- User can make changes faster than status can refresh
- No coordination between status requests

**Consequences:**
- UI shows "3 files changed" after user already committed them
- Flickering between old and new status
- Confusing UX where status doesn't match reality

**Warning signs:**
- Status counts don't match what user expects
- Status jumps between values
- "Ghost" changes that disappear on manual refresh

**Prevention:**
1. **Cancel pending requests** - New user action invalidates in-flight status requests
2. **Use request IDs** - Discard responses from stale requests
3. **Debounce aggressively** - Single source of truth for "when to refresh"
4. **Optimistic UI updates** - Show expected state immediately, reconcile with git later
5. **Atomic state updates** - Update all status-related UI together

**Which phase should address:** Phase 1 (Core Git Status) - Part of core architecture

---

### Pitfall 8: Poor Error Messaging for Git Failures

**What goes wrong:** Git command fails (corrupt repo, network issue, permission problem) and UI shows generic error or crashes instead of helpful message.

**Why it happens:** Developers focus on happy path. Git has many failure modes with cryptic error messages that need translation for users.

**Consequences:**
- Users don't know what's wrong or how to fix it
- Support burden increases
- Users assume app is buggy when git is the problem

**Warning signs:**
- "Something went wrong" messages
- Raw git error messages shown to users
- Silent failures with no indication

**Prevention:**
1. **Parse git stderr** - Extract actionable information
2. **Map common errors to user-friendly messages:**
   - "fatal: not a git repository" -> "This folder is not a git repository"
   - Exit code 128 with "permission denied" -> "Git cannot access this folder"
   - Network errors -> "Could not connect to GitHub. Check your internet connection."
3. **Log full error for debugging** - User message != debug info
4. **Provide recovery actions** - "Open folder in terminal" or "Check git installation"

**Which phase should address:** All phases - Ongoing concern, establish pattern in Phase 1

---

## Minor Pitfalls

Mistakes that cause annoyance but are relatively easy to fix.

---

### Pitfall 9: Not Using Porcelain Output Format

**What goes wrong:** Parsing human-readable `git status` output which changes based on git version, locale, and configuration.

**Why it happens:** Human-readable output looks easy to parse with regex until edge cases appear.

**Consequences:**
- Parsing breaks with different git versions
- Non-English locales produce unparseable output
- Filenames with spaces or special characters break parsing

**Prevention:**
1. **Always use `--porcelain` or `--porcelain=v2`** - Stable, machine-readable format ([source](https://git-scm.com/docs/git-status))
2. **Use `-z` flag** - NUL-separated output for filenames with special characters
3. **Use existing parsers** - `parse-git-status` or `@putout/git-status-porcelain` npm packages ([source](https://www.npmjs.com/package/parse-git-status))

**Which phase should address:** Phase 1 (Core Git Status) - Foundational decision

---

### Pitfall 10: Hardcoding 'main' or 'master' as Default Branch

**What goes wrong:** Assuming the default branch is named 'main' or 'master' when repositories can have any default branch name.

**Why it happens:** Historical convention (master) and GitHub's new default (main) make these assumptions feel safe.

**Consequences:**
- Incorrect "behind default" calculations
- PR base branch detection fails
- Features break for repos with custom default branches (e.g., 'develop', 'trunk')

**Prevention:**
1. **Query remote for default branch** - `git remote show origin | grep 'HEAD branch'`
2. **Check local git config** - `git config --get init.defaultBranch`
3. **Use GitHub API for repos** - `GET /repos/{owner}/{repo}` includes `default_branch`
4. **Make configurable** - Let users override if needed

**Which phase should address:** Phase 2 (PR Integration) - Relevant when comparing to default branch

---

### Pitfall 11: File Watcher Resource Exhaustion

**What goes wrong:** Watching too many files or directories exhausts OS file descriptor limits or causes high CPU from polling fallback.

**Why it happens:**
- Watching entire working tree instead of selective paths
- Chokidar falls back to CPU polling silently when fsevents fails ([source](https://www.hendrik-erz.de/post/electron-chokidar-and-native-nodejs-modules-a-horror-story-from-integration-hell))
- Not excluding node_modules and other large directories

**Consequences:**
- "EMFILE: too many open files" errors
- High CPU from polling fallback
- Slow app startup

**Warning signs:**
- EMFILE errors in logs
- High CPU when app is idle
- Watcher-related errors in console

**Prevention:**
1. **Watch selectively** - Only `.git/HEAD`, `.git/index`, `.git/refs/` instead of entire tree
2. **Exclude large directories** - `node_modules`, `build`, `.git/objects`
3. **Monitor for polling fallback** - Check chokidar isn't silently polling
4. **Use git's built-in fsmonitor** - `core.useBuiltinFSMonitor = true` for large repos ([source](https://github.blog/engineering/infrastructure/improve-git-monorepo-performance-with-a-file-system-monitor/))

**Which phase should address:** Phase 1 (Core Git Status) - If using file watchers for real-time updates

---

## Integration Pitfalls (Kata Agents Specific)

Mistakes specific to adding git status to an existing Electron app.

---

### Pitfall 12: Conflicting Subprocess Management

**What goes wrong:** New git subprocess spawning conflicts with existing SessionManager subprocess model, causing resource contention or architectural inconsistency.

**Why it happens:** Kata Agents already spawns Bun subprocesses for agent sessions. Adding git subprocesses without coordination can overload the system.

**Consequences:**
- Too many child processes competing for resources
- Inconsistent patterns between agent and git process management
- Complex debugging when issues span multiple subprocess types

**Prevention:**
1. **Centralize subprocess management** - Consider adding git commands to existing subprocess infrastructure
2. **Set global concurrency limits** - Account for both agent and git processes
3. **Use simple-git's queue** - `{ maxConcurrentProcesses: N }` limits parallel git operations
4. **Profile combined load** - Test with active agent sessions + git polling

**Which phase should address:** Phase 1 (Core Git Status) - Architectural decision before implementation

---

### Pitfall 13: IPC Overhead for Frequent Updates

**What goes wrong:** Sending git status updates from main process to renderer via IPC on every change creates overhead and potential memory issues.

**Why it happens:** Existing IPC pattern works for infrequent events. Git status can change rapidly during file operations.

**Consequences:**
- IPC queue backs up during rapid changes
- Memory pressure from queued messages
- UI updates lag behind reality

**Prevention:**
1. **Batch status updates** - Aggregate changes over 100-200ms before sending to renderer
2. **Send diffs, not full state** - Only changed information, not entire status
3. **Use efficient serialization** - Avoid serializing large file lists repeatedly
4. **Consider SharedArrayBuffer** - For very frequent updates (likely overkill)

**Which phase should address:** Phase 1 (Core Git Status) - Design IPC contract early

---

### Pitfall 14: Workspace State Confusion

**What goes wrong:** Git status from one workspace "leaks" to another in multi-workspace scenarios, or status persists after workspace change.

**Why it happens:** State management doesn't properly scope git status to workspace. Async operations complete after workspace switch.

**Consequences:**
- Wrong branch name shown after switching workspaces
- File counts from previous workspace
- Confusing mixed state in UI

**Prevention:**
1. **Scope all git state to workspace ID** - Never use global git state
2. **Cancel pending operations on workspace switch** - Use AbortController
3. **Clear git state when workspace changes** - Start fresh
4. **Test rapid workspace switching** - Common user pattern

**Which phase should address:** Phase 1 (Core Git Status) - Core requirement for multi-workspace app

---

## Phase-Specific Warnings

| Phase | Likely Pitfall | Mitigation |
|-------|----------------|------------|
| Phase 1: Core Git Status | Blocking main process (#2) | Async-only from day one, use worker if needed |
| Phase 1: Core Git Status | Non-git directories (#3) | Pre-check before any git operations |
| Phase 1: Core Git Status | Polling without throttling (#1) | Debounce + selective file watching |
| Phase 2: PR Integration | Rate limit exhaustion (#4) | Cache + ETag + exponential backoff |
| Phase 2: PR Integration | Hardcoded default branch (#10) | Query from remote/API |
| Cross-cutting | Cross-platform issues (#6) | Use porcelain -z, normalize paths |
| Cross-cutting | Race conditions (#7) | Request cancellation + debouncing |

---

## Sources

### Official Documentation
- [Git Status Documentation](https://git-scm.com/docs/git-status) - Porcelain format specification
- [GitHub Rate Limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) - API rate limit details
- [GitHub API Best Practices](https://docs.github.com/rest/guides/best-practices-for-using-the-rest-api) - Conditional requests, ETags

### Library Documentation
- [simple-git npm](https://www.npmjs.com/package/simple-git) - Node.js git wrapper
- [parse-git-status npm](https://www.npmjs.com/package/parse-git-status) - Porcelain output parser

### Real-World Issues
- [Git Extensions #5439](https://github.com/gitextensions/gitextensions/issues/5439) - Status refresh performance
- [GitHub Desktop #11614](https://github.com/desktop/desktop/issues/11614) - Index refresh indicator
- [WSL #184](https://github.com/microsoft/WSL/issues/184) - Cross-platform line ending issues
- [Chokidar Horror Story](https://www.hendrik-erz.de/post/electron-chokidar-and-native-nodejs-modules-a-horror-story-from-integration-hell) - Electron file watcher pitfalls

### Platform Guidance
- [Azure DevOps Cross-Platform](https://learn.microsoft.com/en-us/azure/devops/repos/git/os-compatibility) - Git cross-platform issues
- [GitHub Blog: FSMonitor](https://github.blog/engineering/infrastructure/improve-git-monorepo-performance-with-a-file-system-monitor/) - Performance optimization
- [Windows Long Paths](https://www.shadynagy.com/solving-windows-path-length-limitations-in-git/) - Windows-specific issue
