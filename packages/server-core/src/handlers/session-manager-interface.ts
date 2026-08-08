/**
 * ISessionManager — abstract interface for the session lifecycle engine.
 *
 * Handler code in server-core programs against this interface;
 * concrete implementations (Electron SessionManager, headless, etc.)
 * satisfy it at runtime.
 */

import type { Workspace, WorkspaceInfo, ActiveSessionInfo } from '@kata-sh/core/types'
import type { StoredAttachment, AnnotationV1 } from '@kata-sh/core/types'
import type { PermissionMode } from '@kata-sh/shared/agent/mode-types'
import type { ThinkingLevel } from '@kata-sh/shared/agent/thinking-levels'
import type { AuthResult } from '@kata-sh/shared/agent'
import type {
  Session,
  SessionStatus,
  CreateSessionOptions,
  FileAttachment,
  SendMessageOptions,
  PermissionResponseOptions,
  CredentialResponse,
  PermissionModeState,
  UnreadSummary,
  ShareResult,
} from '@kata-sh/shared/protocol'
import type { SessionBundle, DispatchMode } from '@kata-sh/shared/sessions'
import type { EventSink } from '../transport'

export interface ISessionManager {
  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  waitForInit(): Promise<void>
  initialize(): Promise<void>
  cleanup(): void
  setEventSink(sink: EventSink): void
  flushAllSessions(): Promise<void>

  // ---------------------------------------------------------------------------
  // Session CRUD
  // ---------------------------------------------------------------------------

  getSessions(workspaceId?: string): Session[]
  getSession(sessionId: string): Promise<Session | null>
  createSession(workspaceId: string, options?: CreateSessionOptions): Promise<Session>
  deleteSession(
    sessionId: string,
    options?: import('@kata-sh/shared/protocol').SessionDeleteOptions,
  ): Promise<import('@kata-sh/shared/protocol').SessionDeleteResult>

  // ---------------------------------------------------------------------------
  // Session state
  // ---------------------------------------------------------------------------

  flagSession(sessionId: string): Promise<void>
  unflagSession(sessionId: string): Promise<void>
  archiveSession(sessionId: string): Promise<void>
  unarchiveSession(sessionId: string): Promise<void>
  renameSession(sessionId: string, name: string): Promise<void>
  setSessionStatus(sessionId: string, status: SessionStatus): Promise<void>
  markSessionRead(sessionId: string): Promise<void>
  markSessionUnread(sessionId: string): Promise<void>
  markAllSessionsRead(workspaceId: string): Promise<void>
  setActiveViewingSession(sessionId: string | null, workspaceId: string): void
  clearActiveViewingSession(workspaceId: string): void

  // ---------------------------------------------------------------------------
  // Session configuration
  // ---------------------------------------------------------------------------

  setSessionPermissionMode(sessionId: string, mode: PermissionMode): void
  setSessionThinkingLevel(sessionId: string, level: ThinkingLevel): void
  updateWorkingDirectory(sessionId: string, path: string): void

  /**
   * Prepare a session's Git checkout (empty-session gate).
   *
   * Rejects unless the session has no messages, no SDK session ID, and no live
   * agent. For managed-worktree intent, creates a managed worktree + temporary
   * `kata-agent/<token>` branch on the workspace-owning server and binds
   * checkout metadata, `workingDirectory`, and initial `sdkCwd` atomically.
   * With `intent.managedWorktreeId`, binds to an existing ready worktree of
   * the same workspace + repository instead, adding this session as a shared
   * owner without mutating the checkout. Idempotent only when the intent
   * matches the persisted ready record.
   */
  prepareCheckout(
    sessionId: string,
    intent: import('@kata-sh/shared/protocol').CheckoutPrepareIntentVersioned,
  ): Promise<import('@kata-sh/shared/protocol').CheckoutPrepareResultVersioned>
  /**
   * Ready managed worktrees in the session's workspace + repository that a
   * new session may bind to (read-only discovery; excludes the session's own
   * worktree). Identity is resolved server-side from the working directory.
   */
  listManagedWorktrees(
    sessionId: string,
    workingDirectory: string,
  ): Promise<import('@kata-sh/shared/protocol').ManagedWorktreeSummaryVersioned[]>
  /**
   * Inject the server-owned Git domain so the checkout gate shares one
   * managed-worktree registry with the git RPC handlers. Optional: falls back
   * to the lazily-constructed default services when never called.
   */
  setGitServices?(services: import('../git').GitServices): void
  /**
   * Durable fork-state facts for one session (Phase 4 reconciliation): the
   * child SDK session id, the pending fork intent, and the checkout-strategy
   * provenance. Used by fork-journal reconciliation to backfill the establish
   * marker a crash between the child-session flush and markEstablished lost.
   */
  resolveSessionForkState?(sessionId: string): import('../git').SessionForkState | null
  /**
   * Install a callback that requests an immediate Git status refresh for a
   * session. The git RPC handlers wire this so agent turn completion refreshes
   * the Changes surface without waiting for the coalesced poll tick.
   */
  setGitStatusRefresher?(refresh: (sessionId: string) => void): void
  /**
   * Inspect managed-worktree removal risk for the requesting session. Identity
   * is resolved server-side from the session's persisted checkout — the client
   * never supplies a worktree path or ID.
   */
  inspectManagedWorktreeRemoval(
    sessionId: string,
  ): Promise<import('@kata-sh/shared/protocol').WorktreeRemovalRisk>
  /**
   * Remove the managed worktree owned by the requesting session. Identity is
   * resolved server-side from persisted checkout ownership; blocked while
   * another session owns it. `force` governs uncommitted/unique work only.
   */
  removeManagedWorktree(
    sessionId: string,
    options?: { force?: boolean },
  ): Promise<import('@kata-sh/shared/protocol').WorktreeRemovalResult>
  setSessionSources(sessionId: string, sourceSlugs: string[]): Promise<void>
  setSessionLabels(sessionId: string, labels: string[]): void
  setSessionConnection(sessionId: string, connectionSlug: string): Promise<void>
  updateSessionModel(sessionId: string, workspaceId: string, model: string | null, connection?: string): Promise<void>

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------

  sendMessage(
    sessionId: string,
    message: string,
    attachments?: FileAttachment[],
    storedAttachments?: StoredAttachment[],
    options?: SendMessageOptions,
    existingMessageId?: string,
    _isAuthRetry?: boolean,
    onAck?: (messageId: string) => void,
    rpcContext?: { callerClientId?: string },
  ): Promise<void>
  cancelProcessing(sessionId: string, silent?: boolean): Promise<void>
  killShell(sessionId: string, shellId: string): Promise<{ success: boolean; error?: string }>
  getTaskOutput(taskId: string): Promise<string | null>
  addMessageAnnotation(sessionId: string, messageId: string, annotation: AnnotationV1): void
  removeMessageAnnotation(sessionId: string, messageId: string, annotationId: string): void
  updateMessageAnnotation(
    sessionId: string,
    messageId: string,
    annotationId: string,
    patch: Partial<AnnotationV1>,
  ): void

  // ---------------------------------------------------------------------------
  // Permissions & credentials
  // ---------------------------------------------------------------------------

  respondToPermission(
    sessionId: string,
    requestId: string,
    allowed: boolean,
    alwaysAllow: boolean,
    options?: PermissionResponseOptions,
  ): boolean
  respondToCredential(sessionId: string, requestId: string, response: CredentialResponse): Promise<boolean>
  getSessionPermissionModeState(sessionId: string): PermissionModeState | null

  // ---------------------------------------------------------------------------
  // Plans
  // ---------------------------------------------------------------------------

  setPendingPlanExecution(sessionId: string, planPath: string, draftInputSnapshot?: string): Promise<void>
  markPendingPlanExecutionDispatched(sessionId: string): Promise<void>
  clearPendingPlanExecution(sessionId: string): Promise<void>
  getPendingPlanExecution(sessionId: string): { planPath: string; draftInputSnapshot?: string; awaitingCompaction: boolean; executionDispatched: boolean } | null
  markCompactionComplete(sessionId: string): Promise<void>

  /**
   * Send the plan-approval "I approve this plan, please execute it" message
   * to the session as if the user had clicked "Accept plan" in the desktop UI.
   * If the session is in Explore (safe) mode, also switches it to allow-all
   * so the plan can actually run without per-tool prompts.
   *
   * Used by the messaging gateway so Telegram/WhatsApp accept buttons produce
   * the same server-side effect as the desktop accept button.
   */
  acceptPlan(sessionId: string, planPath?: string): Promise<void>

  // ---------------------------------------------------------------------------
  // Sharing
  // ---------------------------------------------------------------------------

  shareToViewer(sessionId: string): Promise<ShareResult>
  updateShare(sessionId: string): Promise<ShareResult>
  revokeShare(sessionId: string): Promise<ShareResult>

  // ---------------------------------------------------------------------------
  // Export / Import
  // ---------------------------------------------------------------------------

  /**
   * Export a session as a portable bundle.
   * Flushes pending writes, serializes session data + files.
   * Session must be stopped before export.
   */
  exportSession(sessionId: string, workspaceId: string): Promise<SessionBundle | null>

  /**
   * Export a session as a summary-based payload for cross-server transfer.
   * Generates a mini-model summary instead of shipping the full transcript.
   */
  exportRemoteSessionTransfer(
    sessionId: string,
    workspaceId: string,
  ): Promise<import('@kata-sh/shared/protocol').RemoteSessionTransferPayload | null>

  /**
   * Import a session bundle into a target workspace.
   * Creates session directory, writes JSONL + files, registers in memory.
   * Returns the new session ID and any compatibility warnings.
   */
  importSession(
    workspaceId: string,
    bundle: SessionBundle,
    mode: DispatchMode,
  ): Promise<{ sessionId: string; warnings?: string[] }>

  /**
   * Import a summary-based remote transfer payload into a target workspace.
   */
  importRemoteSessionTransfer(
    workspaceId: string,
    payload: import('@kata-sh/shared/protocol').RemoteSessionTransferPayload,
  ): Promise<import('@kata-sh/shared/protocol').ImportRemoteSessionTransferResult>

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  getSessionPath(sessionId: string): string | null
  refreshTitle(sessionId: string): Promise<{ success: boolean; title?: string; error?: string }>
  refreshBadge(): void
  getUnreadSummary(): UnreadSummary

  // ---------------------------------------------------------------------------
  // Workspace
  // ---------------------------------------------------------------------------

  getWorkspaces(): Workspace[]
  /** Return client-safe workspace list (no rootPath) for remote clients. */
  getWorkspacesInfo(): WorkspaceInfo[]
  setupConfigWatcher(workspaceRootPath: string, workspaceId: string): void
  /**
   * Manually notify the ConfigWatcher of a file change.
   * Workaround for Bun's fs.watch on Linux not detecting atomic renames.
   */
  notifyConfigFileChange(workspaceRootPath: string, relativePath: string): void

  // ---------------------------------------------------------------------------
  // Server-level observability
  // ---------------------------------------------------------------------------

  /** Count of sessions with active backend processes. Pass workspaceId to scope. */
  getActiveSessionCount(workspaceId?: string): number
  /** Automation summary for a workspace (count of configured automations + scheduler state). */
  getWorkspaceAutomationSummary(workspaceId: string): { automationCount: number; schedulerRunning: boolean }
  /** Active sessions across all workspaces (sessions with running backend processes). */
  getActiveSessionsInfo(): ActiveSessionInfo[]

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  reinitializeAuth(connectionSlug?: string): Promise<void>
  /**
   * Push runtime updates (e.g. capability toggles) to every active session
   * that uses the given connection. Backstopped by the lazy refresh path in
   * `getOrCreateAgent`.
   */
  refreshConnectionRuntime(connectionSlug: string): Promise<void>
  completeAuthRequest(sessionId: string, result: AuthResult): Promise<void>
  executePromptAutomation(input: ExecutePromptAutomationInput): Promise<{ sessionId: string }>

  /**
   * Install a callback invoked from `executePromptAutomation` after a session
   * is created when the matcher declared `telegramTopic`. Wired by the
   * messaging-gateway bootstrap so the SessionManager doesn't need to import
   * the messaging package (avoids a circular package-level import).
   *
   * The callback should be best-effort: failures must not block the session.
   */
  setAutomationBinder?(
    fn: (input: { workspaceId: string; sessionId: string; topicName: string }) => Promise<void>,
  ): void
}

/**
 * Input for executePromptAutomation. Options-object form replaces the
 * previous positional-args signature once the param list grew past
 * readability — new optional fields (thinkingLevel, future cwd/permissions
 * overrides) can be added without churn at every call site.
 */
export interface ExecutePromptAutomationInput {
  workspaceId: string
  workspaceRootPath: string
  prompt: string
  labels?: string[]
  permissionMode?: PermissionMode
  mentions?: string[]
  llmConnection?: string
  model?: string
  /** Override the workspace default thinking level for the spawned session. */
  thinkingLevel?: ThinkingLevel
  automationName?: string
  /**
   * Optional Telegram forum-topic name. When set and the workspace has a
   * paired supergroup, the new session is bound to a topic of this name
   * (created on first use). Silently ignored when prerequisites aren't met.
   */
  telegramTopic?: string
}
