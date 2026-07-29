import { describe, test, expect, afterEach, beforeEach } from 'bun:test'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { SessionManager, createManagedSession } from '../../sessions/SessionManager'
import { createGitServices } from '../index'
import type { ManagedWorktreeRecord } from '@kata-sh/shared/protocol'
import { initRepo, makeTmpDir, cleanup, git, writeFile } from './test-helpers'

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

function servicesFor() {
  const worktreeRoot = tmp()
  return createGitServices({
    worktreeRoot,
    registryPath: join(worktreeRoot, 'registry.json'),
  })
}

async function commonDir(dir: string): Promise<string> {
  return (await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
}

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
  mkdirSync(join(workspaceRootPath, 'sessions', id), { recursive: true })
  const managed = createManagedSession(
    { id, sdkCwd: join(workspaceRootPath, 'sessions', id) },
    workspace as any,
    { messagesLoaded: true, createdAt: Date.now() },
  )
  ;(sm as any).sessions.set(id, managed)
  return managed
}

describe('ManagedWorktreeService.removeWorktree — identity revalidation', () => {
  test('blocks removal when the checkout is on an unexpected branch', async () => {
    const repo = tmp()
    await initRepo(repo)
    const svc = servicesFor()
    const gcd = await commonDir(repo)
    const { record } = await svc.worktrees.createWorktree({
      workspaceId: 'ws1',
      sessionId: 'only',
      repositoryRoot: repo,
      gitCommonDir: gcd,
      baseRef: 'main',
    })
    // Externally switch the worktree onto a different branch.
    await git(record.checkoutPath, ['switch', '-c', 'somebody-elses-branch'])

    const res = await svc.worktrees.removeWorktree(record.managedWorktreeId, 'only')
    expect(res.removed).toBe(false)
    expect(res.blocked).toBe(true)
    // Directory must remain untouched when identity validation fails.
    expect(existsSync(record.checkoutPath)).toBe(true)
  })

  test('blocks removal when the checkout path is outside the Kata worktree root', async () => {
    const repo = tmp()
    await initRepo(repo)
    const svc = servicesFor()
    const gcd = await commonDir(repo)
    // Fabricate a registry record pointing at the repository itself (not under
    // the managed worktree root) — a malicious/confused caller must not be able
    // to delete arbitrary paths.
    const rogue: ManagedWorktreeRecord = {
      managedWorktreeId: 'rogue-1',
      repositoryRoot: repo,
      gitCommonDir: gcd,
      checkoutPath: repo,
      baseRef: 'main',
      expectedBranch: 'main',
      createdAt: Date.now(),
      ownerSessionIds: ['only'],
      state: 'ready',
    }
    svc.registry.upsert(rogue)

    const res = await svc.worktrees.removeWorktree('rogue-1', 'only')
    expect(res.removed).toBe(false)
    expect(res.blocked).toBe(true)
    expect(existsSync(repo)).toBe(true)
  })
})

describe('SessionManager.removeManagedWorktree — session-resolved identity', () => {
  test('resolves the worktree from the session checkout and removes it (final owner)', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'sess1', wsRoot)

    const prep = await sm.prepareCheckout('sess1', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    expect(existsSync(prep.checkout.checkoutPath)).toBe(true)

    const res = await sm.removeManagedWorktree('sess1')
    expect(res.removed).toBe(true)
    expect(existsSync(prep.checkout.checkoutPath)).toBe(false)
  })

  test('blocks removal while another session still owns the worktree', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm, services } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'parent', wsRoot)

    const prep = await sm.prepareCheckout('parent', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    // A conversation branch adds a second owner.
    services.worktrees.addOwner(prep.checkout.managedWorktreeId!, 'child')

    const res = await sm.removeManagedWorktree('parent')
    expect(res.removed).toBe(false)
    expect(res.blocked).toBe(true)
    expect(existsSync(prep.checkout.checkoutPath)).toBe(true)
  })

  test('rejects when the session has no managed worktree checkout', async () => {
    const { sm } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'plain', wsRoot)
    await expect(sm.removeManagedWorktree('plain')).rejects.toThrow(/no managed worktree/i)
  })

  test('blocks removal of a worktree with uncommitted work unless a destructive force is confirmed (AC19)', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'dirty', wsRoot)

    const prep = await sm.prepareCheckout('dirty', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    // Leave uncommitted work in the worktree.
    writeFile(prep.checkout.checkoutPath, 'scratch.txt', 'work in progress\n')

    // The inspection the delete dialog reads flags a destructive removal.
    const risk = await sm.inspectManagedWorktreeRemoval('dirty')
    expect(risk.uncommittedFileCount).toBeGreaterThan(0)
    expect(risk.blocked).toBe(false)

    // Without force the removal is refused and the checkout is preserved.
    const blocked = await sm.removeManagedWorktree('dirty')
    expect(blocked.removed).toBe(false)
    expect(blocked.blocked).toBe(true)
    expect(existsSync(prep.checkout.checkoutPath)).toBe(true)

    // With the explicit destructive confirmation (force) it is removed.
    const forced = await sm.removeManagedWorktree('dirty', { force: true })
    expect(forced.removed).toBe(true)
    expect(existsSync(prep.checkout.checkoutPath)).toBe(false)
  })
})

describe('ManagedWorktreeService.removeWorktree — dry run', () => {
  test('reports the verdict of every guard without touching anything', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm, services } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'dry', wsRoot)

    const prep = await sm.prepareCheckout('dry', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    const id = prep.checkout.managedWorktreeId!

    // Clean worktree: removal would be allowed, and the dry run performs none of it.
    const allowed = await services.worktrees.removeWorktree(id, 'dry', { dryRun: true })
    expect(allowed.blocked).toBe(false)
    expect(allowed.removed).toBe(false)
    expect(existsSync(prep.checkout.checkoutPath)).toBe(true)
    expect(services.registry.get(id)).toBeDefined()

    // Uncommitted work: the same block the real call would report.
    writeFile(prep.checkout.checkoutPath, 'dirty.txt', 'work\n')
    const blocked = await services.worktrees.removeWorktree(id, 'dry', { dryRun: true })
    expect(blocked.blocked).toBe(true)
    expect(blocked.blockedReason).toContain('uncommitted')
    expect(existsSync(prep.checkout.checkoutPath)).toBe(true)

    // Confirming force clears the block, still without removing.
    const forced = await services.worktrees.removeWorktree(id, 'dry', {
      dryRun: true,
      force: true,
    })
    expect(forced.blocked).toBe(false)
    expect(forced.removed).toBe(false)
    expect(existsSync(prep.checkout.checkoutPath)).toBe(true)

    // The real call, for contrast.
    const real = await services.worktrees.removeWorktree(id, 'dry', { force: true })
    expect(real.removed).toBe(true)
    expect(existsSync(prep.checkout.checkoutPath)).toBe(false)
  })

  test('a shared worktree is blocked in a dry run without dropping ownership', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm, services } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'a', wsRoot)
    injectSession(sm, 'b', wsRoot)

    const prep = await sm.prepareCheckout('a', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    const id = prep.checkout.managedWorktreeId!
    services.worktrees.addOwner(id, 'b')

    const res = await services.worktrees.removeWorktree(id, 'a', { dryRun: true, force: true })
    expect(res.blocked).toBe(true)
    expect(existsSync(prep.checkout.checkoutPath)).toBe(true)
    expect(services.registry.get(id)!.ownerSessionIds).toEqual(['a', 'b'])
  })
})
