/**
 * Git / GitHub V1 RPC handlers.
 *
 * The server that owns the workspace filesystem owns all Git behavior. Read-only
 * repository/ref discovery is always available; mutation handlers reject while
 * the `KATA_FEATURE_GIT_WORKSPACE_V1` flag is disabled so renderer/server state
 * cannot drift. Phase 2-4 channels are registered now (routing exhaustiveness)
 * and stub with a feature/not-implemented rejection until their slice lands.
 */

import { RPC_CHANNELS, WorktreeV2CapabilityError } from '@kata-sh/shared/protocol'
import type {
  CheckoutPrepareIntentVersioned,
  CreatePullRequestInput,
  GitActionResult,
  GitCommitInput,
  GitFileDiff,
  GitStatusChangedEvent,
  ManagedWorktreeRecord,
  RepositoryContext,
  SessionCheckout,
} from '@kata-sh/shared/protocol'
import { isGitWorkspaceV1Enabled } from '@kata-sh/shared/feature-flags'
import type { RpcServer } from '@kata-sh/server-core/transport'
import { pushTyped } from '../../transport/push'
import { getDefaultGitServices, GitStatusSubscription } from '../../git'
import type { GitServices } from '../../git'
import type { HandlerDeps } from '../handler-deps'

export const GIT_HANDLED_CHANNELS = [
  RPC_CHANNELS.git.GET_CONTEXT,
  RPC_CHANNELS.git.LIST_REFS,
  RPC_CHANNELS.git.LIST_MANAGED_WORKTREES,
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
  record: ManagedWorktreeRecord | null | undefined
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
      // The current SessionManager is intentionally V1-only. Keep V2-looking
      // input out of it until named creation and settings are implemented; a
      // direct V2 RPC must fail with the typed wire error rather than silently
      // falling back to generated V1 identity.
      if ('worktreeNameSuffix' in intent) {
        throw new WorktreeV2CapabilityError(
          'Git worktree V2 named creation is not available on this server.',
        )
      }
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

  // Mutations resolve identity server-side, serialize by Git common directory
  // (so linked worktrees never race on shared metadata), and refresh status
  // afterwards so the header control and Changes panel reflect the result.
  async function runMutation(
    sessionId: string,
    op: (dir: string) => Promise<GitActionResult>,
  ): Promise<GitActionResult> {
    assertFeatureEnabled()
    const resolved = resolveSession(sessionId)
    if (!resolved) throw new Error('Session checkout could not be resolved.')
    const ctx = await resolveMutationContext(git, resolved)
    try {
      return await git.mutationLock.withLock(ctx.gitCommonDir, () =>
        op(ctx.repositoryRoot ?? resolved.checkoutPath),
      )
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
