/**
 * Git / GitHub V1 protocol DTOs.
 *
 * These types are the stable wire contract between renderer clients and the
 * workspace-owning server for the managed-worktree Git workflow. The server
 * that owns the workspace filesystem owns all Git behavior; clients refer to a
 * session or workspace plus typed operation input, never a client-provided
 * mutation path (see the spec's ownership boundary).
 */

import { CodedError, WORKTREE_V2_CAPABILITY_ERROR_CODE } from './types'
export { WORKTREE_V2_CAPABILITY_ERROR_CODE } from './types'

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

/**
 * V2 checkout metadata returned for a named managed worktree.
 *
 * V1 callers continue to use {@link SessionCheckoutV1}; they must not invent
 * display names or materialization roots when those fields were not supplied
 * by the server.
 */
export interface SessionCheckoutV2
  extends Omit<SessionCheckoutV1, 'schemaVersion' | 'mode' | 'branchAtPreparation' | 'managedWorktreeId' | 'expectedBranch'> {
  schemaVersion: 2
  mode: 'managed-worktree'
  branchAtPreparation: string
  managedWorktreeId: string
  /** User-provided suffix, also used as the display name. */
  displayName: string
  /** Exact branch ref returned by the server. */
  expectedBranch: string
  /** Canonical server-local root captured for this checkout. */
  materializationRoot: string
}

/** A checkout record from either the V1 or V2 wire schema. */
export type SessionCheckout = SessionCheckoutV1 | SessionCheckoutV2
export type SessionCheckoutVersioned = SessionCheckout

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
  /**
   * Base ref for a NEW managed worktree. Required when mode is managed-worktree
   * and no existing worktree is selected.
   */
  baseRef?: string | null
  /**
   * V2-only editable suffix for a NEW managed worktree. When omitted, the
   * server keeps the V1 generated eight-hex suffix behavior.
   */
  worktreeNameSuffix?: string | null
  /**
   * Bind the session to an EXISTING managed worktree instead of creating one.
   * The server re-validates workspace + repository identity and adds this
   * session as a shared owner; the checkout is never mutated for the new
   * session.
   */
  managedWorktreeId?: string | null
}

/** New-worktree intent with the V2 name suffix explicitly present. */
export interface CheckoutPrepareIntentV2 extends Omit<CheckoutPrepareIntent, 'worktreeNameSuffix'> {
  worktreeNameSuffix: string
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

/** V2 preparation result carrying the server-issued named checkout metadata. */
export interface CheckoutPrepareResultV2 {
  checkout: SessionCheckoutV2
  /** Resolved working directory (the V2 worktree). */
  workingDirectory: string
  /** Resolved initial SDK cwd (bound atomically with workingDirectory). */
  sdkCwd: string
  /** Non-fatal warnings, e.g. from `.worktreeinclude` application. */
  warnings?: string[]
}

/** Preparation result from either protocol version. */
export type CheckoutPrepareResultVersioned = CheckoutPrepareResult | CheckoutPrepareResultV2

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
  /** Owning workspace ID. Absent on records persisted before this field. */
  workspaceId?: string
  repositoryRoot: string
  gitCommonDir: string
  checkoutPath: string
  baseRef: string | null
  expectedBranch: string
  createdAt: number
  ownerSessionIds: string[]
  state: ManagedWorktreeState
}

/** The existing unversioned record shape, named for use in versioned unions. */
export type ManagedWorktreeRecordV1 = ManagedWorktreeRecord

/**
 * V2 registry record. The materialization root is persisted per record so a
 * later settings change never authorizes or relocates an existing checkout.
 */
export interface ManagedWorktreeRecordV2
  extends Omit<ManagedWorktreeRecord, 'workspaceId' | 'expectedBranch'> {
  schemaVersion: 2
  workspaceId: string
  displayName: string
  expectedBranch: string
  materializationRoot: string
  lastUsedAt: number
}

/** A registry record from either the V1 or V2 wire schema. */
export type ManagedWorktreeRecordVersioned = ManagedWorktreeRecord | ManagedWorktreeRecordV2

/**
 * Read-only summary of a ready managed worktree offered to a new session in
 * the same workspace + repository. Never carries mutation authority: binding
 * is a server-side ownership add keyed by `managedWorktreeId`.
 */
export interface ManagedWorktreeSummary {
  managedWorktreeId: string
  /** Absolute checkout path (display uses its directory name). */
  checkoutPath: string
  /** Branch name, e.g. `kata-agent/ab12cd34`. */
  expectedBranch: string
  /** Base ref the worktree was created from, or null. */
  baseRef: string | null
  /** Number of sessions currently owning this worktree (>= 1). */
  ownerCount: number
  state: ManagedWorktreeState
}

/** Server-issued summary for a V2 named worktree. */
export interface ManagedWorktreeSummaryV2
  extends Omit<ManagedWorktreeSummary, 'expectedBranch'> {
  schemaVersion: 2
  displayName: string
  expectedBranch: string
  materializationRoot: string
}

export type ManagedWorktreeSummaryVersioned = ManagedWorktreeSummary | ManagedWorktreeSummaryV2

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
  /**
   * Opaque digest of the exact checkout identity, dirty paths and contents,
   * and unique commit identities inspected by the server.
   */
  confirmationFingerprint: string
  blocked: boolean
  blockedReason?: string
}

/**
 * The destructive-work summary displayed before a managed worktree is
 * removed. The server checks it against a fresh inspection before removal so
 * a stale confirmation cannot authorize newer work.
 */
export interface WorktreeRemovalConfirmation {
  uncommittedFileCount: number
  unpushedCommitCount: number
  branchHasUniqueWork: boolean
  /** Exact server-issued snapshot the destructive confirmation was shown for. */
  confirmationFingerprint: string
}

export type WorktreeRemovalBlockedReasonCode = 'agent_not_quiesced'

export interface WorktreeRemovalResult {
  removed: boolean
  branchPruned: boolean
  blocked: boolean
  /** Stable reason for a localized client message when removal is blocked. */
  blockedReasonCode?: WorktreeRemovalBlockedReasonCode
  /** Optional server detail retained for non-localized diagnostics/fallbacks. */
  blockedReason?: string
}

/**
 * Options for the session-delete RPC. Managed-worktree removal is an explicit,
 * separate choice from deleting the session (spec: AC18–AC19).
 *
 * Removal is requested *through* deletion rather than as its own client call so
 * the server owns the ordering: quiesce the agent, verify removal is allowed,
 * delete the session durably, and only then remove the checkout. A client that
 * removed the worktree first could lose in-flight agent writes and, if the
 * subsequent delete failed, leave a session pointing at a checkout that no
 * longer exists.
 */
export interface SessionDeleteOptions {
  /** Remove the session's managed worktree once the session is deleted. */
  removeManagedWorktree?: boolean
  /** Confirm destructive removal (uncommitted files or unique commits). */
  forceWorktreeRemoval?: boolean
  /** The destructive-work summary shown when forceWorktreeRemoval was chosen. */
  worktreeRemovalConfirmation?: WorktreeRemovalConfirmation
}

/** Outcome of the session-delete RPC. */
export interface SessionDeleteResult {
  /** Whether the session itself was deleted. */
  deleted: boolean
  /**
   * Outcome of the managed-worktree removal, present only when it was
   * requested. A `blocked` result here with `deleted: false` means nothing was
   * changed at all: the guards rejected removal before deletion began.
   */
  worktreeRemoval?: WorktreeRemovalResult
}

/** Result of applying `.worktreeinclude` patterns into a new worktree. */
export interface WorktreeIncludeResult {
  copiedFileCount: number
  skippedSymlinks: number
  totalBytes: number
}

// ---------------------------------------------------------------------------
// V2 server capability and settings contracts
// ---------------------------------------------------------------------------

/**
 * Effective Git capability reported by the workspace-owning server.
 * `worktreeV2` is effective capability, not merely the local feature flag:
 * clients must not expose V2 controls when this is false.
 */
export interface ServerCapabilityDto {
  serverId: string
  worktreeV2: boolean
}

/** Immutable per-server root policy captured for a materialization operation. */
export interface WorktreeSettingsSnapshot {
  schemaVersion: 1
  serverId: string
  /** Monotonic settings revision used to fence creation against root updates. */
  version: number
  /** Canonical absolute server-local materialization root. */
  materializationRoot: string
  /** Server timestamp at which this snapshot was captured. */
  capturedAt: number
}

/** User-authored change to the selected server's root policy. */
export interface WorktreeSettingsUpdateInput {
  materializationRoot: string
}

/** Fixed registry file schemas; the path remains server-owned and stable. */
export interface WorktreeRegistryV1 {
  version: 1
  records: ManagedWorktreeRecordV1[]
}

export interface WorktreeRegistryV2 {
  version: 2
  records: ManagedWorktreeRecordV2[]
}

export type WorktreeRegistryVersioned = WorktreeRegistryV1 | WorktreeRegistryV2

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
  /** Line additions for this path, when computable (binary entries omit these). */
  additions?: number
  /** Line deletions for this path, when computable. */
  deletions?: number
  /** True when Git reports this path as binary (no line-level diff). */
  binary?: boolean
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
  /** Latest commit subject, used as the editable pull-request title default. */
  latestCommitSubject?: string
  /** Repository pull-request template, used as the editable PR body default. */
  pullRequestTemplate?: string
  primaryRemote: string | null
  provider: GitProvider
  entries: GitWorkingTreeEntry[]
  additions?: number
  deletions?: number
  operationInProgress: string | null
  blockedReason: string | null
}

// ---------------------------------------------------------------------------
// Bounded file diff (Phase 2)
// ---------------------------------------------------------------------------

/** Hard cap on either side of a text diff. Larger files render an oversized state. */
export const GIT_DIFF_MAX_BYTES = 2 * 1024 * 1024

/**
 * Explicit render state for a single file diff. The Changes panel maps each of
 * these to a distinct UI treatment (spec: explicit clean/non-Git/binary/
 * oversized/missing/loading/error states).
 */
export type GitFileDiffState =
  | 'text' // old/new text content present; render unified/split diff
  | 'binary' // binary file; no line-level diff
  | 'oversized' // one side exceeds GIT_DIFF_MAX_BYTES
  | 'missing' // expected file could not be read
  | 'clean' // path has no uncommitted changes
  | 'error' // read/parse failure (see `error`)

/**
 * Bounded diff for one repository-relative path. The Changes panel shows all
 * uncommitted changes in the active checkout, so `oldContent` is the committed
 * (HEAD) side and `newContent` is the current working-tree side.
 */
export interface GitFileDiff {
  path: string
  previousPath?: string
  changeType: GitWorkingTreeEntryType
  state: GitFileDiffState
  /** Committed (HEAD) content; empty string for added/untracked files. */
  oldContent?: string
  /** Working-tree content; empty string for deleted files. */
  newContent?: string
  additions?: number
  deletions?: number
  /** Byte size of the larger of the two sides. */
  sizeBytes?: number
  /**
   * Stable fingerprint of the diff content. A comment captured against a
   * fingerprint becomes stale when a later diff for the same path reports a
   * different fingerprint (spec: changed diff marks affected comments stale).
   */
  fingerprint: string
  /** Detected language token for syntax highlighting, when known. */
  language?: string
  /** Human-readable failure detail when `state` is `error`. */
  error?: string
}

/** Request a bounded diff by session ID and repository-relative path. */
export interface GitDiffRequest {
  sessionId: string
  path: string
}

// ---------------------------------------------------------------------------
// Diff line feedback (Phase 2)
// ---------------------------------------------------------------------------

/**
 * Which diff side a comment is anchored to. `old` maps to Pierre's `deletions`
 * annotation side (the committed/HEAD line), `new` maps to `additions` (the
 * working-tree line).
 */
export type GitCommentSide = 'old' | 'new'

/**
 * A pending diff-line comment. Scoped to a session; survives Changes-panel close
 * during the app run. Cleared only after the batched feedback message is
 * successfully submitted.
 */
export interface GitPendingComment {
  id: string
  sessionId: string
  /** Repository-relative path the comment is anchored to. */
  path: string
  previousPath?: string
  side: GitCommentSide
  /** 1-based line number on the chosen side. */
  line: number
  text: string
  /** Diff fingerprint captured when the comment was created. */
  diffFingerprint: string
  /** Short surrounding context (the anchored line's text) for the follow-up. */
  context: string
  createdAt: number
  /** True when the underlying diff fingerprint changed after creation. */
  stale?: boolean
}

// ---------------------------------------------------------------------------
// Status subscription (Phase 2)
// ---------------------------------------------------------------------------

/** Change kind reported by a status-change push event. */
export type GitStatusChangeReason = 'poll' | 'app-action' | 'external' | 'initial'

/**
 * Workspace-routed push payload emitted when a subscribed checkout's status
 * changes. Carries the session ID so multi-panel clients can bind the event to
 * the focused session panel.
 */
export interface GitStatusChangedEvent {
  sessionId: string
  status: GitStatusSnapshot
  reason: GitStatusChangeReason
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
  /**
   * Manual recovery command surfaced when a stage partially succeeded and left
   * work in a state the user may want to finish by hand — e.g. the path-limited
   * real-index reconciliation after a selected-file commit
   * (`git reset -q HEAD -- <paths>`). Presented as guidance, never auto-run.
   */
  recoveryCommand?: string
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

/** Typed rejection used when a V2 RPC is sent to an incapable server. */
export class WorktreeV2CapabilityError extends CodedError {
  constructor(message = 'Git worktree V2 capability is unavailable on this server.') {
    super(WORKTREE_V2_CAPABILITY_ERROR_CODE, message)
    this.name = 'WorktreeV2CapabilityError'
  }
}
