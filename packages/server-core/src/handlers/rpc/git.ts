/**
 * Git / GitHub V1 RPC handlers.
 *
 * The server that owns the workspace filesystem owns all Git behavior. Read-only
 * repository/ref discovery is always available; mutation handlers reject while
 * the `KATA_FEATURE_GIT_WORKSPACE_V1` flag is disabled so renderer/server state
 * cannot drift. Phase 2-4 channels are registered now (routing exhaustiveness)
 * and stub with a feature/not-implemented rejection until their slice lands.
 */

import {
  CodedError,
  RPC_CHANNELS,
  WORKTREE_BRANCH_COLLISION_CODE,
  WORKTREE_BRANCH_OWNERSHIP_UNKNOWN_CODE,
  WORKTREE_DESTINATION_UNSAFE_CODE,
  WORKTREE_LIFECYCLE_ERROR_CODE,
  WORKTREE_HANDOFF_ERROR_CODE,
  WORKTREE_HANDOFF_PENDING_CODE,
  WORKTREE_NAME_INVALID_CODE,
  WORKTREE_OWNERS_PRESENT_CODE,
  WORKTREE_PREVIEW_STALE_CODE,
  WORKTREE_SETTINGS_ERROR_CODE,
  WORKTREE_STATE_UNMANAGEABLE_CODE,
  WORKTREE_FORK_ERROR_CODE,
  WORKTREE_FORK_PENDING_CODE,
  WorktreeV2CapabilityError,
} from '@kata-sh/shared/protocol'
import type {
  CheckoutPrepareIntentVersioned,
  CreatePullRequestInput,
  ErrorCode,
  GitActionResult,
  WorktreeSettingsUpdateInput,
  GitCommitInput,
  GitFileDiff,
  GitStatusChangedEvent,
  ManagedWorktreeRecordVersioned,
  RepositoryContext,
  SessionCheckout,
  WorktreeArchiveInput,
  WorktreeDeleteInput,
  WorktreePermanentDeleteInput,
  WorktreeRetryInput,
  WorktreeHandoffConfirmInput,
  WorktreeHandoffPreviewInput,
  WorktreeHandoffRecoverInput,
  WorktreeHandoffCancelInput,
  WorktreeHandoffStatusInput,
  ConversationForkPreviewInput,
  ConversationForkConfirmInput,
  ConversationForkStatusInput,
  ConversationForkRecoverInput,
  ConversationForkCancelInput,
} from '@kata-sh/shared/protocol'
import { isGitWorkspaceV1Enabled, isWorktreeV2Enabled } from '@kata-sh/shared/feature-flags'
import { i18n } from '@kata-sh/shared/i18n'
import type { RpcServer } from '@kata-sh/server-core/transport'
import { pushTyped } from '../../transport/push'
import {
  getDefaultGitServices,
  GitStatusSubscription,
  WorktreeCreationError,
  WorktreeLifecycleError,
  WorktreeSettingsError,
  WorktreeHandoffError,
  ConversationForkError,
} from '../../git'
import type { GitServices, SessionForkState } from '../../git'
import type { HandlerDeps } from '../handler-deps'

export const GIT_HANDLED_CHANNELS = [
  RPC_CHANNELS.git.GET_CONTEXT,
  RPC_CHANNELS.git.LIST_REFS,
  RPC_CHANNELS.git.LIST_MANAGED_WORKTREES,
  RPC_CHANNELS.git.PREPARE_CHECKOUT,
  RPC_CHANNELS.git.GET_CAPABILITIES,
  RPC_CHANNELS.git.GET_WORKTREE_SETTINGS,
  RPC_CHANNELS.git.UPDATE_WORKTREE_SETTINGS,
  RPC_CHANNELS.git.INSPECT_WORKTREE_REMOVAL,
  RPC_CHANNELS.git.REMOVE_WORKTREE,
  RPC_CHANNELS.git.WORKTREE_INVENTORY,
  RPC_CHANNELS.git.WORKTREE_PREVIEW,
  RPC_CHANNELS.git.WORKTREE_DELETE,
  RPC_CHANNELS.git.WORKTREE_RESTORE,
  RPC_CHANNELS.git.WORKTREE_RETRY,
  RPC_CHANNELS.git.WORKTREE_PERMANENT_DELETE,
  RPC_CHANNELS.git.WORKTREE_ARCHIVE,
  RPC_CHANNELS.git.WORKTREE_UNARCHIVE,
  RPC_CHANNELS.git.GET_STATUS,
  RPC_CHANNELS.git.GET_DIFF,
  RPC_CHANNELS.git.SUBSCRIBE_STATUS,
  RPC_CHANNELS.git.UNSUBSCRIBE_STATUS,
  RPC_CHANNELS.git.COMMIT,
  RPC_CHANNELS.git.PULL,
  RPC_CHANNELS.git.PUSH,
  RPC_CHANNELS.git.GITHUB_STATUS,
  RPC_CHANNELS.git.FIND_PULL_REQUEST,
  RPC_CHANNELS.git.CREATE_PULL_REQUEST,
  RPC_CHANNELS.git.HANDOFF_PREVIEW,
  RPC_CHANNELS.git.HANDOFF_CONFIRM,
  RPC_CHANNELS.git.HANDOFF_STATUS,
  RPC_CHANNELS.git.HANDOFF_RECOVER,
  RPC_CHANNELS.git.HANDOFF_CANCEL,
  RPC_CHANNELS.git.FORK_PREVIEW,
  RPC_CHANNELS.git.FORK_CONFIRM,
  RPC_CHANNELS.git.FORK_STATUS,
  RPC_CHANNELS.git.FORK_RECOVER,
  RPC_CHANNELS.git.FORK_CANCEL,
] as const

function assertFeatureEnabled(): void {
  if (!isGitWorkspaceV1Enabled()) {
    throw new Error('Git workspace feature is not enabled.')
  }
}

function assertWorktreeV2Enabled(): void {
  if (!isWorktreeV2Enabled()) {
    throw new WorktreeV2CapabilityError()
  }
}

function throwTypedWorktreeSettingsError(error: unknown): never {
  if (error instanceof WorktreeSettingsError) {
    throw new CodedError(WORKTREE_SETTINGS_ERROR_CODE, error.message)
  }
  throw error
}

const WORKTREE_CREATION_WIRE_CODES: Readonly<Record<string, ErrorCode>> = {
  WORKTREE_NAME_INVALID: WORKTREE_NAME_INVALID_CODE,
  WORKTREE_BRANCH_COLLISION: WORKTREE_BRANCH_COLLISION_CODE,
  WORKTREE_DESTINATION_UNSAFE: WORKTREE_DESTINATION_UNSAFE_CODE,
  WORKTREE_BRANCH_OWNERSHIP_UNKNOWN: WORKTREE_BRANCH_OWNERSHIP_UNKNOWN_CODE,
}

const WORKTREE_LIFECYCLE_WIRE_CODES: Readonly<Record<string, ErrorCode>> = {
  LIFECYCLE_PREVIEW_STALE: WORKTREE_PREVIEW_STALE_CODE,
  LIFECYCLE_STATE_UNMANAGEABLE: WORKTREE_STATE_UNMANAGEABLE_CODE,
  LIFECYCLE_OWNERS_PRESENT: WORKTREE_OWNERS_PRESENT_CODE,
}

function throwTypedWorktreeLifecycleError(error: unknown): never {
  if (error instanceof WorktreeLifecycleError) {
    const wireCode = WORKTREE_LIFECYCLE_WIRE_CODES[error.code]
    throw new CodedError(wireCode ?? WORKTREE_LIFECYCLE_ERROR_CODE, error.message)
  }
  throw error
}

function throwTypedWorktreeCreationError(error: unknown): never {
  if (error instanceof WorktreeCreationError) {
    const wireCode = WORKTREE_CREATION_WIRE_CODES[error.code]
    if (wireCode) throw new CodedError(wireCode, error.message)
  }
  throw error
}

function throwTypedWorktreeHandoffError(error: unknown): never {
  if (error instanceof WorktreeHandoffError) {
    throw new CodedError(WORKTREE_HANDOFF_ERROR_CODE, error.message)
  }
  throw error
}

function throwTypedConversationForkError(error: unknown): never {
  if (error instanceof ConversationForkError) {
    throw new CodedError(WORKTREE_FORK_ERROR_CODE, error.message)
  }
  throw error
}

/**
 * Fence Git work on a session whose managed-worktree record is not `ready`:
 * Send, agent creation, Git actions, and further lifecycle actions stay fenced
 * until reconciliation, restore, or an explicit allowed resolution succeeds
 * (spec: recovery fencing). Sessions without a managed checkout are unaffected.
 */
function assertSessionWorktreeUsable(git: GitServices, sessionId: string): void {
  if (!isWorktreeV2Enabled()) return
  if (git.handoff?.isSessionFenced?.(sessionId)) {
    throw new CodedError(WORKTREE_HANDOFF_PENDING_CODE, i18n.t('git.handoff.pendingFence'))
  }
  if (git.fork?.isSessionFenced?.(sessionId)) {
    throw new CodedError(WORKTREE_FORK_PENDING_CODE, i18n.t('git.fork.pendingFence'))
  }
  git.lifecycle.assertReady()
  const { state } = git.lifecycle.recordStateForSession(sessionId)
  if (state !== 'ready') {
    throw new Error(
      i18n.t('git.worktree.usableFence', {
        state,
      }),
    )
  }
}

interface ResolvedSession {
  checkoutPath: string
  workspaceId: string
  /** Managed worktree base ref (PR-delta base), when persisted. */
  baseRef: string | null
  /** Persisted checkout metadata (null for legacy sessions). */
  checkout: SessionCheckout | null
}

/**
 * Validate a managed worktree's live identity against its persisted checkout
 * before a mutation (spec: "Path and identity safety" — every mutation verifies
 * repository root, Git common directory, checkout path, and expected managed
 * branch). Returns a user-facing recoverable message on mismatch, else null.
 *
 * Current-checkout / legacy sessions are exempt: the spec explicitly says
 * Current checkout sessions do not assume the branch remains unchanged.
 */
export function checkManagedCheckoutIdentity(input: {
  checkout: SessionCheckout | null | undefined
  liveContext: Pick<RepositoryContext, 'repositoryRoot' | 'gitCommonDir' | 'currentBranch' | 'detached'>
  record: ManagedWorktreeRecordVersioned | null | undefined
}): string | null {
  const { checkout, liveContext, record } = input
  if (!checkout || checkout.mode !== 'managed-worktree') return null
  const problems: string[] = []
  // A linked worktree's own top-level (`git rev-parse --show-toplevel`) is its
  // checkout directory — NOT the source repository root — so the location
  // invariant is "the live top-level is still this worktree's checkout path".
  // The stable identity shared across the source repo and all its worktrees is
  // the Git common directory, verified below against the registry record.
  if (liveContext.repositoryRoot !== checkout.checkoutPath) problems.push('checkout path')
  if (record) {
    if (liveContext.gitCommonDir !== record.gitCommonDir) problems.push('git directory')
    if (record.checkoutPath !== checkout.checkoutPath) problems.push('registry checkout path')
  }
  if (checkout.expectedBranch) {
    const live = liveContext.detached ? null : liveContext.currentBranch
    if (live !== checkout.expectedBranch) {
      problems.push(
        `branch (expected "${checkout.expectedBranch}", found ${live ? `"${live}"` : 'a detached HEAD'})`,
      )
    }
  }
  if (problems.length === 0) return null
  return (
    `This session's managed worktree changed unexpectedly (${problems.join(', ')}). ` +
    'Kata will not run Git actions on a worktree that was switched, moved, or removed ' +
    `outside the app. Restore branch "${checkout.expectedBranch ?? ''}" at ${checkout.checkoutPath}, ` +
    'or delete the session to recover.'
  )
}

/**
 * Resolve a session's active checkout directory + owning workspace from
 * persisted session state — never a client-supplied path (spec: ownership
 * boundary). Managed-worktree sessions resolve to the worktree checkout path;
 * others fall back to the session working directory.
 */
function makeSessionResolver(deps: HandlerDeps) {
  return (sessionId: string): ResolvedSession | null => {
    const sessions = deps.sessionManager.getSessions()
    const session = sessions.find((s) => s.id === sessionId)
    if (!session) return null
    const checkoutPath = session.checkout?.checkoutPath ?? session.workingDirectory
    if (!checkoutPath) return null
    return {
      checkoutPath,
      workspaceId: session.workspaceId,
      baseRef: session.checkout?.baseRef ?? null,
      checkout: session.checkout ?? null,
    }
  }
}

/**
 * Resolve a session's live repository context and assert managed-worktree
 * identity before a mutation. Throws a visible recoverable error when the
 * checkout is not a Git repository or its managed identity drifted.
 */
async function resolveMutationContext(
  git: GitServices,
  resolved: ResolvedSession,
): Promise<RepositoryContext & { gitCommonDir: string }> {
  const ctx = await git.repository.getContext(resolved.checkoutPath)
  if (!ctx.isGitRepository || !ctx.gitCommonDir) {
    throw new Error('Selected checkout is not a Git repository.')
  }
  const identityError = checkManagedCheckoutIdentity({
    checkout: resolved.checkout,
    liveContext: ctx,
    record: resolved.checkout?.managedWorktreeId
      ? git.registry.get(resolved.checkout.managedWorktreeId) ?? null
      : null,
  })
  if (identityError) throw new Error(identityError)
  return ctx as RepositoryContext & { gitCommonDir: string }
}

/** Strip ref prefixes and a leading remote name to a plain branch name. */
function normalizeBaseRef(ref: string | null, primaryRemote: string | null): string | null {
  if (!ref) return null
  let b = ref
  if (b.startsWith('refs/heads/')) b = b.slice('refs/heads/'.length)
  else if (b.startsWith('refs/remotes/')) b = b.slice('refs/remotes/'.length)
  if (primaryRemote && b.startsWith(`${primaryRemote}/`)) b = b.slice(primaryRemote.length + 1)
  return b || null
}

export function registerGitHandlers(
  server: RpcServer,
  deps: HandlerDeps,
  owningServerId?: string,
): void {
  const git = deps.gitServices ?? getDefaultGitServices()
  const worktreeSettings = git.worktreeSettings
  const serverId = owningServerId ?? worktreeSettings?.getCapability().serverId ?? 'local'
  // Ensure the SessionManager's checkout gate operates on the same registry
  // instance as these handlers so ownership state never diverges.
  deps.sessionManager.setGitServices?.(git)

  const resolveSession = makeSessionResolver(deps)

  // Coalesced status subscription: one poll loop per checkout, workspace-routed
  // change events carrying the session ID. Injected getStatus/publish keep the
  // subscription transport-agnostic and testable.
  const statusSubscription = new GitStatusSubscription({
    getStatus: (dir, options) => git.repository.getStatus(dir, options),
    resolveSession,
    publish: (event: GitStatusChangedEvent, workspaceId: string) => {
      pushTyped(server, RPC_CHANNELS.git.STATUS_CHANGED, { to: 'workspace', workspaceId }, event)
    },
    pollIntervalMs: 3000,
  })
  // Expose the subscription so future app-issued mutations (Phase 3) and agent
  // turn completion can trigger an immediate refresh.
  deps.gitStatusSubscription = statusSubscription

  // Wire agent-turn completion to an immediate status refresh. SessionManager
  // invokes this when a turn stops; the subscription no-ops for checkouts no
  // surface is watching, and only publishes when the status actually changed.
  deps.sessionManager.setGitStatusRefresher?.((sessionId: string) => {
    void statusSubscription.refresh(sessionId, 'app-action')
  })

  // Startup reconciliation: once the session manager has finished loading
  // sessions, compare the managed-worktree registry against persisted session
  // ownership and `git worktree list --porcelain`, classify interrupted
  // lifecycle transactions from the journal, lease every live checkout path,
  // and only then mark lifecycle readiness. A failure must not block server
  // startup; the readiness gate keeps lifecycle RPCs fenced until this
  // completes (spec: awaited startup reconciliation).
  const startupReconciliation = (async () => {
    try {
      await deps.sessionManager.waitForInit?.()
      const sessions = deps.sessionManager.getSessions()
      const knownSessionIds = new Set(sessions.map((s) => s.id))
      const sessionCheckouts = new Map(
        sessions
          .filter((s) => s.checkout)
          .map((s) => [s.id, s.checkout!] as const),
      )
      // Every live session leases its checkout path — including sessions not
      // yet reflected in registry owners — so lifecycle decisions see the full
      // fence set from the first instant.
      const repositoryRootCache = new Map<string, string>()
      for (const session of sessions) {
        const checkoutPath = session.checkout?.checkoutPath ?? session.workingDirectory
        if (!checkoutPath) continue
        // Every live session fences its canonical checkout, including the
        // repository's registered current checkout. Resolve legacy nested
        // working directories to the repository root before leasing. A single
        // unreadable directory must not fence the whole subsystem; lease the
        // raw path as the fallback so reconciliation still sees the fence.
        try {
          let root = repositoryRootCache.get(checkoutPath)
          if (root === undefined) {
            const context = await git.repository.getContext(checkoutPath)
            root = context.repositoryRoot ?? checkoutPath
            repositoryRootCache.set(checkoutPath, root)
          }
          git.pathLeases.lease(session.id, root)
        } catch (error) {
          console.warn(`[worktree] could not resolve checkout for session ${session.id}; leasing the raw path.`, error)
          git.pathLeases.lease(session.id, checkoutPath)
        }
      }
      await git.worktrees.reconcile({ knownSessionIds, sessionCheckouts })
      const journalReport = await git.lifecycle.reconcileJournal()
      // Fork reconciliation: classify interrupted fork journal entries
      // (committed stay; pre-child in-progress stays resumable; child-created
      // without a live pending child becomes recovery-required) and backfill
      // the establish marker a crash between the child-session flush and
      // markEstablished may have lost. The session lookup comes from the
      // SessionManager (wired through the fork hooks by setGitServices above;
      // passed explicitly here so reconciliation never depends on hook-wiring
      // order).
      const forkReport = (await git.fork?.reconcileForkJournal?.({
        resolveSessionForkState: (sessionId: string) =>
          deps.sessionManager.resolveSessionForkState?.(sessionId) ?? null,
      })) ?? { resumed: 0, flagged: 0, recoveryRequired: 0 }
      // Orphan reconcile: retire ledger entries whose fork transaction later
      // established; surface stale unresolved entries (never auto-deleted —
      // the operator/UI decides). Never attaches an orphan to a session.
      const orphanReport = (await git.forkOrphans?.reconcile?.({
        isEstablished: (transactionId) =>
          git.journal.entries().some(
            (entry) =>
              entry.op === 'fork' &&
              entry.recordId === transactionId &&
              entry.status === 'committed' &&
              entry.metadata?.state === 'established',
          ),
      })) ?? { resolved: 0, retained: 0, expiredUnresolved: 0, expiredAttemptIds: [] }
      git.journal.compact()
      git.lifecycle.markReady()
      if (journalReport.resumed > 0 || journalReport.recovered > 0) {
        console.info(
          `[worktree] startup reconciliation resumed ${journalReport.resumed} and recovered ${journalReport.recovered} interrupted lifecycle transaction(s).`,
        )
      }
      if (forkReport.resumed > 0 || forkReport.flagged > 0 || forkReport.recoveryRequired > 0) {
        console.info(
          `[worktree] startup fork reconciliation backfilled ${forkReport.resumed}, flagged ${forkReport.flagged} new, and surfaced ${forkReport.recoveryRequired} recovery-required fork transaction(s).`,
        )
      }
      if (orphanReport.resolved > 0 || orphanReport.expiredUnresolved > 0) {
        console.info(
          `[worktree] startup orphan reconciliation resolved ${orphanReport.resolved} and surfaced ${orphanReport.expiredUnresolved} expired unresolved fork establishment attempt(s).`,
        )
      }
    } catch (error) {
      console.error('[worktree] startup reconciliation failed; lifecycle work stays fenced.', error)
    }
  })()

  // --- Worktree V2 capability and server-owned settings ---

  server.handle(RPC_CHANNELS.git.GET_CAPABILITIES, async () => {
    if (!worktreeSettings) {
      return { serverId, worktreeV2: false }
    }
    return worktreeSettings.getCapability(serverId)
  })

  server.handle(RPC_CHANNELS.git.GET_WORKTREE_SETTINGS, async () => {
    assertWorktreeV2Enabled()
    if (!worktreeSettings) throw new WorktreeV2CapabilityError()
    try {
      return worktreeSettings.getSnapshot(serverId)
    } catch (error) {
      throwTypedWorktreeSettingsError(error)
    }
  })

  server.handle(
    RPC_CHANNELS.git.UPDATE_WORKTREE_SETTINGS,
    async (_ctx, input: WorktreeSettingsUpdateInput) => {
      assertWorktreeV2Enabled()
      if (!worktreeSettings) throw new WorktreeV2CapabilityError()
      try {
        const next = worktreeSettings.update(input, serverId)
        // A policy change fences new cleanup candidates at the new version.
        if (input.autoDeleteEnabled !== undefined || input.retentionLimit !== undefined) {
          void git.lifecycle.enqueueCleanup()
        }
        return next
      } catch (error) {
        throwTypedWorktreeSettingsError(error)
      }
    },
  )

  // --- Phase 2: snapshot-backed lifecycle management ---

  // Inventory, preview, delete, restore, retry, permanent-delete, and
  // archive/unarchive RPCs. Identity is server-issued (opaque record IDs);
  // traversal strings, client paths, and foreign server IDs carry no deletion
  // or extraction authority (spec: opaque IDs + server-issued fingerprints).

  server.handle(RPC_CHANNELS.git.WORKTREE_INVENTORY, async () => {
    assertWorktreeV2Enabled()
    git.lifecycle.assertReady()
    return git.lifecycle.inventory()
  })

  server.handle(RPC_CHANNELS.git.WORKTREE_PREVIEW, async (_ctx, managedWorktreeId: string) => {
    assertWorktreeV2Enabled()
    git.lifecycle.assertReady()
    if (typeof managedWorktreeId !== 'string' || !managedWorktreeId) {
      throw new CodedError(WORKTREE_LIFECYCLE_ERROR_CODE, i18n.t('git.worktree.idRequired'))
    }
    try {
      return await git.lifecycle.preview(managedWorktreeId)
    } catch (error) {
      throwTypedWorktreeLifecycleError(error)
    }
  })

  server.handle(RPC_CHANNELS.git.WORKTREE_DELETE, async (_ctx, input: WorktreeDeleteInput) => {
    assertWorktreeV2Enabled()
    try {
      return await git.lifecycle.deleteWorktree(input.managedWorktreeId, input.previewFingerprint)
    } catch (error) {
      throwTypedWorktreeLifecycleError(error)
    }
  })

  server.handle(RPC_CHANNELS.git.WORKTREE_RESTORE, async (_ctx, managedWorktreeId: string) => {
    assertWorktreeV2Enabled()
    try {
      return await git.lifecycle.restoreWorktree(managedWorktreeId)
    } catch (error) {
      throwTypedWorktreeLifecycleError(error)
    }
  })

  server.handle(RPC_CHANNELS.git.WORKTREE_RETRY, async (_ctx, input: WorktreeRetryInput) => {
    assertWorktreeV2Enabled()
    try {
      return await git.lifecycle.retryWorktree(input.managedWorktreeId)
    } catch (error) {
      throwTypedWorktreeLifecycleError(error)
    }
  })

  server.handle(
    RPC_CHANNELS.git.WORKTREE_PERMANENT_DELETE,
    async (_ctx, input: WorktreePermanentDeleteInput) => {
      assertWorktreeV2Enabled()
      try {
        return await git.lifecycle.permanentDelete(input.managedWorktreeId, input.confirmIrreversible)
      } catch (error) {
        throwTypedWorktreeLifecycleError(error)
      }
    },
  )

  server.handle(RPC_CHANNELS.git.WORKTREE_ARCHIVE, async (_ctx, input: WorktreeArchiveInput) => {
    assertWorktreeV2Enabled()
    try {
      return await git.lifecycle.setArchived(input.managedWorktreeId, input.sessionId, true)
    } catch (error) {
      throwTypedWorktreeLifecycleError(error)
    }
  })

  server.handle(RPC_CHANNELS.git.WORKTREE_UNARCHIVE, async (_ctx, input: WorktreeArchiveInput) => {
    assertWorktreeV2Enabled()
    try {
      return await git.lifecycle.setArchived(input.managedWorktreeId, input.sessionId, false)
    } catch (error) {
      throwTypedWorktreeLifecycleError(error)
    }
  })

  // --- Conflict-safe checkout handoff (Phase 3) ---

  server.handle(
    RPC_CHANNELS.git.HANDOFF_PREVIEW,
    async (_ctx, input: WorktreeHandoffPreviewInput) => {
      assertWorktreeV2Enabled()
      try {
        return await git.handoff.preview(input)
      } catch (error) {
        throwTypedWorktreeHandoffError(error)
      }
    },
  )

  server.handle(
    RPC_CHANNELS.git.HANDOFF_CONFIRM,
    async (_ctx, input: WorktreeHandoffConfirmInput) => {
      assertWorktreeV2Enabled()
      try {
        return await git.handoff.confirm(input)
      } catch (error) {
        throwTypedWorktreeHandoffError(error)
      }
    },
  )

  server.handle(
    RPC_CHANNELS.git.HANDOFF_STATUS,
    async (_ctx, input: WorktreeHandoffStatusInput) => {
      assertWorktreeV2Enabled()
      try {
        return await git.handoff.status(input.sessionId)
      } catch (error) {
        throwTypedWorktreeHandoffError(error)
      }
    },
  )

  server.handle(
    RPC_CHANNELS.git.HANDOFF_RECOVER,
    async (_ctx, input: WorktreeHandoffRecoverInput) => {
      assertWorktreeV2Enabled()
      try {
        return await git.handoff.recover(input)
      } catch (error) {
        throwTypedWorktreeHandoffError(error)
      }
    },
  )

  server.handle(
    RPC_CHANNELS.git.HANDOFF_CANCEL,
    async (_ctx, input: WorktreeHandoffCancelInput) => {
      assertWorktreeV2Enabled()
      try {
        return await git.handoff.cancel(input)
      } catch (error) {
        throwTypedWorktreeHandoffError(error)
      }
    },
  )

  // --- Isolated conversation forks (Phase 4) ---

  // The fork surface is server-authoritative: previews return typed blockers
  // as normal results (never throw), confirms/status/recover/cancel map typed
  // fork errors to the WORKTREE_FORK_FAILED code, and every handler requires
  // Worktree V2 effective.

  server.handle(
    RPC_CHANNELS.git.FORK_PREVIEW,
    async (_ctx, input: ConversationForkPreviewInput) => {
      assertWorktreeV2Enabled()
      try {
        return await git.fork.preview(input)
      } catch (error) {
        throwTypedConversationForkError(error)
      }
    },
  )

  server.handle(
    RPC_CHANNELS.git.FORK_CONFIRM,
    async (_ctx, input: ConversationForkConfirmInput) => {
      assertWorktreeV2Enabled()
      try {
        return await git.fork.confirm(input)
      } catch (error) {
        throwTypedConversationForkError(error)
      }
    },
  )

  server.handle(
    RPC_CHANNELS.git.FORK_STATUS,
    async (_ctx, input: ConversationForkStatusInput) => {
      assertWorktreeV2Enabled()
      try {
        return await git.fork.status(input)
      } catch (error) {
        throwTypedConversationForkError(error)
      }
    },
  )

  server.handle(
    RPC_CHANNELS.git.FORK_RECOVER,
    async (_ctx, input: ConversationForkRecoverInput) => {
      assertWorktreeV2Enabled()
      try {
        return await git.fork.recover(input)
      } catch (error) {
        throwTypedConversationForkError(error)
      }
    },
  )

  server.handle(
    RPC_CHANNELS.git.FORK_CANCEL,
    async (_ctx, input: ConversationForkCancelInput) => {
      assertWorktreeV2Enabled()
      try {
        return await git.fork.cancel(input)
      } catch (error) {
        throwTypedConversationForkError(error)
      }
    },
  )

  // --- Repository context and ref listing (Phase 1, read-only) ---

  server.handle(RPC_CHANNELS.git.GET_CONTEXT, async (_ctx, dir: string) => {
    return git.repository.getContext(dir)
  })

  server.handle(RPC_CHANNELS.git.LIST_REFS, async (_ctx, dir: string) => {
    return git.repository.listRefs(dir)
  })

  // --- Existing managed-worktree discovery (read-only) ---

  // Lists ready worktrees of the session's workspace + repository that a new
  // session may bind to. Identity is resolved server-side from the working
  // directory; the client never supplies a worktree path or ID.
  server.handle(
    RPC_CHANNELS.git.LIST_MANAGED_WORKTREES,
    async (_ctx, sessionId: string, workingDirectory: string) => {
      return deps.sessionManager.listManagedWorktrees(sessionId, workingDirectory)
    },
  )

  // --- Empty-session checkout preparation (Phase 1, mutation) ---

  server.handle(
    RPC_CHANNELS.git.PREPARE_CHECKOUT,
    async (_ctx, sessionId: string, intent: CheckoutPrepareIntentVersioned) => {
      // V2 is explicit on the wire. An unversioned object carrying a V2-only
      // field is rejected rather than silently falling back to V1 identity.
      if (intent.schemaVersion === 2) {
        assertWorktreeV2Enabled()
      } else if ('worktreeNameSuffix' in intent) {
        throw new WorktreeV2CapabilityError()
      }
      assertFeatureEnabled()
      try {
        return await deps.sessionManager.prepareCheckout(sessionId, intent)
      } catch (error) {
        throwTypedWorktreeCreationError(error)
      }
    },
  )

  // --- Managed-worktree risk inspection (read-only) and removal (mutation) ---

  // Identity is resolved server-side from the requesting session's persisted
  // checkout and registry ownership — the client never supplies a worktree
  // path or ID (spec: ownership boundary / path and identity safety).
  server.handle(
    RPC_CHANNELS.git.INSPECT_WORKTREE_REMOVAL,
    async (_ctx, sessionId: string) => {
      return deps.sessionManager.inspectManagedWorktreeRemoval(sessionId)
    },
  )

  server.handle(
    RPC_CHANNELS.git.REMOVE_WORKTREE,
    async (_ctx, sessionId: string, force?: boolean) => {
      assertFeatureEnabled()
      return deps.sessionManager.removeManagedWorktree(sessionId, { force })
    },
  )

  // --- Checkout status + bounded diff (Phase 2) ---

  server.handle(RPC_CHANNELS.git.GET_STATUS, async (_ctx, dir: string) => {
    // Read-only status is available; full Changes-panel wiring lands in Phase 2.
    return git.repository.getStatus(dir)
  })

  // Bounded diff by session ID + repository-relative path. Identity is resolved
  // server-side; the path is validated against the current status snapshot
  // before any file is read (spec: Changes panel data flow, path safety).
  server.handle(RPC_CHANNELS.git.GET_DIFF, async (_ctx, sessionId: string, path: string) => {
    assertSessionWorktreeUsable(git, sessionId)
    const resolved = resolveSession(sessionId)
    if (!resolved) throw new Error('Session checkout could not be resolved.')
    const status = await git.repository.getStatus(resolved.checkoutPath)
    if (!status.isGitRepository) {
      throw new Error('Selected checkout is not a Git repository.')
    }
    // Status paths from Git porcelain are always repository-root relative. For a
    // legacy/unprepared session whose checkout is a nested subdirectory, the
    // diff must be resolved against the repository root — not the nested
    // working directory — or HEAD blobs and working-tree files won't be found.
    const diffRoot = status.repositoryRoot ?? resolved.checkoutPath
    const entry = status.entries.find((e) => e.path === path || e.previousPath === path)
    if (!entry) {
      // Path is no longer part of the uncommitted changes (e.g. reverted).
      return {
        path,
        changeType: 'unknown',
        state: 'clean',
        fingerprint: 'clean',
        additions: 0,
        deletions: 0,
        oldContent: '',
        newContent: '',
      } satisfies GitFileDiff
    }
    return git.repository.getFileDiff(diffRoot, {
      path: entry.path,
      previousPath: entry.previousPath,
      type: entry.type,
    })
  })

  server.handle(RPC_CHANNELS.git.SUBSCRIBE_STATUS, async (ctx, sessionId: string) => {
    return statusSubscription.subscribe(ctx.clientId, sessionId)
  })

  server.handle(RPC_CHANNELS.git.UNSUBSCRIBE_STATUS, async (ctx, sessionId?: string) => {
    if (sessionId) {
      statusSubscription.unsubscribe(ctx.clientId, sessionId)
    } else {
      statusSubscription.unsubscribeClient(ctx.clientId)
    }
  })

  // --- Commit / pull / push (Phase 3, mutation) ---

  // Mutations resolve identity server-side, serialize by Git common directory
  // (so linked worktrees never race on shared metadata), and refresh status
  // afterwards so the header control and Changes panel reflect the result.
  async function runMutation(
    sessionId: string,
    op: (dir: string) => Promise<GitActionResult>,
  ): Promise<GitActionResult> {
    assertFeatureEnabled()
    const initialResolved = resolveSession(sessionId)
    if (!initialResolved) throw new Error('Session checkout could not be resolved.')
    const initialContext = await resolveMutationContext(git, initialResolved)
    try {
      return await git.mutationLock.withLock(initialContext.gitCommonDir, async () => {
        // Re-resolve identity and fences after acquiring the common-directory
        // lock. A mutation that was queued behind a handoff must never act on
        // the pre-handoff checkout path.
        assertSessionWorktreeUsable(git, sessionId)
        const resolved = resolveSession(sessionId)
        if (!resolved) throw new Error('Session checkout could not be resolved.')
        const ctx = await resolveMutationContext(git, resolved)
        // The lock key is the repository identity captured before the lock.
        // If the session's repository drifted while the action was queued,
        // the mutation would run against one repository while holding
        // another repository's serialization lock. This mirrors the guard
        // ManagedWorktreeService.removeWorktree applies.
        if (ctx.gitCommonDir !== initialContext.gitCommonDir) {
          throw new Error('Session repository identity changed while the Git action was queued. Try the action again.')
        }
        return op(ctx.repositoryRoot ?? resolved.checkoutPath)
      })
    } finally {
      await statusSubscription.refresh(sessionId, 'app-action')
    }
  }

  server.handle(RPC_CHANNELS.git.COMMIT, async (_ctx, input: GitCommitInput) => {
    return runMutation(input.sessionId, (dir) =>
      git.actions.commit({ dir, message: input.message, paths: input.paths }),
    )
  })

  server.handle(RPC_CHANNELS.git.PULL, async (_ctx, sessionId: string) => {
    return runMutation(sessionId, (dir) => git.actions.pull(dir))
  })

  server.handle(RPC_CHANNELS.git.PUSH, async (_ctx, sessionId: string) => {
    return runMutation(sessionId, (dir) => git.actions.push(dir))
  })

  // --- GitHub capability + pull requests (Phase 3) ---

  // Capability + PR lookup are read-only; PR lookup never throws so it cannot
  // block commit/push (spec: AC15).
  server.handle(RPC_CHANNELS.git.GITHUB_STATUS, async (_ctx, sessionId: string) => {
    const resolved = resolveSession(sessionId)
    if (!resolved) throw new Error('Session checkout could not be resolved.')
    return git.github.getCapability(resolved.checkoutPath)
  })

  server.handle(RPC_CHANNELS.git.FIND_PULL_REQUEST, async (_ctx, sessionId: string) => {
    const resolved = resolveSession(sessionId)
    if (!resolved) return null
    return git.github.findPullRequest(resolved.checkoutPath)
  })

  server.handle(
    RPC_CHANNELS.git.CREATE_PULL_REQUEST,
    async (_ctx, input: CreatePullRequestInput) => {
      assertFeatureEnabled()
      return createPullRequest(git, statusSubscription, resolveSession, input)
    },
  )
}

/**
 * Create a pull request as an ordered, partial-success sequence: verify GitHub
 * capability, push first when the branch has no upstream / unpushed commits,
 * resolve the base ref (managed worktree base else default), then `gh pr
 * create`. Completed stages are never rolled back (spec: AC16).
 */
async function createPullRequest(
  git: GitServices,
  statusSubscription: GitStatusSubscription,
  resolveSession: (sessionId: string) => ResolvedSession | null,
  input: CreatePullRequestInput,
): Promise<GitActionResult> {
  const resolved = resolveSession(input.sessionId)
  if (!resolved) throw new Error('Session checkout could not be resolved.')
  const ctx = await resolveMutationContext(git, resolved)
  const dir = ctx.repositoryRoot ?? resolved.checkoutPath
  const result: GitActionResult = { stages: [] }

  try {
    await git.mutationLock.withLock(ctx.gitCommonDir, async () => {
      const cap = await git.github.getCapability(dir)
      if (!cap.installed || !cap.authenticated) {
        result.stages.push({
          stage: 'create-pr',
          status: 'failed',
          error: cap.detail ?? 'GitHub CLI is not installed or authenticated.',
        })
        return
      }

      // Push first when there is no upstream or unpushed commits.
      const status = await git.repository.getStatus(dir, { baseRef: resolved.baseRef })
      if (status.upstream == null || status.ahead > 0 || status.publishableCommitCount > 0) {
        const pushRes = await git.actions.push(dir)
        result.stages.push(...pushRes.stages)
        if (pushRes.stages.some((s) => s.status === 'failed')) return
      }

      // PR base authority (spec: AC15): a managed worktree with a persisted
      // base ref is authoritative — the client baseRef is ignored so a stale or
      // spoofed renderer cannot retarget the PR. Current-checkout / legacy
      // sessions may pass a base ref, else the detected default ref is used.
      const isManagedWithBase =
        resolved.checkout?.mode === 'managed-worktree' && !!resolved.baseRef
      const chosenBase = isManagedWithBase
        ? resolved.baseRef
        : input.baseRef ?? status.defaultRef
      const base = normalizeBaseRef(chosenBase, ctx.primaryRemote)
      if (!base) {
        result.stages.push({
          stage: 'create-pr',
          status: 'failed',
          error: 'Could not resolve a base branch for the pull request.',
        })
        return
      }

      try {
        const pr = await git.github.createPullRequest({
          dir,
          title: input.title,
          body: input.body,
          baseRef: base,
        })
        result.stages.push({ stage: 'create-pr', status: 'succeeded', detail: pr.url })
        result.pullRequestUrl = pr.url
      } catch (err) {
        result.stages.push({
          stage: 'create-pr',
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })
  } finally {
    await statusSubscription.refresh(input.sessionId, 'app-action')
  }
  return result
}
