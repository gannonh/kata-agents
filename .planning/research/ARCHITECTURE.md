# Architecture Patterns: Git Status Integration

**Domain:** Git status UI for Electron desktop app
**Researched:** 2026-02-02
**Confidence:** HIGH (based on existing codebase patterns)

## Recommended Architecture

The git status feature should follow the existing architectural patterns in Kata Agents, maintaining separation between main process (Node.js), preload (context bridge), and renderer (React + Jotai).

```
+-------------------+     IPC      +------------------+     State     +------------------+
|   Main Process    | ----------> |     Preload      | -----------> |     Renderer     |
|   (Node.js)       | <---------- |  (Context Bridge)| <----------- |   (React/Jotai)  |
+-------------------+             +------------------+              +------------------+
        |                                                                    |
        v                                                                    v
   Git Commands                                                      Git Status UI
   (child_process)                                                   Components
```

### Component Boundaries

| Component | Responsibility | Location | Communicates With |
|-----------|----------------|----------|-------------------|
| GitService | Execute git commands, parse output | `apps/electron/src/main/git.ts` (NEW) | IPC handlers |
| IPC Handlers | Register git-related IPC channels | `apps/electron/src/main/ipc.ts` (MODIFY) | GitService, WindowManager |
| Preload API | Expose git methods to renderer | `apps/electron/src/preload/index.ts` (MODIFY) | Main process via IPC |
| gitAtom | Store workspace git state | `apps/electron/src/renderer/atoms/git.ts` (NEW) | React components |
| useGitStatus | Hook for accessing git state | `apps/electron/src/renderer/hooks/useGitStatus.ts` (NEW) | gitAtom |
| GitStatusIndicator | UI component for branch/status | `apps/electron/src/renderer/components/` (NEW) | useGitStatus |

### Data Flow

1. **Initial Load:** Renderer requests git status via IPC when workspace loads
2. **Polling/Events:** Main process periodically checks or watches for git changes
3. **State Update:** Main process sends git status via IPC event to renderer
4. **UI Update:** Jotai atom updates, components re-render

## Integration Points

### Main Process (Node.js)

**Existing Pattern:** Git branch detection already exists at line 743-756 of `ipc.ts`:

```typescript
// Current implementation
ipcMain.handle(IPC_CHANNELS.GET_GIT_BRANCH, (_event, dirPath: string) => {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: dirPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    }).trim()
    return branch || null
  } catch {
    return null
  }
})
```

**Extension Pattern:** Create dedicated GitService module for additional commands:

```typescript
// apps/electron/src/main/git.ts (NEW)
import { execSync, spawn } from 'child_process'

export interface GitStatus {
  branch: string | null
  isRepo: boolean
  isDirty: boolean
  staged: number
  unstaged: number
  untracked: number
  ahead: number
  behind: number
}

export function getGitStatus(dirPath: string): GitStatus {
  // Implementation using git status --porcelain=v2 --branch
}
```

### IPC Layer

**Existing Channels:**
- `GET_GIT_BRANCH` - Already implemented, returns branch name

**New Channels to Add:**
- `GIT_STATUS` - Full status object
- `GIT_STATUS_CHANGED` - Event broadcast for status changes

**IPC Pattern (from existing code):**

```typescript
// In ipc.ts - following existing patterns
ipcMain.handle(IPC_CHANNELS.GIT_STATUS, (_event, dirPath: string) => {
  return getGitStatus(dirPath)
})

// Broadcast pattern (similar to SOURCES_CHANGED)
windowManager.broadcastToWorkspace(workspaceId, IPC_CHANNELS.GIT_STATUS_CHANGED, status)
```

### Preload Bridge

**Existing Pattern (line 412-413 of preload/index.ts):**

```typescript
getGitBranch: (dirPath: string) =>
  ipcRenderer.invoke(IPC_CHANNELS.GET_GIT_BRANCH, dirPath),
```

**Extension:**

```typescript
// Add to ElectronAPI
getGitStatus: (dirPath: string) => ipcRenderer.invoke(IPC_CHANNELS.GIT_STATUS, dirPath),
onGitStatusChanged: (callback: (status: GitStatus) => void) => {
  const handler = (_event: Electron.IpcRendererEvent, status: GitStatus) => callback(status)
  ipcRenderer.on(IPC_CHANNELS.GIT_STATUS_CHANGED, handler)
  return () => ipcRenderer.removeListener(IPC_CHANNELS.GIT_STATUS_CHANGED, handler)
},
```

### Renderer State (Jotai)

**Existing Pattern (from atoms/sources.ts):**

```typescript
import { atom } from 'jotai'
export const sourcesAtom = atom<LoadedSource[]>([])
```

**Git State Atom:**

```typescript
// apps/electron/src/renderer/atoms/git.ts (NEW)
import { atom } from 'jotai'

export interface GitState {
  branch: string | null
  isRepo: boolean
  isDirty: boolean
  counts: {
    staged: number
    unstaged: number
    untracked: number
    ahead: number
    behind: number
  }
  lastUpdated: number
}

// Per-workspace git state (keyed by workspaceId)
export const gitStateAtom = atom<Map<string, GitState>>(new Map())

// Derived atom for current workspace
export const currentGitStateAtom = atom(
  (get) => {
    const workspaceId = get(currentWorkspaceIdAtom)
    if (!workspaceId) return null
    return get(gitStateAtom).get(workspaceId) ?? null
  }
)
```

### UI Components

**Location:** Following existing component organization patterns:

```
apps/electron/src/renderer/components/
├── app-shell/
│   ├── sidebar/
│   │   └── WorkspaceSwitcher.tsx  # Add git branch indicator
│   └── input/
│       └── FreeFormInput.tsx      # Already shows git branch
└── git/  (NEW directory)
    ├── GitStatusBadge.tsx         # Small badge for sidebar
    ├── GitStatusPanel.tsx         # Detailed status view
    └── GitBranchPicker.tsx        # Branch selection (future)
```

## Patterns to Follow

### Pattern 1: Event-Based Updates

**What:** Broadcast status changes from main to renderer via IPC events
**When:** Git status changes (file save, external git operation)
**Rationale:** Matches existing patterns for sources, skills, and themes

```typescript
// Main process
const watchGitDir = (workspacePath: string, workspaceId: string) => {
  const gitDir = join(workspacePath, '.git')
  const watcher = watch(gitDir, { persistent: false })
  watcher.on('change', debounce(() => {
    const status = getGitStatus(workspacePath)
    windowManager.broadcastToWorkspace(workspaceId, IPC_CHANNELS.GIT_STATUS_CHANGED, status)
  }, 500))
  return () => watcher.close()
}
```

### Pattern 2: Workspace-Scoped State

**What:** Git state tied to workspace, not global
**When:** Each workspace may have different git repos
**Rationale:** Matches existing workspace-scoped patterns (sources, sessions, labels)

```typescript
// Atom keyed by workspaceId
const gitStateByWorkspace = atom<Map<string, GitState>>(new Map())

// Hook that reads for current workspace
export function useGitStatus(): GitState | null {
  const workspaceId = useWorkspaceId()
  const gitStates = useAtomValue(gitStateByWorkspace)
  return gitStates.get(workspaceId) ?? null
}
```

### Pattern 3: Graceful Degradation

**What:** Handle non-git directories and missing git executable
**When:** Workspace may not be a git repo
**Rationale:** Existing getGitBranch returns null for non-repos

```typescript
// Service handles errors internally
export function getGitStatus(dirPath: string): GitStatus {
  try {
    // ... git commands
  } catch {
    return {
      branch: null,
      isRepo: false,
      isDirty: false,
      // ... zero counts
    }
  }
}
```

## Anti-Patterns to Avoid

### Anti-Pattern 1: Renderer-Side Git Execution

**What:** Running git commands directly in renderer process
**Why bad:**
- Security: Renderer is sandboxed, shouldn't spawn processes
- Architecture: Violates main/renderer separation
- Platform: Node.js APIs not available in renderer
**Instead:** Always execute git commands in main process, communicate via IPC

### Anti-Pattern 2: Excessive Polling

**What:** Polling git status every few seconds
**Why bad:**
- Performance: Unnecessary CPU usage
- Battery: Drains laptop battery
- Latency: Still misses rapid changes
**Instead:** Use .git directory file watching with debouncing

### Anti-Pattern 3: Global Git State

**What:** Single global atom for git status
**Why bad:**
- Multi-workspace: User may have multiple workspaces open
- State collision: Switching workspaces would clobber state
**Instead:** Key git state by workspaceId

### Anti-Pattern 4: Synchronous Git Calls in Render Path

**What:** Calling git synchronously during component render
**Why bad:**
- Blocking: UI freezes during git command
- Performance: Git operations can be slow
**Instead:** Load asynchronously, show loading state, cache results

## Scalability Considerations

| Concern | Current Scope | Future Scale | Approach |
|---------|---------------|--------------|----------|
| Multiple workspaces | 1-5 | 10-20 | Map-based state, lazy loading |
| Large repos | <10k files | 100k+ files | Use git status --porcelain (fast) |
| Frequent changes | Manual | Auto-save tools | Debounce file watchers (500ms) |
| Network repos | Local only | GitHub/GitLab | Cache remote status, async refresh |

## Suggested Build Order

Based on dependencies and incremental value delivery:

### Phase 1: Core Git Service (Main Process)
1. Create `GitService` module with `getGitStatus()`
2. Add `GIT_STATUS` IPC handler
3. Update `IPC_CHANNELS` enum
4. Extend preload API

**Rationale:** Foundation - all UI work depends on this

### Phase 2: State Management (Renderer)
1. Create `gitAtom` with workspace-keyed state
2. Create `useGitStatus` hook
3. Wire up IPC listener for status updates

**Rationale:** State layer - UI components depend on this

### Phase 3: Basic UI (Branch Display)
1. Extend existing branch display in FreeFormInput
2. Add GitStatusBadge to WorkspaceSwitcher
3. Simple dirty/clean indicator

**Rationale:** Visible value with minimal scope

### Phase 4: Real-Time Updates
1. Implement .git directory watching
2. Add debounced status broadcasts
3. Handle watch cleanup on workspace switch

**Rationale:** Polish - improves UX but not blocking

### Phase 5: Enhanced UI (Optional)
1. GitStatusPanel with file lists
2. Staged/unstaged counts
3. Ahead/behind indicators

**Rationale:** Nice-to-have features

## New vs Modified Components

| Component | Status | File Path | Changes |
|-----------|--------|-----------|---------|
| GitService | NEW | `apps/electron/src/main/git.ts` | Full implementation |
| IPC Handlers | MODIFY | `apps/electron/src/main/ipc.ts` | Add GIT_STATUS handler |
| IPC Channels | MODIFY | `apps/electron/src/shared/types.ts` | Add channel constants |
| ElectronAPI | MODIFY | `apps/electron/src/shared/types.ts` | Add git methods to interface |
| Preload | MODIFY | `apps/electron/src/preload/index.ts` | Expose git methods |
| gitAtom | NEW | `apps/electron/src/renderer/atoms/git.ts` | State management |
| useGitStatus | NEW | `apps/electron/src/renderer/hooks/useGitStatus.ts` | React hook |
| GitStatusBadge | NEW | `apps/electron/src/renderer/components/git/GitStatusBadge.tsx` | UI component |

## Type Definitions

Add to `apps/electron/src/shared/types.ts`:

```typescript
// Git status types
export interface GitStatus {
  branch: string | null
  isRepo: boolean
  isDirty: boolean
  staged: number
  unstaged: number
  untracked: number
  ahead: number
  behind: number
}

// IPC channel constants
export const IPC_CHANNELS = {
  // ... existing channels
  GIT_STATUS: 'git:status',
  GIT_STATUS_CHANGED: 'git:statusChanged',
} as const

// ElectronAPI additions
export interface ElectronAPI {
  // ... existing methods
  getGitStatus(dirPath: string): Promise<GitStatus>
  onGitStatusChanged(callback: (status: GitStatus) => void): () => void
}
```

## Sources

- Existing codebase patterns in `/Users/gannonhall/dev/kata/kata-agents/apps/electron/src/`
- Current `GET_GIT_BRANCH` implementation at `ipc.ts:743-756`
- FreeFormInput git branch usage at `FreeFormInput.tsx:1679`
- Jotai atom patterns from `atoms/sessions.ts` and `atoms/sources.ts`
- IPC patterns from `preload/index.ts` and `ipc.ts`
