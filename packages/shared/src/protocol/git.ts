/**
 * Git / GitHub V1 protocol DTOs.
 *
 * These types are the stable wire contract between renderer clients and the
 * workspace-owning server for the managed-worktree Git workflow. The server
 * that owns the workspace filesystem owns all Git behavior; clients refer to a
 * session or workspace plus typed operation input, never a client-provided
 * mutation path (see the spec's ownership boundary).
 */

// ---------------------------------------------------------------------------
// Repository context and refs
// ---------------------------------------------------------------------------

export type GitProvider = 'github' | 'gitlab' | 'bitbucket' | 'other' | 'unknown'

export type GitRefType = 'local' | 'remote' | 'tag'

export interface GitRef {
  /** Short display name, e.g. `main`, `origin/main`, `v1.2.3`. */
  name: string
  /** Fully-qualified ref, e.g. `refs/heads/main`. */
  fullName: string
  type: GitRefType
  /** Commit SHA the ref points at, when resolved. */
  sha?: string
  /** True when this is the current checked-out branch. */
  isCurrent?: boolean
}

export interface GitRemoteInfo {
  name: string
  fetchUrl: string | null
  pushUrl: string | null
  provider: GitProvider
}

/**
 * Repository identity + live branch/remote context for a directory.
 * `isGitRepository` is false for non-Git directories; all other fields are
 * then null/empty so the composer can retain the ordinary working-directory
 * experience without unavailable Git controls.
 */
export interface RepositoryContext {
  isGitRepository: boolean
  repositoryRoot: string | null
  gitCommonDir: string | null
  currentBranch: string | null
  detached: boolean
  headSha: string | null
  /** Detected default ref (e.g. `main`), normalized to a branch name. */
  defaultRef: string | null
  remotes: GitRemoteInfo[]
  /** Name of the primary remote (usually `origin`) when present. */
  primaryRemote: string | null
  provider: GitProvider
}

export interface ListRefsResult {
  refs: GitRef[]
  currentBranch: string | null
  defaultRef: string | null
}

// ---------------------------------------------------------------------------
// Session checkout metadata (schema-versioned, persisted on the session)
// ---------------------------------------------------------------------------

export type CheckoutMode = 'current' | 'managed-worktree'

/**
 * Schema-versioned checkout record persisted on session metadata.
 *
 * Existing sessions have no checkout record and continue with current behavior,
 * deriving live Git context from `workingDirectory`. `expectedBranch` is a
 * validation expectation for managed worktrees; live branch/status always comes
 * from Git.
 */
export interface SessionCheckoutV1 {
  schemaVersion: 1
  mode: CheckoutMode
  /** Absolute owner-host path to the repository root. */
  repositoryRoot: string
  /** Absolute owner-host path to the active checkout (worktree or current dir). */
  checkoutPath: string
  /** Branch name captured at preparation time, or null. */
  branchAtPreparation: string | null
  /** Base ref a managed worktree was created from, or null for current checkout. */
  baseRef: string | null
  /** Managed worktree ID, or null for current checkout. */
  managedWorktreeId: string | null
  /** Expected `kata-agent/<token>` branch for a managed worktree, or null. */
  expectedBranch: string | null
}

// ---------------------------------------------------------------------------
// Checkout preparation (empty-session gate)
// ---------------------------------------------------------------------------

/**
 * Renderer-state intent for a checkout. A New worktree/ref intent remains
 * renderer state until preparation succeeds; it is not persisted as a promised
 * worktree on an unprepared empty session.
 */
export interface CheckoutPrepareIntent {
  mode: CheckoutMode
  /** Currently selected working directory (used to resolve repository identity). */
  workingDirectory: string
  /** Base ref for a new managed worktree. Required when mode is managed-worktree. */
  baseRef?: string | null
}

export interface CheckoutPrepareResult {
  checkout: SessionCheckoutV1
  /** Resolved working directory (the worktree for managed-worktree mode). */
  workingDirectory: string
  /** Resolved initial SDK cwd (bound atomically with workingDirectory). */
  sdkCwd: string
  /** Non-fatal warnings, e.g. from `.worktreeinclude` application. */
  warnings?: string[]
}

// ---------------------------------------------------------------------------
// Managed worktree lifecycle
// ---------------------------------------------------------------------------

export type ManagedWorktreeState =
  | 'preparing'
  | 'ready'
  | 'missing'
  | 'removing'
  | 'blocked'

export interface ManagedWorktreeRecord {
  managedWorktreeId: string
  repositoryRoot: string
  gitCommonDir: string
  checkoutPath: string
  baseRef: string | null
  expectedBranch: string
  createdAt: number
  ownerSessionIds: string[]
  state: ManagedWorktreeState
}

/**
 * Removal-risk inspection for a managed worktree. `blocked` is true while
 * another session owns it; destructive confirmations name affected file and
 * commit counts.
 */
export interface WorktreeRemovalRisk {
  managedWorktreeId: string
  exists: boolean
  ownerSessionIds: string[]
  /** Owners other than the session requesting removal. */
  otherOwnerCount: number
  uncommittedFileCount: number
  unpushedCommitCount: number
  /** Whether the temporary branch has unique work not present elsewhere. */
  branchHasUniqueWork: boolean
  blocked: boolean
  blockedReason?: string
}

export interface WorktreeRemovalResult {
  removed: boolean
  branchPruned: boolean
  blocked: boolean
  blockedReason?: string
}

/** Result of applying `.worktreeinclude` patterns into a new worktree. */
export interface WorktreeIncludeResult {
  copiedFileCount: number
  skippedSymlinks: number
  totalBytes: number
}

// ---------------------------------------------------------------------------
// Status model (foundational; consumed fully in Phase 2)
// ---------------------------------------------------------------------------

export type GitWorkingTreeEntryType =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'copied'
  | 'unknown'

export interface GitWorkingTreeEntry {
  path: string
  previousPath?: string
  type: GitWorkingTreeEntryType
  /** Index (staged) XY status char from `git status` porcelain, when known. */
  indexState?: string
  /** Worktree (unstaged) XY status char, when known. */
  worktreeState?: string
  conflicted?: boolean
}

export interface GitStatusSnapshot {
  repositoryRoot: string | null
  checkoutPath: string
  isGitRepository: boolean
  currentBranch: string | null
  detached: boolean
  defaultRef: string | null
  baseRef: string | null
  upstream: string | null
  ahead: number
  behind: number
  /** Publishable commits for no-upstream first-push eligibility. */
  publishableCommitCount: number
  /** Commits ahead of the PR base/default ref for pull-request eligibility. */
  baseDeltaCount: number
  primaryRemote: string | null
  provider: GitProvider
  entries: GitWorkingTreeEntry[]
  additions?: number
  deletions?: number
  operationInProgress: string | null
  blockedReason: string | null
}

// ---------------------------------------------------------------------------
// Commit / push / pull (Phase 3 contracts; declared now for routing)
// ---------------------------------------------------------------------------

export interface GitCommitInput {
  sessionId: string
  message: string
  /** Repository-relative paths to commit; defaults to all changed files. */
  paths?: string[]
}

export type GitActionStageStatus = 'succeeded' | 'failed' | 'skipped'

export interface GitActionStageResult {
  stage: 'commit' | 'push' | 'pull' | 'create-pr'
  status: GitActionStageStatus
  detail?: string
  error?: string
}

export interface GitActionResult {
  stages: GitActionStageResult[]
  commitSha?: string
  pullRequestUrl?: string
}

// ---------------------------------------------------------------------------
// GitHub (Phase 3 contracts; declared now for routing)
// ---------------------------------------------------------------------------

export interface GitHubCapabilityStatus {
  installed: boolean
  authenticated: boolean
  host: string | null
  detail?: string
}

export interface PullRequestSummary {
  number: number
  url: string
  title: string
  state: 'open' | 'closed' | 'merged'
  baseRef: string
  headRef: string
}

export interface CreatePullRequestInput {
  sessionId: string
  title: string
  body?: string
  baseRef?: string
}

// ---------------------------------------------------------------------------
// Structured error envelope
// ---------------------------------------------------------------------------

export interface GitOperationError {
  code: string
  message: string
  detail?: string
}
