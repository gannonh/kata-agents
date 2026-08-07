import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  RPC_CHANNELS,
  WORKTREE_BRANCH_COLLISION_CODE,
  WORKTREE_LIFECYCLE_ERROR_CODE,
  WORKTREE_OWNERS_PRESENT_CODE,
  WORKTREE_PREVIEW_STALE_CODE,
  WORKTREE_SETTINGS_ERROR_CODE,
  WORKTREE_STATE_UNMANAGEABLE_CODE,
  WORKTREE_V2_CAPABILITY_ERROR_CODE,
} from '@kata-sh/shared/protocol'
import type {
  GitActionResult,
  GitHubCapabilityStatus,
  ManagedWorktreeRecord,
  PullRequestSummary,
  RepositoryContext,
  SessionCheckoutV1,
} from '@kata-sh/shared/protocol'
import type { HandlerFn, RequestContext, RpcServer } from '@kata-sh/server-core/transport'
import { WorktreeCreationError, WorktreeSettingsError } from '../../git'
import type { GitServices } from '../../git'
import type { HandlerDeps } from '../handler-deps'
import { registerGitHandlers, checkManagedCheckoutIdentity } from './git'

const FLAG = 'KATA_FEATURE_GIT_WORKSPACE_V1'
const V2_FLAG = 'KATA_FEATURE_WORKTREE_V2'
const ORIGINAL = process.env[FLAG]
const ORIGINAL_V2 = process.env[V2_FLAG]

interface MockOverrides {
  getContext?: Partial<RepositoryContext>
  listRefs?: unknown
  status?: {
    repositoryRoot?: string | null
    entries?: Array<{ path: string; previousPath?: string; type: string }>
    upstream?: string | null
    ahead?: number
    publishableCommitCount?: number
    defaultRef?: string | null
  }
  capability?: GitHubCapabilityStatus
  pullRequest?: PullRequestSummary | null
  registryRecord?: ManagedWorktreeRecord | null
  createdPr?: PullRequestSummary
}

interface MockGit {
  git: GitServices
  calls: string[]
  createPrArgs: Array<{ baseRef: string }>
}

function makeGitServices(overrides?: MockOverrides): MockGit {
  const calls: string[] = []
  const createPrArgs: Array<{ baseRef: string }> = []
  const defaultContext: RepositoryContext = {
    isGitRepository: false,
    repositoryRoot: null,
    gitCommonDir: null,
    currentBranch: null,
    detached: false,
    headSha: null,
    defaultRef: null,
    remotes: [],
    primaryRemote: null,
    provider: 'unknown',
  }
  const git = {
    repository: {
      getContext: async (dir: string) => {
        calls.push(`getContext:${dir}`)
        return { ...defaultContext, ...(overrides?.getContext ?? {}) }
      },
      listRefs: async (dir: string) => {
        calls.push(`listRefs:${dir}`)
        return overrides?.listRefs ?? { refs: [], currentBranch: null, defaultRef: null }
      },
      getStatus: async (dir: string) => {
        calls.push(`getStatus:${dir}`)
        return {
          isGitRepository: true,
          checkoutPath: dir,
          repositoryRoot: overrides?.status?.repositoryRoot ?? dir,
          entries: overrides?.status?.entries ?? [],
          upstream: overrides?.status?.upstream ?? null,
          ahead: overrides?.status?.ahead ?? 0,
          publishableCommitCount: overrides?.status?.publishableCommitCount ?? 0,
          defaultRef: overrides?.status?.defaultRef ?? 'main',
        }
      },
      getFileDiff: async (dir: string, req: { path: string }) => {
        calls.push(`getFileDiff:${dir}:${req.path}`)
        return { path: req.path, changeType: 'modified', state: 'text', fingerprint: 'fp' }
      },
    },
    registry: {
      get: (id: string) => {
        calls.push(`registry.get:${id}`)
        return overrides?.registryRecord ?? undefined
      },
    },
    mutationLock: {
      withLock: async (_dir: string, fn: () => Promise<unknown>) => fn(),
    },
    actions: {
      commit: async (params: { dir: string }) => {
        calls.push(`actions.commit:${params.dir}`)
        return { stages: [{ stage: 'commit', status: 'succeeded' }], commitSha: 'abc123' } as GitActionResult
      },
      pull: async (dir: string) => {
        calls.push(`actions.pull:${dir}`)
        return { stages: [{ stage: 'pull', status: 'succeeded' }] } as GitActionResult
      },
      push: async (dir: string) => {
        calls.push(`actions.push:${dir}`)
        return { stages: [{ stage: 'push', status: 'succeeded' }] } as GitActionResult
      },
    },
    github: {
      getCapability: async (dir: string): Promise<GitHubCapabilityStatus> => {
        calls.push(`github.getCapability:${dir}`)
        return (
          overrides?.capability ?? { installed: true, authenticated: true, host: 'github.com' }
        )
      },
      findPullRequest: async (dir: string) => {
        calls.push(`github.findPullRequest:${dir}`)
        return overrides?.pullRequest ?? null
      },
      createPullRequest: async (params: { baseRef: string }) => {
        calls.push(`github.createPullRequest:${params.baseRef}`)
        createPrArgs.push({ baseRef: params.baseRef })
        return (
          overrides?.createdPr ?? {
            number: 7,
            url: 'https://github.com/o/r/pull/7',
            title: 't',
            state: 'open',
            baseRef: params.baseRef,
            headRef: 'kata-agent/abcd1234',
          }
        )
      },
    },
    worktrees: {
      reconcile: async () => ({ repaired: 0, removed: 0 }),
    },
    pathLeases: {
      lease: () => undefined,
      pruneStale: () => 0,
    },
    lifecycle: {
      assertReady: () => undefined,
      markReady: () => undefined,
      isReady: () => true,
      recordStateForSession: (sessionId: string) => ({ managedWorktreeId: null, state: 'ready' }),
      isSessionRecordReady: () => true,
      inventory: () => ({
        serverId: 'mock-server',
        policy: { autoDeleteEnabled: true, retentionLimit: 15, policyVersion: 0 },
        counts: { total: 0, materialized: 0, missing: 0, cleanupFailed: 0, snapshotted: 0, restoreFailed: 0, unowned: 0 },
        rows: [],
      }),
      preview: async () => ({
        managedWorktreeId: 'wt-1',
        exists: true,
        state: 'ready',
        owners: [],
        uncommittedFileCount: 0,
        unpushedCommitCount: 0,
        branchHasUniqueWork: false,
        previewFingerprint: 'fp',
        hasSnapshot: false,
        ignoredPolicy: { includeOnly: true, includeFileCount: 0 },
        blocked: false,
      }),
      deleteWorktree: async () => ({ deleted: true, state: 'snapshotted', snapshotId: 'snap-1' }),
      restoreWorktree: async () => ({ restored: true, state: 'ready', checkoutPath: '/wt' }),
      retryWorktree: async () => ({ retried: true, state: 'ready' }),
      permanentDelete: async () => ({ deleted: true }),
      setArchived: async () => ({ archived: true, state: 'ready', cleanupEnqueued: false }),
      enqueueCleanup: async () => ({ at: 1, outcome: 'skipped', policyVersion: 0 }),
      reconcileJournal: async () => ({ resumed: 0, recovered: 0 }),
    },
    journal: {
      compact: () => undefined,
    },
    handoff: {
      preview: async (input: { sessionId: string; direction: string; worktreeNameSuffix?: string }) => {
        calls.push(`handoff.preview:${input.sessionId}:${input.direction}`)
        return { transactionId: 'txn-1', previewFingerprint: 'fp-handoff', direction: input.direction }
      },
      confirm: async (input: { sessionId: string; transactionId: string }) => {
        calls.push(`handoff.confirm:${input.sessionId}:${input.transactionId}`)
        return { outcome: 'committed', transactionId: input.transactionId }
      },
      status: async (sessionId: string) => {
        calls.push(`handoff.status:${sessionId}`)
        return { active: false }
      },
      recover: async (input: { sessionId: string; transactionId: string }) => {
        calls.push(`handoff.recover:${input.sessionId}:${input.transactionId}`)
        return { outcome: 'blocked', transactionId: input.transactionId, code: 'identity-drift', reason: 'stale' }
      },
    },
    worktreeSettings: {
      getCapability: (serverId = 'mock-server') => ({ serverId, worktreeV2: true }),
      getSnapshot: (serverId = 'mock-server') => ({
        schemaVersion: 1,
        serverId,
        version: 0,
        materializationRoot: '/worktrees',
        capturedAt: 1,
        autoDeleteEnabled: true,
        retentionLimit: 15,
      }),
      update: (input: { materializationRoot: string }, serverId = 'mock-server') => ({
        schemaVersion: 1,
        serverId,
        version: 1,
        materializationRoot: input.materializationRoot,
        capturedAt: 2,
        autoDeleteEnabled: true,
        retentionLimit: 15,
      }),
    },
  } as unknown as GitServices
  return { git, calls, createPrArgs }
}

interface SessionShape {
  id: string
  workspaceId: string
  workingDirectory: string
  checkout?: SessionCheckoutV1 | null
}

function makeHarness(
  gitServices: GitServices,
  sessions: SessionShape[] = [{ id: 's1', workspaceId: 'ws1', workingDirectory: '/repo' }],
  overrides?: {
    prepareCheckout?: (sessionId: string, intent: unknown) => Promise<unknown>
  },
) {
  const handlers = new Map<string, HandlerFn>()
  const prepareCalls: Array<[string, unknown]> = []
  const listWorktreeCalls: Array<[string, string]> = []
  const removeCalls: Array<[string, boolean | undefined]> = []
  const inspectCalls: string[] = []
  let setGitServicesArg: GitServices | null = null
  let gitStatusRefresher: ((sessionId: string) => void) | null = null

  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    push() {},
    async invokeClient() {
      return undefined
    },
    hasClientCapability() {
      return false
    },
    findClientsWithCapability() {
      return []
    },
  }

  const deps: HandlerDeps = {
    sessionManager: {
      getSessions() {
        return sessions
      },
      setGitServices(services: GitServices) {
        setGitServicesArg = services
      },
      setGitStatusRefresher(refresh: (sessionId: string) => void) {
        gitStatusRefresher = refresh
      },
      async prepareCheckout(sessionId: string, intent: unknown) {
        if (overrides?.prepareCheckout) return overrides.prepareCheckout(sessionId, intent)
        prepareCalls.push([sessionId, intent])
        return { checkout: {}, workingDirectory: '/wt', sdkCwd: '/wt' }
      },
      async listManagedWorktrees(sessionId: string, workingDirectory: string) {
        listWorktreeCalls.push([sessionId, workingDirectory])
        return [
          {
            managedWorktreeId: 'mw1',
            checkoutPath: '/wt/abcd1234',
            expectedBranch: 'kata-agent/abcd1234',
            baseRef: 'main',
            ownerCount: 2,
            state: 'ready',
          },
        ]
      },
      async inspectManagedWorktreeRemoval(sessionId: string) {
        inspectCalls.push(sessionId)
        return { managedWorktreeId: 'resolved', exists: true }
      },
      async removeManagedWorktree(sessionId: string, options?: { force?: boolean }) {
        removeCalls.push([sessionId, options?.force])
        return { removed: true, branchPruned: true, blocked: false }
      },
    } as unknown as HandlerDeps['sessionManager'],
    oauthFlowStore: {} as HandlerDeps['oauthFlowStore'],
    platform: {} as HandlerDeps['platform'],
    gitServices,
  }

  registerGitHandlers(server, deps)

  const ctx: RequestContext = { clientId: 'c1', workspaceId: 'ws1', webContentsId: 1 }
  return {
    handlers,
    ctx,
    prepareCalls,
    listWorktreeCalls,
    removeCalls,
    inspectCalls,
    getSetGitServicesArg: () => setGitServicesArg,
    getGitStatusRefresher: () => gitStatusRefresher,
  }
}

function managedCheckout(overrides?: Partial<SessionCheckoutV1>): SessionCheckoutV1 {
  return {
    schemaVersion: 1,
    mode: 'managed-worktree',
    repositoryRoot: '/repo',
    checkoutPath: '/wt/abcd1234',
    branchAtPreparation: 'main',
    baseRef: 'main',
    managedWorktreeId: 'mw1',
    expectedBranch: 'kata-agent/abcd1234',
    ...overrides,
  }
}

function managedRecord(overrides?: Partial<ManagedWorktreeRecord>): ManagedWorktreeRecord {
  return {
    managedWorktreeId: 'mw1',
    repositoryRoot: '/repo',
    gitCommonDir: '/repo/.git',
    checkoutPath: '/wt/abcd1234',
    baseRef: 'main',
    expectedBranch: 'kata-agent/abcd1234',
    createdAt: 0,
    ownerSessionIds: ['s1'],
    state: 'ready',
    ...overrides,
  }
}

describe('checkManagedCheckoutIdentity', () => {
  // A linked worktree's live top-level (`--show-toplevel`) is its checkout path,
  // while its Git common directory points back at the source repo's `.git`.
  const liveOk = {
    repositoryRoot: '/wt/abcd1234',
    gitCommonDir: '/repo/.git',
    currentBranch: 'kata-agent/abcd1234',
    detached: false,
  }

  it('passes when the managed worktree identity matches', () => {
    expect(
      checkManagedCheckoutIdentity({
        checkout: managedCheckout(),
        liveContext: liveOk,
        record: managedRecord(),
      }),
    ).toBeNull()
  })

  it('exempts current-checkout sessions from branch validation', () => {
    const current: SessionCheckoutV1 = {
      ...managedCheckout(),
      mode: 'current',
      managedWorktreeId: null,
      expectedBranch: null,
      baseRef: null,
    }
    expect(
      checkManagedCheckoutIdentity({
        checkout: current,
        liveContext: { ...liveOk, currentBranch: 'anything' },
        record: null,
      }),
    ).toBeNull()
  })

  it('blocks when the managed branch was switched externally', () => {
    const msg = checkManagedCheckoutIdentity({
      checkout: managedCheckout(),
      liveContext: { ...liveOk, currentBranch: 'some-other-branch' },
      record: managedRecord(),
    })
    expect(msg).toMatch(/branch/i)
    expect(msg).toMatch(/kata-agent\/abcd1234/)
  })

  it('blocks on a detached HEAD in a managed worktree', () => {
    const msg = checkManagedCheckoutIdentity({
      checkout: managedCheckout(),
      liveContext: { ...liveOk, currentBranch: null, detached: true },
      record: managedRecord(),
    })
    expect(msg).toMatch(/detached/i)
  })

  it('blocks when the worktree top-level (checkout path) or git dir drifted', () => {
    // The live top-level no longer matches the worktree's checkout path — the
    // worktree was moved or the session is resolving a different directory.
    expect(
      checkManagedCheckoutIdentity({
        checkout: managedCheckout(),
        liveContext: { ...liveOk, repositoryRoot: '/elsewhere' },
        record: managedRecord(),
      }),
    ).toMatch(/checkout path/i)
    expect(
      checkManagedCheckoutIdentity({
        checkout: managedCheckout(),
        liveContext: { ...liveOk, gitCommonDir: '/elsewhere/.git' },
        record: managedRecord(),
      }),
    ).toMatch(/git directory/i)
  })
})

describe('registerGitHandlers', () => {
  beforeEach(() => {
    process.env[FLAG] = '0'
  })
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env[FLAG]
    else process.env[FLAG] = ORIGINAL
    if (ORIGINAL_V2 === undefined) delete process.env[V2_FLAG]
    else process.env[V2_FLAG] = ORIGINAL_V2
  })

  it('injects the shared git services into the session manager', () => {
    const { git } = makeGitServices()
    const { getSetGitServicesArg } = makeHarness(git)
    expect(getSetGitServicesArg()).toBe(git)
  })

  it('serves capability and server-owned worktree settings when V2 is effective', async () => {
    process.env[FLAG] = '1'
    process.env.KATA_FEATURE_WORKTREE_V2 = '1'
    const { git } = makeGitServices()
    const harness = makeHarness(git)

    await expect(harness.handlers.get(RPC_CHANNELS.git.GET_CAPABILITIES)!(harness.ctx)).resolves.toEqual({
      serverId: 'mock-server',
      worktreeV2: true,
    })
    await expect(harness.handlers.get(RPC_CHANNELS.git.GET_WORKTREE_SETTINGS)!(harness.ctx)).resolves.toMatchObject({
      serverId: 'mock-server',
      materializationRoot: '/worktrees',
    })
    await expect(
      harness.handlers.get(RPC_CHANNELS.git.UPDATE_WORKTREE_SETTINGS)!(
        harness.ctx,
        { materializationRoot: '/custom-worktrees' },
      ),
    ).resolves.toMatchObject({ materializationRoot: '/custom-worktrees', version: 1 })
  })

  it('routes handoff preview, confirm, status, and recovery through shared contracts', async () => {
    process.env[FLAG] = '1'
    process.env[V2_FLAG] = '1'
    const { git, calls } = makeGitServices()
    const harness = makeHarness(git)
    const ctx = harness.ctx

    await expect(
      harness.handlers.get(RPC_CHANNELS.git.HANDOFF_PREVIEW)!(ctx, {
        sessionId: 's1',
        direction: 'current-to-managed',
        worktreeNameSuffix: 'demo',
      }),
    ).resolves.toMatchObject({ transactionId: 'txn-1', previewFingerprint: 'fp-handoff' })
    await expect(
      harness.handlers.get(RPC_CHANNELS.git.HANDOFF_CONFIRM)!(ctx, {
        sessionId: 's1',
        direction: 'current-to-managed',
        transactionId: 'txn-1',
        previewFingerprint: 'fp-handoff',
      }),
    ).resolves.toMatchObject({ outcome: 'committed', transactionId: 'txn-1' })
    await expect(
      harness.handlers.get(RPC_CHANNELS.git.HANDOFF_STATUS)!(ctx, { sessionId: 's1' }),
    ).resolves.toEqual({ active: false })
    await expect(
      harness.handlers.get(RPC_CHANNELS.git.HANDOFF_RECOVER)!(ctx, {
        sessionId: 's1',
        transactionId: 'txn-1',
      }),
    ).resolves.toMatchObject({ outcome: 'blocked', code: 'identity-drift' })
    expect(calls.filter((call) => call.startsWith('handoff.'))).toEqual([
      'handoff.preview:s1:current-to-managed',
      'handoff.confirm:s1:txn-1',
      'handoff.status:s1',
      'handoff.recover:s1:txn-1',
    ])
  })

  it('serves inventory, preview, delete, restore, retry, permanent-delete, archive, and unarchive RPCs', async () => {
    process.env[FLAG] = '1'
    process.env.KATA_FEATURE_WORKTREE_V2 = '1'
    const { git } = makeGitServices()
    const harness = makeHarness(git)
    const ctx = harness.ctx

    await expect(harness.handlers.get(RPC_CHANNELS.git.WORKTREE_INVENTORY)!(ctx)).resolves.toMatchObject({
      serverId: 'mock-server',
    })
    await expect(harness.handlers.get(RPC_CHANNELS.git.WORKTREE_PREVIEW)!(ctx, 'wt-1')).resolves.toMatchObject({
      managedWorktreeId: 'wt-1',
      previewFingerprint: 'fp',
    })
    await expect(
      harness.handlers.get(RPC_CHANNELS.git.WORKTREE_DELETE)!(ctx, {
        managedWorktreeId: 'wt-1',
        previewFingerprint: 'fp',
      }),
    ).resolves.toMatchObject({ deleted: true, state: 'snapshotted' })
    await expect(harness.handlers.get(RPC_CHANNELS.git.WORKTREE_RESTORE)!(ctx, 'wt-1')).resolves.toMatchObject({
      restored: true,
    })
    await expect(
      harness.handlers.get(RPC_CHANNELS.git.WORKTREE_RETRY)!(ctx, { managedWorktreeId: 'wt-1' }),
    ).resolves.toMatchObject({ retried: true })
    await expect(
      harness.handlers.get(RPC_CHANNELS.git.WORKTREE_PERMANENT_DELETE)!(ctx, {
        managedWorktreeId: 'wt-1',
        confirmIrreversible: true,
      }),
    ).resolves.toMatchObject({ deleted: true })
    await expect(
      harness.handlers.get(RPC_CHANNELS.git.WORKTREE_ARCHIVE)!(ctx, {
        managedWorktreeId: 'wt-1',
        sessionId: 's1',
        archived: true,
      }),
    ).resolves.toMatchObject({ archived: true })
    await expect(
      harness.handlers.get(RPC_CHANNELS.git.WORKTREE_UNARCHIVE)!(ctx, {
        managedWorktreeId: 'wt-1',
        sessionId: 's1',
        archived: false,
      }),
    ).resolves.toMatchObject({ archived: true })
  })

  it('maps lifecycle failures to typed wire errors', async () => {
    process.env[FLAG] = '1'
    process.env.KATA_FEATURE_WORKTREE_V2 = '1'
    const { git } = makeGitServices()
    const { WorktreeLifecycleError } = await import('../../git')
    ;(git.lifecycle as any).deleteWorktree = async () => {
      throw new WorktreeLifecycleError('LIFECYCLE_PREVIEW_STALE', 'stale')
    }
    const harness = makeHarness(git)

    await expect(
      harness.handlers.get(RPC_CHANNELS.git.WORKTREE_DELETE)!(harness.ctx, {
        managedWorktreeId: 'wt-1',
        previewFingerprint: 'old',
      }),
    ).rejects.toMatchObject({ code: WORKTREE_PREVIEW_STALE_CODE })
    ;(git.lifecycle as any).permanentDelete = async () => {
      throw new WorktreeLifecycleError('LIFECYCLE_OWNERS_PRESENT', 'owners')
    }
    await expect(
      harness.handlers.get(RPC_CHANNELS.git.WORKTREE_PERMANENT_DELETE)!(harness.ctx, {
        managedWorktreeId: 'wt-1',
        confirmIrreversible: true,
      }),
    ).rejects.toMatchObject({ code: WORKTREE_OWNERS_PRESENT_CODE })
    ;(git.lifecycle as any).restoreWorktree = async () => {
      throw new WorktreeLifecycleError('LIFECYCLE_STATE_UNMANAGEABLE', 'state')
    }
    await expect(
      harness.handlers.get(RPC_CHANNELS.git.WORKTREE_RESTORE)!(harness.ctx, 'wt-1'),
    ).rejects.toMatchObject({ code: WORKTREE_STATE_UNMANAGEABLE_CODE })
  })

  it('rejects lifecycle RPCs while V2 is disabled and without a worktree id', async () => {
    process.env[FLAG] = '1'
    process.env.KATA_FEATURE_WORKTREE_V2 = '0'
    const { git } = makeGitServices()
    const harness = makeHarness(git)

    await expect(harness.handlers.get(RPC_CHANNELS.git.WORKTREE_INVENTORY)!(harness.ctx)).rejects.toMatchObject({
      code: WORKTREE_V2_CAPABILITY_ERROR_CODE,
    })
    process.env.KATA_FEATURE_WORKTREE_V2 = '1'
    await expect(
      harness.handlers.get(RPC_CHANNELS.git.WORKTREE_PREVIEW)!(harness.ctx, ''),
    ).rejects.toMatchObject({ code: WORKTREE_LIFECYCLE_ERROR_CODE })
  })

  it('maps settings validation failures to the typed settings wire error', async () => {
    process.env[FLAG] = '1'
    process.env.KATA_FEATURE_WORKTREE_V2 = '1'
    const { git } = makeGitServices()
    ;(git.worktreeSettings as any).update = () => {
      throw new WorktreeSettingsError(
        'WORKTREE_SETTINGS_PROTECTED_PATH',
        'protected root',
        '/settings.json',
      )
    }
    const harness = makeHarness(git)

    await expect(
      harness.handlers.get(RPC_CHANNELS.git.UPDATE_WORKTREE_SETTINGS)!(
        harness.ctx,
        { materializationRoot: '/custom-worktrees' },
      ),
    ).rejects.toMatchObject({ code: WORKTREE_SETTINGS_ERROR_CODE })
  })

  it('rejects direct V2 settings RPCs with the typed capability error while disabled', async () => {
    process.env[FLAG] = '1'
    process.env.KATA_FEATURE_WORKTREE_V2 = '0'
    const { git } = makeGitServices()
    const harness = makeHarness(git)

    await expect(
      harness.handlers.get(RPC_CHANNELS.git.GET_WORKTREE_SETTINGS)!(harness.ctx),
    ).rejects.toMatchObject({ code: WORKTREE_V2_CAPABILITY_ERROR_CODE })
    await expect(
      harness.handlers.get(RPC_CHANNELS.git.UPDATE_WORKTREE_SETTINGS)!(
        harness.ctx,
        { materializationRoot: '/custom-worktrees' },
      ),
    ).rejects.toMatchObject({ code: WORKTREE_V2_CAPABILITY_ERROR_CODE })
  })

  it('serves read-only context and refs regardless of the feature flag', async () => {
    const { git, calls } = makeGitServices()
    const { handlers, ctx } = makeHarness(git)

    await handlers.get(RPC_CHANNELS.git.GET_CONTEXT)!(ctx, '/repo')
    await handlers.get(RPC_CHANNELS.git.LIST_REFS)!(ctx, '/repo')

    expect(calls).toContain('getContext:/repo')
    expect(calls).toContain('listRefs:/repo')
  })

  it('rejects prepareCheckout while the feature flag is disabled', async () => {
    const { git } = makeGitServices()
    const { handlers, ctx, prepareCalls } = makeHarness(git)

    await expect(
      handlers.get(RPC_CHANNELS.git.PREPARE_CHECKOUT)!(ctx, 's1', {
        mode: 'managed-worktree',
        workingDirectory: '/repo',
        baseRef: 'main',
      }),
    ).rejects.toThrow(/not enabled/)
    expect(prepareCalls).toHaveLength(0)
  })

  it('delegates prepareCheckout to the session manager when the flag is enabled', async () => {
    process.env[FLAG] = 'true'
    const { git } = makeGitServices()
    const { handlers, ctx, prepareCalls } = makeHarness(git)

    const intent = { mode: 'managed-worktree', workingDirectory: '/repo', baseRef: 'main' }
    await handlers.get(RPC_CHANNELS.git.PREPARE_CHECKOUT)!(ctx, 's1', intent)

    expect(prepareCalls).toEqual([['s1', intent]])
  })

  it('delegates an explicitly versioned V2 named intent when the capability is effective', async () => {
    process.env[FLAG] = 'true'
    process.env[V2_FLAG] = 'true'
    const { git } = makeGitServices()
    const { handlers, ctx, prepareCalls } = makeHarness(git)

    const intent = {
      schemaVersion: 2,
      mode: 'managed-worktree',
      workingDirectory: '/repo',
      baseRef: 'main',
      worktreeNameSuffix: 'auth-refresh',
    }
    await handlers.get(RPC_CHANNELS.git.PREPARE_CHECKOUT)!(ctx, 's1', intent)
    expect(prepareCalls).toEqual([['s1', intent]])
  })

  it('rejects V2 named intent before it reaches the V1 SessionManager when incapable', async () => {
    process.env[FLAG] = 'true'
    process.env[V2_FLAG] = '0'
    const { git } = makeGitServices()
    const { handlers, ctx, prepareCalls } = makeHarness(git)

    await expect(
      handlers.get(RPC_CHANNELS.git.PREPARE_CHECKOUT)!(ctx, 's1', {
        schemaVersion: 2,
        mode: 'managed-worktree',
        workingDirectory: '/repo',
        baseRef: 'main',
        worktreeNameSuffix: 'auth-refresh',
      }),
    ).rejects.toMatchObject({ code: WORKTREE_V2_CAPABILITY_ERROR_CODE })
    expect(prepareCalls).toHaveLength(0)
  })

  it('rejects an unversioned V2-looking intent before it reaches the V1 SessionManager', async () => {
    process.env[FLAG] = 'true'
    process.env[V2_FLAG] = '1'
    const { git } = makeGitServices()
    const { handlers, ctx, prepareCalls } = makeHarness(git)

    await expect(
      handlers.get(RPC_CHANNELS.git.PREPARE_CHECKOUT)!(ctx, 's1', {
        mode: 'managed-worktree',
        workingDirectory: '/repo',
        baseRef: 'main',
        worktreeNameSuffix: 'auth-refresh',
      }),
    ).rejects.toMatchObject({ code: WORKTREE_V2_CAPABILITY_ERROR_CODE })
    expect(prepareCalls).toHaveLength(0)
  })

  it('transports named-worktree creation failures with their registered wire codes', async () => {
    process.env[FLAG] = 'true'
    process.env[V2_FLAG] = '1'
    const { git } = makeGitServices()
    const { handlers, ctx } = makeHarness(git, undefined, {
      prepareCheckout: async () => {
        throw new WorktreeCreationError('already in use', 'WORKTREE_BRANCH_COLLISION')
      },
    })

    await expect(
      handlers.get(RPC_CHANNELS.git.PREPARE_CHECKOUT)!(ctx, 's1', {
        schemaVersion: 2,
        mode: 'managed-worktree',
        workingDirectory: '/repo',
        baseRef: 'main',
        worktreeNameSuffix: 'auth-refresh',
      }),
    ).rejects.toMatchObject({ code: WORKTREE_BRANCH_COLLISION_CODE })
  })

  it('serves existing-worktree discovery read-only regardless of the feature flag', async () => {
    const { git } = makeGitServices()
    const { handlers, ctx, listWorktreeCalls } = makeHarness(git)

    const result = await handlers.get(RPC_CHANNELS.git.LIST_MANAGED_WORKTREES)!(
      ctx,
      's1',
      '/repo',
    )

    // Identity is resolved server-side from the session + working directory;
    // the client never supplies a worktree path or ID.
    expect(listWorktreeCalls).toEqual([['s1', '/repo']])
    expect(result).toEqual([
      expect.objectContaining({ managedWorktreeId: 'mw1', ownerCount: 2, state: 'ready' }),
    ])
  })

  it('resolves worktree removal from the session (never a client path) and gates it on the flag', async () => {
    const { git } = makeGitServices()
    const { handlers, ctx, inspectCalls, removeCalls } = makeHarness(git)

    await handlers.get(RPC_CHANNELS.git.INSPECT_WORKTREE_REMOVAL)!(ctx, 's1')
    expect(inspectCalls).toEqual(['s1'])

    await expect(handlers.get(RPC_CHANNELS.git.REMOVE_WORKTREE)!(ctx, 's1')).rejects.toThrow(
      /not enabled/,
    )
    expect(removeCalls).toHaveLength(0)

    process.env[FLAG] = 'true'
    await handlers.get(RPC_CHANNELS.git.REMOVE_WORKTREE)!(ctx, 's1', true)
    expect(removeCalls).toEqual([['s1', true]])
  })

  it('rejects commit / pull / push while the feature flag is disabled', async () => {
    const { git, calls } = makeGitServices({ getContext: { isGitRepository: true, gitCommonDir: '/repo/.git', repositoryRoot: '/repo' } })
    const { handlers, ctx } = makeHarness(git)

    await expect(
      handlers.get(RPC_CHANNELS.git.COMMIT)!(ctx, { sessionId: 's1', message: 'x' }),
    ).rejects.toThrow(/not enabled/)
    await expect(handlers.get(RPC_CHANNELS.git.PULL)!(ctx, 's1')).rejects.toThrow(/not enabled/)
    await expect(handlers.get(RPC_CHANNELS.git.PUSH)!(ctx, 's1')).rejects.toThrow(/not enabled/)
    expect(calls.some((c) => c.startsWith('actions.'))).toBe(false)
  })

  it('runs a real commit for a valid current-checkout session and refreshes status', async () => {
    process.env[FLAG] = 'true'
    const { git, calls } = makeGitServices({
      getContext: { isGitRepository: true, gitCommonDir: '/repo/.git', repositoryRoot: '/repo' },
    })
    const { handlers, ctx } = makeHarness(git)

    const res = (await handlers.get(RPC_CHANNELS.git.COMMIT)!(ctx, {
      sessionId: 's1',
      message: 'do it',
    })) as GitActionResult
    expect(res.commitSha).toBe('abc123')
    expect(calls).toContain('actions.commit:/repo')
  })

  it('blocks a mutation when a managed worktree branch was switched externally', async () => {
    process.env[FLAG] = 'true'
    // Live branch differs from the persisted expectedBranch.
    const { git, calls } = makeGitServices({
      getContext: {
        isGitRepository: true,
        gitCommonDir: '/repo/.git',
        // The worktree top-level still matches; only the branch drifted.
        repositoryRoot: '/wt/abcd1234',
        currentBranch: 'someone-elses-branch',
      },
      registryRecord: managedRecord(),
    })
    const { handlers, ctx } = makeHarness(git, [
      { id: 's1', workspaceId: 'ws1', workingDirectory: '/wt/abcd1234', checkout: managedCheckout() },
    ])

    await expect(
      handlers.get(RPC_CHANNELS.git.PUSH)!(ctx, 's1'),
    ).rejects.toThrow(/changed unexpectedly|switched/i)
    // The mutation never reached the action service.
    expect(calls.some((c) => c.startsWith('actions.'))).toBe(false)
  })

  it('allows a mutation when the managed worktree identity matches', async () => {
    process.env[FLAG] = 'true'
    const { git, calls } = makeGitServices({
      getContext: {
        isGitRepository: true,
        gitCommonDir: '/repo/.git',
        repositoryRoot: '/wt/abcd1234',
        currentBranch: 'kata-agent/abcd1234',
      },
      registryRecord: managedRecord(),
    })
    const { handlers, ctx } = makeHarness(git, [
      { id: 's1', workspaceId: 'ws1', workingDirectory: '/wt/abcd1234', checkout: managedCheckout() },
    ])

    const res = (await handlers.get(RPC_CHANNELS.git.PUSH)!(ctx, 's1')) as GitActionResult
    expect(res.stages[0]!.status).toBe('succeeded')
    // The action runs in the worktree top-level (its checkout path).
    expect(calls).toContain('actions.push:/wt/abcd1234')
  })

  it('serves GitHub capability status read-only (no flag required)', async () => {
    const { git } = makeGitServices({
      getContext: { isGitRepository: true, gitCommonDir: '/repo/.git', repositoryRoot: '/repo' },
      capability: { installed: false, authenticated: false, host: null, detail: 'gh is not installed.' },
    })
    const { handlers, ctx } = makeHarness(git)

    const cap = (await handlers.get(RPC_CHANNELS.git.GITHUB_STATUS)!(ctx, 's1')) as GitHubCapabilityStatus
    expect(cap.installed).toBe(false)
    expect(cap.detail).toMatch(/not installed/)
  })

  it('uses the managed worktree persisted base ref for a PR and ignores a client override', async () => {
    process.env[FLAG] = 'true'
    const { git, createPrArgs } = makeGitServices({
      getContext: {
        isGitRepository: true,
        gitCommonDir: '/repo/.git',
        repositoryRoot: '/wt/abcd1234',
        currentBranch: 'kata-agent/abcd1234',
        primaryRemote: 'origin',
      },
      status: { upstream: 'origin/kata-agent/abcd1234', ahead: 0, defaultRef: 'main' },
      registryRecord: managedRecord({ baseRef: 'release-1.0' }),
    })
    const { handlers, ctx } = makeHarness(git, [
      {
        id: 's1',
        workspaceId: 'ws1',
        workingDirectory: '/wt/abcd1234',
        checkout: managedCheckout({ baseRef: 'release-1.0' }),
      },
    ])

    // Client tries to override the base with `main`; server must ignore it.
    await handlers.get(RPC_CHANNELS.git.CREATE_PULL_REQUEST)!(ctx, {
      sessionId: 's1',
      title: 'My PR',
      baseRef: 'main',
    })
    expect(createPrArgs).toHaveLength(1)
    expect(createPrArgs[0]!.baseRef).toBe('release-1.0')
  })

  it('serves a bounded diff resolved from the session checkout', async () => {
    const { git, calls } = makeGitServices()
    const { handlers, ctx } = makeHarness(git)

    const diff = await handlers.get(RPC_CHANNELS.git.GET_DIFF)!(ctx, 's1', 'src/a.ts')
    expect(calls).toContain('getStatus:/repo')
    expect(diff.state).toBe('clean')
    expect(diff.path).toBe('src/a.ts')
  })

  it('resolves diffs against the repository root for a nested legacy checkout', async () => {
    const { git, calls } = makeGitServices({
      status: {
        repositoryRoot: '/repo',
        entries: [{ path: 'src/a.ts', type: 'modified' }],
      },
    })
    const { handlers, ctx } = makeHarness(git, [
      { id: 's1', workspaceId: 'ws1', workingDirectory: '/repo/apps/nested' },
    ])

    const diff = await handlers.get(RPC_CHANNELS.git.GET_DIFF)!(ctx, 's1', 'src/a.ts')
    expect(calls).toContain('getStatus:/repo/apps/nested')
    expect(calls).toContain('getFileDiff:/repo:src/a.ts')
    expect(diff.state).toBe('text')
  })

  it('installs an agent-turn refresher that re-polls a subscribed checkout', async () => {
    const { git, calls } = makeGitServices()
    const { handlers, ctx, getGitStatusRefresher } = makeHarness(git)

    const refresh = getGitStatusRefresher()
    expect(typeof refresh).toBe('function')

    await handlers.get(RPC_CHANNELS.git.SUBSCRIBE_STATUS)!(ctx, 's1')
    const before = calls.filter((c) => c === 'getStatus:/repo').length
    refresh!('s1')
    await new Promise((r) => setTimeout(r, 0))
    const after = calls.filter((c) => c === 'getStatus:/repo').length
    expect(after).toBeGreaterThan(before)
  })

  it('subscribes and unsubscribes status by session (client-scoped)', async () => {
    const { git } = makeGitServices()
    const { handlers, ctx } = makeHarness(git)

    const snapshot = await handlers.get(RPC_CHANNELS.git.SUBSCRIBE_STATUS)!(ctx, 's1')
    expect(snapshot.checkoutPath).toBe('/repo')
    await handlers.get(RPC_CHANNELS.git.UNSUBSCRIBE_STATUS)!(ctx, 's1')
  })
})
