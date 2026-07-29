import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@kata-sh/shared/protocol'
import type { HandlerFn, RequestContext, RpcServer } from '@kata-sh/server-core/transport'
import type { GitServices } from '../../git'
import type { HandlerDeps } from '../handler-deps'
import { registerGitHandlers } from './git'

const FLAG = 'KATA_FEATURE_GIT_WORKSPACE_V1'
const ORIGINAL = process.env[FLAG]

function makeGitServices(overrides?: Partial<{
  getContext: unknown
  listRefs: unknown
}>): { git: GitServices; calls: string[] } {
  const calls: string[] = []
  const git = {
    repository: {
      getContext: async (dir: string) => {
        calls.push(`getContext:${dir}`)
        return overrides?.getContext ?? { isGitRepository: false }
      },
      listRefs: async (dir: string) => {
        calls.push(`listRefs:${dir}`)
        return overrides?.listRefs ?? { refs: [], currentBranch: null, defaultRef: null }
      },
      getStatus: async (dir: string) => {
        calls.push(`getStatus:${dir}`)
        return { isGitRepository: false, checkoutPath: dir }
      },
    },
    worktrees: {},
  } as unknown as GitServices
  return { git, calls }
}

function makeHarness(gitServices: GitServices) {
  const handlers = new Map<string, HandlerFn>()
  const prepareCalls: Array<[string, unknown]> = []
  const removeCalls: Array<[string, boolean | undefined]> = []
  const inspectCalls: string[] = []
  let setGitServicesArg: GitServices | null = null

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
      setGitServices(services: GitServices) {
        setGitServicesArg = services
      },
      async prepareCheckout(sessionId: string, intent: unknown) {
        prepareCalls.push([sessionId, intent])
        return { checkout: {}, workingDirectory: '/wt', sdkCwd: '/wt' }
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
    removeCalls,
    inspectCalls,
    getSetGitServicesArg: () => setGitServicesArg,
  }
}

describe('registerGitHandlers', () => {
  beforeEach(() => {
    delete process.env[FLAG]
  })
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env[FLAG]
    else process.env[FLAG] = ORIGINAL
  })

  it('injects the shared git services into the session manager', () => {
    const { git } = makeGitServices()
    const { getSetGitServicesArg } = makeHarness(git)
    expect(getSetGitServicesArg()).toBe(git)
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

  it('resolves worktree removal from the session (never a client path) and gates it on the flag', async () => {
    const { git } = makeGitServices()
    const { handlers, ctx, inspectCalls, removeCalls } = makeHarness(git)

    // Inspection is read-only and resolves identity from the session ID alone.
    await handlers.get(RPC_CHANNELS.git.INSPECT_WORKTREE_REMOVAL)!(ctx, 's1')
    expect(inspectCalls).toEqual(['s1'])

    await expect(
      handlers.get(RPC_CHANNELS.git.REMOVE_WORKTREE)!(ctx, 's1'),
    ).rejects.toThrow(/not enabled/)
    expect(removeCalls).toHaveLength(0)

    process.env[FLAG] = 'true'
    await handlers.get(RPC_CHANNELS.git.REMOVE_WORKTREE)!(ctx, 's1', true)
    expect(removeCalls).toEqual([['s1', true]])
  })

  it('stubs later-phase channels with a not-implemented rejection', async () => {
    process.env[FLAG] = 'true'
    const { git } = makeGitServices()
    const { handlers, ctx } = makeHarness(git)

    await expect(handlers.get(RPC_CHANNELS.git.GET_DIFF)!(ctx)).rejects.toThrow(/not implemented/)
    await expect(
      handlers.get(RPC_CHANNELS.git.COMMIT)!(ctx, { sessionId: 's1', message: 'x' }),
    ).rejects.toThrow(/not implemented/)
    await expect(handlers.get(RPC_CHANNELS.git.GITHUB_STATUS)!(ctx)).rejects.toThrow(
      /not implemented/,
    )
  })
})
