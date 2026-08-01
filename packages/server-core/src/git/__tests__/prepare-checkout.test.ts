import { describe, test, expect, afterEach, beforeEach } from 'bun:test'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadSession as loadStoredSession } from '@kata-sh/shared/sessions'
import { SessionManager, createManagedSession } from '../../sessions/SessionManager'
import { createGitServices } from '../index'
import { initRepo, makeTmpDir, cleanup, git } from './test-helpers'

const cleanups: string[] = []
function tmp(): string {
  const d = makeTmpDir()
  cleanups.push(d)
  return d
}
afterEach(() => {
  delete process.env.KATA_FEATURE_GIT_WORKSPACE_V1
  while (cleanups.length) cleanup(cleanups.pop()!)
})
beforeEach(() => {
  process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = '1'
})

function makeManager() {
  const worktreeRoot = tmp()
  const services = createGitServices({
    worktreeRoot,
    registryPath: join(worktreeRoot, 'registry.json'),
  })
  const sm = new SessionManager()
  sm.setGitServices(services)
  return { sm, services }
}

function injectSession(sm: SessionManager, id: string, workspaceRootPath: string) {
  const workspace = { id: 'ws_test', name: 'WS', rootPath: workspaceRootPath, createdAt: Date.now() }
  // Pre-create the session dir so debounced persistence has somewhere to write.
  mkdirSync(join(workspaceRootPath, 'sessions', id), { recursive: true })
  const managed = createManagedSession(
    { id, sdkCwd: join(workspaceRootPath, 'sessions', id) },
    workspace as any,
    { messagesLoaded: true, createdAt: Date.now() },
  )
  ;(sm as any).sessions.set(id, managed)
  return managed
}

describe('SessionManager.prepareCheckout — managed worktree', () => {
  test('binds checkout, workingDirectory, and sdkCwd to a new worktree before first message', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm } = makeManager()
    const wsRoot = tmp()
    const managed = injectSession(sm, 'sess1', wsRoot)

    const result = await sm.prepareCheckout('sess1', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })

    expect(result.checkout.mode).toBe('managed-worktree')
    expect(result.checkout.expectedBranch).toMatch(/^kata-agent\/[0-9a-f]{8}$/)
    expect(result.checkout.baseRef).toBe('main')
    // workingDirectory AND sdkCwd both resolve to the worktree (AC4).
    expect(result.workingDirectory).toBe(result.checkout.checkoutPath)
    expect(managed.workingDirectory).toBe(result.checkout.checkoutPath)
    expect(managed.sdkCwd).toBe(result.checkout.checkoutPath)
    expect(existsSync(result.checkout.checkoutPath)).toBe(true)
  })

  test('rejects preparation when the session already has a message (empty-session gate, AC5)', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm } = makeManager()
    const wsRoot = tmp()
    const managed = injectSession(sm, 'sess2', wsRoot)
    managed.messages.push({ id: 'm1', role: 'user', content: 'hi' } as any)

    await expect(
      sm.prepareCheckout('sess2', { mode: 'managed-worktree', workingDirectory: repo, baseRef: 'main' }),
    ).rejects.toThrow(/empty session/i)
  })

  test('rejects preparation when the session already has an SDK session id', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm } = makeManager()
    const wsRoot = tmp()
    const managed = injectSession(sm, 'sess3', wsRoot)
    managed.sdkSessionId = 'sdk-123'

    await expect(
      sm.prepareCheckout('sess3', { mode: 'managed-worktree', workingDirectory: repo, baseRef: 'main' }),
    ).rejects.toThrow(/empty session/i)
  })

  test('is idempotent for a matching repeated intent but rejects a different one', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'sess4', wsRoot)

    const first = await sm.prepareCheckout('sess4', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    // Repeated matching request returns the same bound checkout.
    const second = await sm.prepareCheckout('sess4', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    expect(second.checkout.checkoutPath).toBe(first.checkout.checkoutPath)

    // A different intent (current checkout) is rejected once prepared.
    await expect(
      sm.prepareCheckout('sess4', { mode: 'current', workingDirectory: repo }),
    ).rejects.toThrow(/already prepared/i)
  })

  test('rejects a repeated managed-worktree request with a different base ref', async () => {
    const repo = tmp()
    await initRepo(repo)
    await git(repo, ['branch', 'feature'])
    const { sm } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'sess4b', wsRoot)

    await sm.prepareCheckout('sess4b', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    // Same mode + repo but a different base ref is a different intent.
    await expect(
      sm.prepareCheckout('sess4b', {
        mode: 'managed-worktree',
        workingDirectory: repo,
        baseRef: 'feature',
      }),
    ).rejects.toThrow(/already prepared/i)
  })

  test('durably persists checkout metadata before returning success (AC5)', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'sessDurable', wsRoot)

    const result = await sm.prepareCheckout('sessDurable', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })

    // The checkout is on disk immediately after prepareCheckout resolves,
    // without any additional flush — a restart/resume restores the same one.
    const stored = loadStoredSession(wsRoot, 'sessDurable')
    expect(stored?.checkout?.mode).toBe('managed-worktree')
    expect(stored?.checkout?.checkoutPath).toBe(result.checkout.checkoutPath)
    expect(stored?.checkout?.managedWorktreeId).toBe(result.checkout.managedWorktreeId)
  })

  test('rejects a non-Git directory', async () => {
    const plain = tmp()
    const { sm } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'sess5', wsRoot)
    await expect(
      sm.prepareCheckout('sess5', { mode: 'managed-worktree', workingDirectory: plain, baseRef: 'main' }),
    ).rejects.toThrow(/not inside a Git repository/i)
  })

  test('rejects when the feature flag is disabled', async () => {
    process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = '0'
    const repo = tmp()
    await initRepo(repo)
    const { sm } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'sess6', wsRoot)
    await expect(
      sm.prepareCheckout('sess6', { mode: 'managed-worktree', workingDirectory: repo, baseRef: 'main' }),
    ).rejects.toThrow(/not enabled/i)
  })
})

describe('SessionManager.prepareCheckout — current checkout', () => {
  test('binds current-checkout metadata without creating a branch (AC2)', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'sessC', wsRoot)

    const result = await sm.prepareCheckout('sessC', { mode: 'current', workingDirectory: repo })
    expect(result.checkout.mode).toBe('current')
    expect(result.checkout.managedWorktreeId).toBeNull()
    expect(result.checkout.expectedBranch).toBeNull()
    expect(result.checkout.branchAtPreparation).toBe('main')
    // No kata-agent branch was created.
    const branches = await git(repo, ['branch', '--list', 'kata-agent/*'])
    expect(branches.trim()).toBe('')
  })
})
