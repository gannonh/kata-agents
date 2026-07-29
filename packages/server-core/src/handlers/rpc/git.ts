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
} from '@kata-sh/shared/protocol'
import { isGitWorkspaceV1Enabled } from '@kata-sh/shared/feature-flags'
import type { RpcServer } from '@kata-sh/server-core/transport'
import { getDefaultGitServices } from '../../git'
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

export function registerGitHandlers(server: RpcServer, deps: HandlerDeps): void {
  const git = deps.gitServices ?? getDefaultGitServices()
  // Ensure the SessionManager's checkout gate operates on the same registry
  // instance as these handlers so ownership state never diverges.
  deps.sessionManager.setGitServices?.(git)

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

  server.handle(
    RPC_CHANNELS.git.INSPECT_WORKTREE_REMOVAL,
    async (_ctx, managedWorktreeId: string, sessionId: string) => {
      return git.worktrees.inspectRemoval(managedWorktreeId, sessionId)
    },
  )

  server.handle(
    RPC_CHANNELS.git.REMOVE_WORKTREE,
    async (_ctx, managedWorktreeId: string, sessionId: string, force?: boolean) => {
      assertFeatureEnabled()
      return git.worktrees.removeWorktree(managedWorktreeId, sessionId, { force })
    },
  )

  // --- Checkout status + bounded diff (Phase 2) ---

  server.handle(RPC_CHANNELS.git.GET_STATUS, async (_ctx, dir: string) => {
    // Read-only status is available; full Changes-panel wiring lands in Phase 2.
    return git.repository.getStatus(dir)
  })

  server.handle(RPC_CHANNELS.git.GET_DIFF, async () => {
    throw new NotImplementedError(RPC_CHANNELS.git.GET_DIFF)
  })

  server.handle(RPC_CHANNELS.git.SUBSCRIBE_STATUS, async () => {
    throw new NotImplementedError(RPC_CHANNELS.git.SUBSCRIBE_STATUS)
  })

  server.handle(RPC_CHANNELS.git.UNSUBSCRIBE_STATUS, async () => {
    throw new NotImplementedError(RPC_CHANNELS.git.UNSUBSCRIBE_STATUS)
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
