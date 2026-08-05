import { describe, test, expect, afterEach, beforeEach } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
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

function injectSession(sm: SessionManager, id: string, workspaceRootPath: string, workspaceId = 'ws_test') {
  const workspace = { id: workspaceId, name: 'WS', rootPath: workspaceRootPath, createdAt: Date.now() }
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
  test('binds named V2 checkout identity and persists the exact display name', async () => {
    const previousV2 = process.env.KATA_FEATURE_WORKTREE_V2
    process.env.KATA_FEATURE_WORKTREE_V2 = '1'
    try {
      const repo = tmp()
      await initRepo(repo)
      const { sm, services } = makeManager()
      const wsRoot = tmp()
      const managed = injectSession(sm, 'named-session', wsRoot)

      const result = await sm.prepareCheckout('named-session', {
        schemaVersion: 2,
        mode: 'managed-worktree',
        workingDirectory: repo,
        baseRef: 'main',
        worktreeNameSuffix: 'auth-refresh',
      })

      expect(result.checkout).toMatchObject({
        schemaVersion: 2,
        mode: 'managed-worktree',
        displayName: 'auth-refresh',
        expectedBranch: 'kata-agent/auth-refresh',
        materializationRoot: services.worktreeSettings.getSnapshot().materializationRoot,
      })
      expect(result.checkout.checkoutPath).toMatch(/auth-refresh-[0-9a-f]{8}$/)
      expect(managed.checkout).toEqual(result.checkout)
      expect(loadStoredSession(wsRoot, 'named-session')?.checkout).toEqual(result.checkout)
    } finally {
      if (previousV2 === undefined) delete process.env.KATA_FEATURE_WORKTREE_V2
      else process.env.KATA_FEATURE_WORKTREE_V2 = previousV2
    }
  })

  test('repeated named preparation is idempotent only for the same name', async () => {
    const previousV2 = process.env.KATA_FEATURE_WORKTREE_V2
    process.env.KATA_FEATURE_WORKTREE_V2 = '1'
    try {
      const repo = tmp()
      await initRepo(repo)
      const { sm, services } = makeManager()
      const wsRoot = tmp()
      injectSession(sm, 'named-repeat', wsRoot)

      const intent = {
        schemaVersion: 2 as const,
        mode: 'managed-worktree' as const,
        workingDirectory: repo,
        baseRef: 'main',
        worktreeNameSuffix: 'auth-refresh',
      }
      const first = await sm.prepareCheckout('named-repeat', intent)
      const second = await sm.prepareCheckout('named-repeat', intent)
      expect(second.checkout).toEqual(first.checkout)
      expect(services.registry.getOwnerCount(first.checkout.managedWorktreeId!)).toBe(1)

      await expect(
        sm.prepareCheckout('named-repeat', { ...intent, worktreeNameSuffix: 'other-name' }),
      ).rejects.toThrow(/already prepared/i)
    } finally {
      if (previousV2 === undefined) delete process.env.KATA_FEATURE_WORKTREE_V2
      else process.env.KATA_FEATURE_WORKTREE_V2 = previousV2
    }
  })

  test('rejects direct named preparation when V2 is ineffective', async () => {
    const previousV2 = process.env.KATA_FEATURE_WORKTREE_V2
    delete process.env.KATA_FEATURE_WORKTREE_V2
    try {
      const repo = tmp()
      await initRepo(repo)
      const { sm } = makeManager()
      const wsRoot = tmp()
      injectSession(sm, 'named-disabled', wsRoot)

      await expect(
        sm.prepareCheckout('named-disabled', {
          schemaVersion: 2,
          mode: 'managed-worktree',
          workingDirectory: repo,
          baseRef: 'main',
          worktreeNameSuffix: 'auth-refresh',
        }),
      ).rejects.toMatchObject({ code: 'GIT_WORKTREE_V2_UNAVAILABLE' })
    } finally {
      if (previousV2 === undefined) delete process.env.KATA_FEATURE_WORKTREE_V2
      else process.env.KATA_FEATURE_WORKTREE_V2 = previousV2
    }
  })

  test('binds V2 metadata when sharing an existing V2 worktree', async () => {
    const previousV2 = process.env.KATA_FEATURE_WORKTREE_V2
    process.env.KATA_FEATURE_WORKTREE_V2 = '1'
    try {
      const repo = tmp()
      await initRepo(repo)
      const { sm } = makeManager()
      const wsRoot = tmp()
      injectSession(sm, 'named-owner', wsRoot)
      const first = await sm.prepareCheckout('named-owner', {
        schemaVersion: 2,
        mode: 'managed-worktree',
        workingDirectory: repo,
        baseRef: 'main',
        worktreeNameSuffix: 'auth-refresh',
      })

      injectSession(sm, 'named-sharer', wsRoot)
      const shared = await sm.prepareCheckout('named-sharer', {
        mode: 'managed-worktree',
        workingDirectory: repo,
        managedWorktreeId: first.checkout.managedWorktreeId,
      })
      expect(shared.checkout).toMatchObject({
        schemaVersion: 2,
        displayName: 'auth-refresh',
        expectedBranch: 'kata-agent/auth-refresh',
        materializationRoot: (first.checkout as { materializationRoot: string }).materializationRoot,
      })
    } finally {
      if (previousV2 === undefined) delete process.env.KATA_FEATURE_WORKTREE_V2
      else process.env.KATA_FEATURE_WORKTREE_V2 = previousV2
    }
  })

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

describe('SessionManager.prepareCheckout — existing managed worktree (shared ownership)', () => {
  test('binds a new session to an existing worktree without recreating it', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm, services } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'sessOwner', wsRoot)

    const first = await sm.prepareCheckout('sessOwner', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })

    injectSession(sm, 'sessSharer', wsRoot)
    const result = await sm.prepareCheckout('sessSharer', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      managedWorktreeId: first.checkout.managedWorktreeId!,
    })

    // Persisted checkout identity points at the SAME worktree.
    expect(result.checkout.mode).toBe('managed-worktree')
    expect(result.checkout.checkoutPath).toBe(first.checkout.checkoutPath)
    expect(result.checkout.managedWorktreeId).toBe(first.checkout.managedWorktreeId)
    expect(result.checkout.expectedBranch).toBe(first.checkout.expectedBranch)
    expect(result.checkout.baseRef).toBe('main')
    expect(services.registry.getOwnerCount(first.checkout.managedWorktreeId!)).toBe(2)
    // The checkout itself was not recreated: same path, and no second branch.
    expect(existsSync(result.checkout.checkoutPath)).toBe(true)
    const branches = await git(repo, ['branch', '--list', 'kata-agent/*'])
    expect(branches.trim().split('\n')).toHaveLength(1)
  })

  test('is idempotent for a repeated existing-worktree intent', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm, services } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'sessOwner2', wsRoot)

    const first = await sm.prepareCheckout('sessOwner2', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    injectSession(sm, 'sessSharer2', wsRoot)
    const intent = {
      mode: 'managed-worktree' as const,
      workingDirectory: repo,
      managedWorktreeId: first.checkout.managedWorktreeId,
    }
    const second = await sm.prepareCheckout('sessSharer2', intent)
    const repeated = await sm.prepareCheckout('sessSharer2', intent)
    expect(repeated.checkout.checkoutPath).toBe(second.checkout.checkoutPath)
    // The owner reference was added exactly once.
    expect(services.registry.getOwnerCount(first.checkout.managedWorktreeId!)).toBe(2)
  })

  test('rejects an unknown managedWorktreeId', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'sessUnknown', wsRoot)

    await expect(
      sm.prepareCheckout('sessUnknown', {
        mode: 'managed-worktree',
        workingDirectory: repo,
        managedWorktreeId: 'does-not-exist',
      }),
    ).rejects.toThrow(/not found/i)
  })

  test('rejects a worktree owned by a different workspace', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm } = makeManager()
    const wsRootA = tmp()
    const wsRootB = tmp()
    injectSession(sm, 'sessWsA', wsRootA, 'ws_a')
    injectSession(sm, 'sessWsB', wsRootB, 'ws_b')

    const inA = await sm.prepareCheckout('sessWsA', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    await expect(
      sm.prepareCheckout('sessWsB', {
        mode: 'managed-worktree',
        workingDirectory: repo,
        managedWorktreeId: inA.checkout.managedWorktreeId,
      }),
    ).rejects.toThrow(/does not belong to the session's workspace/i)
  })

  test('rejects a worktree from an unrelated repository', async () => {
    const repoA = tmp()
    const repoB = tmp()
    await initRepo(repoA)
    await initRepo(repoB)
    const { sm } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'sessRepoA', wsRoot)
    injectSession(sm, 'sessRepoB', wsRoot)

    const inA = await sm.prepareCheckout('sessRepoA', {
      mode: 'managed-worktree',
      workingDirectory: repoA,
      baseRef: 'main',
    })
    await expect(
      sm.prepareCheckout('sessRepoB', {
        mode: 'managed-worktree',
        workingDirectory: repoB,
        managedWorktreeId: inA.checkout.managedWorktreeId,
      }),
    ).rejects.toThrow(/different repository/i)
  })

  test('rejects binding to a worktree that is not ready', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm, services } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'sessOwner3', wsRoot)

    const first = await sm.prepareCheckout('sessOwner3', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    services.registry.setState(first.checkout.managedWorktreeId!, 'blocked')

    injectSession(sm, 'sessBlocked', wsRoot)
    await expect(
      sm.prepareCheckout('sessBlocked', {
        mode: 'managed-worktree',
        workingDirectory: repo,
        managedWorktreeId: first.checkout.managedWorktreeId,
      }),
    ).rejects.toThrow(/cannot be shared/i)
  })

  test('rejects binding when the live checkout was deleted after the record became ready', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm, services } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'sessOwner5', wsRoot)

    const first = await sm.prepareCheckout('sessOwner5', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    // Registry still says `ready`, but the checkout is gone from disk (moved
    // or deleted outside Kata). Binding must not persist a dead path.
    rmSync(first.checkout.checkoutPath, { recursive: true, force: true })

    injectSession(sm, 'sessStale', wsRoot)
    await expect(
      sm.prepareCheckout('sessStale', {
        mode: 'managed-worktree',
        workingDirectory: repo,
        managedWorktreeId: first.checkout.managedWorktreeId!,
      }),
    ).rejects.toThrow(/no longer exists/i)
    expect(services.registry.getOwnerCount(first.checkout.managedWorktreeId!)).toBe(1)
  })

  test('rejects binding when the live checkout switched branches after the record became ready', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm, services } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'sessOwner6', wsRoot)

    const first = await sm.prepareCheckout('sessOwner6', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    // Registry still says `ready`, but the checkout is now on another branch.
    await git(first.checkout.checkoutPath, ['checkout', '-b', 'someone-else'])

    injectSession(sm, 'sessSwitched', wsRoot)
    await expect(
      sm.prepareCheckout('sessSwitched', {
        mode: 'managed-worktree',
        workingDirectory: repo,
        managedWorktreeId: first.checkout.managedWorktreeId!,
      }),
    ).rejects.toThrow(/unexpected branch/i)
    expect(services.registry.getOwnerCount(first.checkout.managedWorktreeId!)).toBe(1)
  })

  test('re-checks the empty-session gate after context resolution (concurrent first-message race)', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm, services } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'sessOwner7', wsRoot)

    const first = await sm.prepareCheckout('sessOwner7', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })

    const sharer = injectSession(sm, 'sessRace', wsRoot)
    // Simulate another client sending the session's first message while
    // repository discovery is still pending: the message lands before the
    // existing-worktree branch adds ownership and binds the checkout.
    const originalGetContext = services.repository.getContext.bind(services.repository)
    let injected = false
    ;(services.repository as any).getContext = async (dir: string, options?: { strict?: boolean }) => {
      const result = await originalGetContext(dir, options)
      if (!injected) {
        injected = true
        sharer.messages.push({ id: 'm1', role: 'user', content: 'hi' } as any)
      }
      return result
    }

    try {
      await expect(
        sm.prepareCheckout('sessRace', {
          mode: 'managed-worktree',
          workingDirectory: repo,
          managedWorktreeId: first.checkout.managedWorktreeId!,
        }),
      ).rejects.toThrow(/empty session/i)
    } finally {
      ;(services.repository as any).getContext = originalGetContext
    }
    // Ownership was never added and the checkout was never rebound.
    expect(services.registry.getOwnerCount(first.checkout.managedWorktreeId!)).toBe(1)
    expect(sharer.checkout).toBeUndefined()
  })

  test('releases the owner reference when binding the session fails', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm, services } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'sessOwner4', wsRoot)
    const first = await sm.prepareCheckout('sessOwner4', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    injectSession(sm, 'sessBroken', wsRoot)
    // Force the binding step to fail; the owner reference must be rolled back.
    const original = (sm as any).bindCheckout
    ;(sm as any).bindCheckout = () => {
      throw new Error('persist failed')
    }
    try {
      await expect(
        sm.prepareCheckout('sessBroken', {
          mode: 'managed-worktree',
          workingDirectory: repo,
          managedWorktreeId: first.checkout.managedWorktreeId,
        }),
      ).rejects.toThrow(/persist failed/)
    } finally {
      ;(sm as any).bindCheckout = original
    }
    expect(services.registry.getOwnerCount(first.checkout.managedWorktreeId!)).toBe(1)
  })
})

describe('SessionManager.listManagedWorktrees — discovery for new sessions', () => {
  test('lists ready worktrees of the same workspace + repository only', async () => {
    const repo = tmp()
    await initRepo(repo)
    const otherRepo = tmp()
    await initRepo(otherRepo)
    const { sm } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'sessA', wsRoot)
    injectSession(sm, 'sessB', wsRoot)
    injectSession(sm, 'sessC', wsRoot, 'ws_other')
    injectSession(sm, 'sessOtherRepo', wsRoot)
    injectSession(sm, 'sessNew', wsRoot)

    await sm.prepareCheckout('sessA', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    // Same workspace, different repo — must NOT be offered.
    await sm.prepareCheckout('sessOtherRepo', {
      mode: 'managed-worktree',
      workingDirectory: otherRepo,
      baseRef: 'main',
    })
    // Different workspace, same repo — must NOT be offered.
    await sm.prepareCheckout('sessC', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })

    const offered = await sm.listManagedWorktrees('sessNew', repo)
    expect(offered).toHaveLength(1)
    expect(offered[0]!.expectedBranch).toMatch(/^kata-agent\/[0-9a-f]{8}$/)
    expect(offered[0]!.ownerCount).toBe(1)
  })

  test('excludes the requesting session own worktree and non-ready records', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm, services } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'sessA', wsRoot)
    injectSession(sm, 'sessB', wsRoot)

    const inA = await sm.prepareCheckout('sessA', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    const inB = await sm.prepareCheckout('sessB', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    // Own worktree is excluded.
    const forA = await sm.listManagedWorktrees('sessA', repo)
    expect(forA.map((w) => w.managedWorktreeId)).toEqual([inB.checkout.managedWorktreeId!])
    // A blocked worktree is not offered.
    services.registry.setState(inB.checkout.managedWorktreeId!, 'blocked')
    const forA2 = await sm.listManagedWorktrees('sessA', repo)
    expect(forA2).toHaveLength(0)
  })

  test('returns an empty list for a non-Git directory', async () => {
    const { sm } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'sessPlain', wsRoot)
    const plain = tmp()
    const offered = await sm.listManagedWorktrees('sessPlain', plain)
    expect(offered).toEqual([])
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
