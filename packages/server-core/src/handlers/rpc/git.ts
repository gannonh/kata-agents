/**
 * Git / GitHub V1 RPC handlers.
 *
 * The server that owns the workspace filesystem owns all Git behavior. Read-only
 * repository/ref discovery is always available; mutation handlers reject while
 * the `KATA_FEATURE_GIT_WORKSPACE_V1` flag is disabled so renderer/server state
 * cannot drift. Phase 2-4 channels are registered now (routing exhaustiveness)
 * and stub with a feature/not-implemented rejection until their slice lands.
 */

import { RPC_CHANNELS } from '@kata-sh/shared/protocol'
import type {
  CheckoutPrepareIntent,
  CreatePullRequestInput,
  GitCommitInput,
  GitFileDiff,
  GitStatusChangedEvent,
} from '@kata-sh/shared/protocol'
import { isGitWorkspaceV1Enabled } from '@kata-sh/shared/feature-flags'
import type { RpcServer } from '@kata-sh/server-core/transport'
import { pushTyped } from '../../transport/push'
import { getDefaultGitServices, GitStatusSubscription } from '../../git'
import type { HandlerDeps } from '../handler-deps'

export const GIT_HANDLED_CHANNELS = [
  RPC_CHANNELS.git.GET_CONTEXT,
  RPC_CHANNELS.git.LIST_REFS,
  RPC_CHANNELS.git.PREPARE_CHECKOUT,
  RPC_CHANNELS.git.INSPECT_WORKTREE_REMOVAL,
  RPC_CHANNELS.git.REMOVE_WORKTREE,
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
] as const

function assertFeatureEnabled(): void {
  if (!isGitWorkspaceV1Enabled()) {
    throw new Error('Git workspace feature is not enabled.')
  }
}

class NotImplementedError extends Error {
  constructor(channel: string) {
    super(`${channel} is not implemented in this build.`)
    this.name = 'NotImplementedError'
  }
}

/**
 * Resolve a session's active checkout directory + owning workspace from
 * persisted session state — never a client-supplied path (spec: ownership
 * boundary). Managed-worktree sessions resolve to the worktree checkout path;
 * others fall back to the session working directory.
 */
function makeSessionResolver(deps: HandlerDeps) {
  return (sessionId: string): { checkoutPath: string; workspaceId: string } | null => {
    const sessions = deps.sessionManager.getSessions()
    const session = sessions.find((s) => s.id === sessionId)
    if (!session) return null
    const checkoutPath = session.checkout?.checkoutPath ?? session.workingDirectory
    if (!checkoutPath) return null
    return { checkoutPath, workspaceId: session.workspaceId }
  }
}

export function registerGitHandlers(server: RpcServer, deps: HandlerDeps): void {
  const git = deps.gitServices ?? getDefaultGitServices()
  // Ensure the SessionManager's checkout gate operates on the same registry
  // instance as these handlers so ownership state never diverges.
  deps.sessionManager.setGitServices?.(git)

  const resolveSession = makeSessionResolver(deps)

  // Coalesced status subscription: one poll loop per checkout, workspace-routed
  // change events carrying the session ID. Injected getStatus/publish keep the
  // subscription transport-agnostic and testable.
  const statusSubscription = new GitStatusSubscription({
    getStatus: (dir) => git.repository.getStatus(dir),
    resolveSession,
    publish: (event: GitStatusChangedEvent, workspaceId: string) => {
      pushTyped(server, RPC_CHANNELS.git.STATUS_CHANGED, { to: 'workspace', workspaceId }, event)
    },
    pollIntervalMs: 3000,
  })
  // Expose the subscription so future app-issued mutations (Phase 3) and agent
  // turn completion can trigger an immediate refresh.
  deps.gitStatusSubscription = statusSubscription

  // Startup reconciliation: once the session manager has finished loading
  // sessions, compare the managed-worktree registry against persisted session
  // ownership and `git worktree list --porcelain`. Best-effort — a failure must
  // not block handler registration or server startup, and it never deletes.
  void (async () => {
    try {
      await deps.sessionManager.waitForInit?.()
      const sessions = deps.sessionManager.getSessions()
      const knownSessionIds = new Set(sessions.map((s) => s.id))
      const sessionCheckouts = new Map(
        sessions
          .filter((s) => s.checkout)
          .map((s) => [s.id, s.checkout!] as const),
      )
      await git.worktrees.reconcile({ knownSessionIds, sessionCheckouts })
    } catch {
      /* best-effort startup reconciliation */
    }
  })()

  // --- Repository context and ref listing (Phase 1, read-only) ---

  server.handle(RPC_CHANNELS.git.GET_CONTEXT, async (_ctx, dir: string) => {
    return git.repository.getContext(dir)
  })

  server.handle(RPC_CHANNELS.git.LIST_REFS, async (_ctx, dir: string) => {
    return git.repository.listRefs(dir)
  })

  // --- Empty-session checkout preparation (Phase 1, mutation) ---

  server.handle(
    RPC_CHANNELS.git.PREPARE_CHECKOUT,
    async (_ctx, sessionId: string, intent: CheckoutPrepareIntent) => {
      assertFeatureEnabled()
      return deps.sessionManager.prepareCheckout(sessionId, intent)
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

  server.handle(RPC_CHANNELS.git.COMMIT, async (_ctx, _input: GitCommitInput) => {
    assertFeatureEnabled()
    throw new NotImplementedError(RPC_CHANNELS.git.COMMIT)
  })

  server.handle(RPC_CHANNELS.git.PULL, async (_ctx, _sessionId: string) => {
    assertFeatureEnabled()
    throw new NotImplementedError(RPC_CHANNELS.git.PULL)
  })

  server.handle(RPC_CHANNELS.git.PUSH, async (_ctx, _sessionId: string) => {
    assertFeatureEnabled()
    throw new NotImplementedError(RPC_CHANNELS.git.PUSH)
  })

  // --- GitHub capability + pull requests (Phase 3) ---

  server.handle(RPC_CHANNELS.git.GITHUB_STATUS, async () => {
    throw new NotImplementedError(RPC_CHANNELS.git.GITHUB_STATUS)
  })

  server.handle(RPC_CHANNELS.git.FIND_PULL_REQUEST, async (_ctx, _sessionId: string) => {
    throw new NotImplementedError(RPC_CHANNELS.git.FIND_PULL_REQUEST)
  })

  server.handle(
    RPC_CHANNELS.git.CREATE_PULL_REQUEST,
    async (_ctx, _input: CreatePullRequestInput) => {
      assertFeatureEnabled()
      throw new NotImplementedError(RPC_CHANNELS.git.CREATE_PULL_REQUEST)
    },
  )
}
