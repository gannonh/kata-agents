/**
 * Serial headless-server flow representing remote filesystem ownership
 * (spec: AC17, AC21).
 *
 * The workspace-owning server owns ALL Git behavior. A client — local embedded
 * or remote headless — only ever sends session-ID-addressed RPCs; every Git,
 * worktree, and identity command executes on the owning server. This test wires
 * the real {@link registerGitHandlers} to a real SessionManager + real
 * GitServices over a real temporary repository and drives the full slice
 * (discover → prepare worktree → commit → identity guard) exclusively through
 * the registered RPC handlers. Because the handler code is identical for
 * embedded and headless transports, exercising it here with server-owned state
 * and no client-supplied paths is the local/remote parity guarantee.
 *
 * Runs serially (a single describe with shared temp dirs) per the spec's
 * "serial headless-server flow" requirement.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RPC_CHANNELS } from '@kata-sh/shared/protocol'
import type { GitActionResult, RepositoryContext } from '@kata-sh/shared/protocol'
import type { HandlerFn, RequestContext, RpcServer } from '@kata-sh/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { SessionManager, createManagedSession } from '../../sessions/SessionManager'
import { createGitServices } from '../../git'
import { registerGitHandlers } from './git'
import { initRepo, git as gitCmd, makeTmpDir, cleanup } from '../../git/__tests__/test-helpers'

const FLAG = 'KATA_FEATURE_GIT_WORKSPACE_V1'
const V2_FLAG = 'KATA_FEATURE_WORKTREE_V2'
const ORIGINAL = process.env[FLAG]
const ORIGINAL_V2 = process.env[V2_FLAG]

const cleanups: string[] = []
function tmp(): string {
  const d = makeTmpDir('kata-headless-')
  cleanups.push(d)
  return d
}

beforeEach(() => {
  process.env[FLAG] = '1'
  delete process.env[V2_FLAG]
})
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env[FLAG]
  else process.env[FLAG] = ORIGINAL
  if (ORIGINAL_V2 === undefined) delete process.env[V2_FLAG]
  else process.env[V2_FLAG] = ORIGINAL_V2
  while (cleanups.length) cleanup(cleanups.pop()!)
})

/** Real SessionManager + GitServices representing the workspace-owning server. */
function makeServer() {
  const worktreeRoot = tmp()
  const services = createGitServices({
    worktreeRoot,
    registryPath: join(worktreeRoot, 'registry.json'),
  })
  const sm = new SessionManager()
  sm.setGitServices(services)

  // Thin adapter: forward only what the handlers use, and short-circuit
  // waitForInit so the best-effort startup reconciliation doesn't hang on an
  // uninitialized manager in the test.
  const sessionManager = {
    getSessions: (ws?: string) => sm.getSessions(ws),
    setGitServices: (s: unknown) => sm.setGitServices(s as never),
    setGitStatusRefresher: (fn: (id: string) => void) => sm.setGitStatusRefresher(fn),
    waitForInit: async () => {},
    prepareCheckout: (id: string, intent: unknown) => sm.prepareCheckout(id, intent as never),
    inspectManagedWorktreeRemoval: (id: string) => sm.inspectManagedWorktreeRemoval(id),
    removeManagedWorktree: (id: string, opts?: { force?: boolean }) =>
      sm.removeManagedWorktree(id, opts),
  } as unknown as HandlerDeps['sessionManager']

  const handlers = new Map<string, HandlerFn>()
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
    sessionManager,
    oauthFlowStore: {} as HandlerDeps['oauthFlowStore'],
    platform: {} as HandlerDeps['platform'],
    gitServices: services,
  }
  registerGitHandlers(server, deps)

  const ctx: RequestContext = { clientId: 'headless-client', workspaceId: 'ws_test', webContentsId: 1 }
  return { sm, services, handlers, ctx }
}

function injectSession(sm: SessionManager, id: string, workspaceRootPath: string) {
  const workspace = { id: 'ws_test', name: 'WS', rootPath: workspaceRootPath, createdAt: Date.now() }
  const managed = createManagedSession(
    { id, sdkCwd: join(workspaceRootPath, 'sessions', id) },
    workspace as never,
    { messagesLoaded: true, createdAt: Date.now() },
  )
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
}

describe('headless-server Git flow (remote ownership) — AC17/AC21', () => {
  test('keeps V2 settings, named preparation, session metadata, and Git actions server-owned', async () => {
    process.env[V2_FLAG] = '1'
    const repo = tmp()
    await initRepo(repo)
    const { sm, services, handlers, ctx } = makeServer()
    const customRoot = tmp()
    const canonicalRoot = realpathSync(customRoot)
    injectSession(sm, 'remote-v2', tmp())

    const capability = await handlers.get(RPC_CHANNELS.git.GET_CAPABILITIES)!(ctx) as {
      serverId: string
      worktreeV2: boolean
    }
    expect(capability).toEqual({ serverId: 'local', worktreeV2: true })

    const updated = await handlers.get(RPC_CHANNELS.git.UPDATE_WORKTREE_SETTINGS)!(
      ctx,
      { materializationRoot: customRoot },
    ) as { materializationRoot: string; version: number }
    expect(updated.materializationRoot).toBe(canonicalRoot)
    expect(updated.version).toBe(1)

    const prep = await handlers.get(RPC_CHANNELS.git.PREPARE_CHECKOUT)!(ctx, 'remote-v2', {
      schemaVersion: 2,
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
      worktreeNameSuffix: 'auth-refresh',
    }) as {
      checkout: {
        schemaVersion: number
        checkoutPath: string
        displayName: string
        expectedBranch: string
        materializationRoot: string
        managedWorktreeId: string
      }
    }
    expect(prep.checkout).toMatchObject({
      schemaVersion: 2,
      displayName: 'auth-refresh',
      expectedBranch: 'kata-agent/auth-refresh',
      materializationRoot: canonicalRoot,
    })
    expect(prep.checkout.checkoutPath.startsWith(canonicalRoot)).toBe(true)
    expect(services.registry.get(prep.checkout.managedWorktreeId)).toMatchObject({
      displayName: 'auth-refresh',
      materializationRoot: canonicalRoot,
    })
    expect(sm.getSessions().find((session) => session.id === 'remote-v2')?.checkout).toMatchObject({
      schemaVersion: 2,
      displayName: 'auth-refresh',
      expectedBranch: 'kata-agent/auth-refresh',
      materializationRoot: canonicalRoot,
    })

    writeFileSync(join(prep.checkout.checkoutPath, 'work.txt'), 'named headless change\n')
    const commit = await handlers.get(RPC_CHANNELS.git.COMMIT)!(ctx, {
      sessionId: 'remote-v2',
      message: 'headless: named worktree',
      paths: ['work.txt'],
    }) as GitActionResult
    expect(commit.stages.every((stage) => stage.status === 'succeeded')).toBe(true)
    expect((await gitCmd(prep.checkout.checkoutPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe(
      'kata-agent/auth-refresh',
    )
  })

  test('discovers, prepares a worktree, commits, and enforces identity — all server-side by session ID', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm, handlers, ctx } = makeServer()
    injectSession(sm, 'remote1', tmp())

    // 1. Discovery is read-only and available regardless of transport.
    const context = (await handlers.get(RPC_CHANNELS.git.GET_CONTEXT)!(ctx, repo)) as RepositoryContext
    expect(context.isGitRepository).toBe(true)
    expect(context.currentBranch).toBe('main')

    // 2. Prepare a managed worktree on the owning server addressed only by
    //    session ID + intent (no client-supplied checkout path).
    const prep = (await handlers.get(RPC_CHANNELS.git.PREPARE_CHECKOUT)!(ctx, 'remote1', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })) as { checkout: { checkoutPath: string; expectedBranch?: string } }
    const checkoutPath = prep.checkout.checkoutPath
    expect(existsSync(checkoutPath)).toBe(true)

    // The server now owns the resolved checkout; the client never passes it.
    const session = sm.getSessions().find((s) => s.id === 'remote1')!
    expect(session.checkout?.checkoutPath).toBe(checkoutPath)
    const expectedBranch = session.checkout!.expectedBranch!
    expect(expectedBranch).toMatch(/^kata-agent\//)

    // 3. Commit a change through the COMMIT handler (server-side selected-file
    //    transaction). Addressed by session ID only.
    writeFileSync(join(checkoutPath, 'work.txt'), 'headless change\n')
    const commit = (await handlers.get(RPC_CHANNELS.git.COMMIT)!(ctx, {
      sessionId: 'remote1',
      message: 'headless: add work.txt',
      paths: ['work.txt'],
    })) as GitActionResult
    expect(commit.stages.every((s) => s.status === 'succeeded')).toBe(true)

    // The commit really landed on the managed branch in the worktree.
    const log = await gitCmd(checkoutPath, ['log', '--oneline', '-1'])
    expect(log).toContain('headless: add work.txt')
    const branch = (await gitCmd(checkoutPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    expect(branch).toBe(expectedBranch)
  })

  test('blocks a mutation when the managed worktree branch is switched externally, without switching it back', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm, handlers, ctx } = makeServer()
    injectSession(sm, 'remote2', tmp())

    const prep = (await handlers.get(RPC_CHANNELS.git.PREPARE_CHECKOUT)!(ctx, 'remote2', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })) as { checkout: { checkoutPath: string } }
    const checkoutPath = prep.checkout.checkoutPath

    // Externally switch the worktree onto a different branch (simulating an
    // out-of-band `git switch`).
    await gitCmd(checkoutPath, ['switch', '-c', 'externally-switched'])

    writeFileSync(join(checkoutPath, 'work.txt'), 'change on the wrong branch\n')
    await expect(
      handlers.get(RPC_CHANNELS.git.COMMIT)!(ctx, {
        sessionId: 'remote2',
        message: 'should be blocked',
        paths: ['work.txt'],
      }),
    ).rejects.toThrow(/changed unexpectedly|switched|moved|removed/i)

    // Recovery, not silent correction: the server never switched the branch back.
    const branch = (await gitCmd(checkoutPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    expect(branch).toBe('externally-switched')
  })

  test('removes a managed worktree only through the session-addressed handler (never a client path)', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm, services, handlers, ctx } = makeServer()
    injectSession(sm, 'remote3', tmp())

    const prep = (await handlers.get(RPC_CHANNELS.git.PREPARE_CHECKOUT)!(ctx, 'remote3', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })) as { checkout: { checkoutPath: string; managedWorktreeId: string } }
    const { checkoutPath, managedWorktreeId } = prep.checkout

    // Inspection is read-only and resolves identity from the session server-side.
    const risk = (await handlers.get(RPC_CHANNELS.git.INSPECT_WORKTREE_REMOVAL)!(ctx, 'remote3')) as {
      exists: boolean
      blocked: boolean
    }
    expect(risk.exists).toBe(true)
    expect(risk.blocked).toBe(false)

    const res = (await handlers.get(RPC_CHANNELS.git.REMOVE_WORKTREE)!(ctx, 'remote3', false)) as {
      removed: boolean
    }
    expect(res.removed).toBe(true)
    expect(existsSync(checkoutPath)).toBe(false)
    expect(services.registry.get(managedWorktreeId)).toBeUndefined()
  })

  test('emits session_updated when lifecycle mutates an owner session checkout (AC14 sync)', async () => {
    process.env[V2_FLAG] = '1'
    const repo = tmp()
    await initRepo(repo)
    const { sm, services, handlers, ctx } = makeServer()
    injectSession(sm, 'evt-owner', tmp())

    // Capture session events the manager would send to the renderer.
    const events: Array<{ type: string; sessionId: string }> = []
    sm.setEventSink((_channel, _target, payload: unknown) => {
      const event = payload as { type: string; sessionId: string }
      if (event?.type === 'session_updated' || event?.type === 'session_created') {
        events.push({ type: event.type, sessionId: event.sessionId })
      }
    })
    services.lifecycle.markReady()

    const prep = (await handlers.get(RPC_CHANNELS.git.PREPARE_CHECKOUT)!(ctx, 'evt-owner', {
      schemaVersion: 2,
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
      worktreeNameSuffix: 'event-owner',
    })) as { checkout: { managedWorktreeId: string; checkoutPath: string } }
    const { managedWorktreeId, checkoutPath } = prep.checkout
    events.length = 0

    const preview = (await handlers.get(RPC_CHANNELS.git.WORKTREE_PREVIEW)!(ctx, managedWorktreeId)) as {
      previewFingerprint: string
    }
    await handlers.get(RPC_CHANNELS.git.WORKTREE_DELETE)!(ctx, {
      managedWorktreeId,
      previewFingerprint: preview.previewFingerprint,
    })

    // The owner session's checkout DTO changed server-side; the renderer must
    // be told to re-fetch it (this is what surfaces the recovery badge).
    expect(events).toContainEqual({ type: 'session_updated', sessionId: 'evt-owner' })
    const session = sm.getSessions().find((s) => s.id === 'evt-owner')!
    expect(session.checkout).toMatchObject({
      mode: 'managed-worktree',
      managedWorktreeId,
      recoveryState: 'snapshotted',
    })
    expect(existsSync(checkoutPath)).toBe(false)

    // Restore clears the recovery state and re-emits.
    await handlers.get(RPC_CHANNELS.git.WORKTREE_RESTORE)!(ctx, managedWorktreeId)
    expect(events.filter((e) => e.type === 'session_updated')).toHaveLength(2)
    const restored = sm.getSessions().find((s) => s.id === 'evt-owner')!
    expect(restored.checkout?.recoveryState).toBeUndefined()
    expect(restored.checkout?.checkoutPath).not.toBe(checkoutPath)
  })
})
