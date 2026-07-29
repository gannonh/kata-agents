/**
 * Phase 4 lifecycle safety (spec: AC18–AC19).
 *
 * These exercise the SessionManager + ManagedWorktreeService together through a
 * real temporary Git repository to prove that:
 *  - archiving a session preserves its managed worktree and ownership;
 *  - deleting a session never removes the checkout — it only drops the owner
 *    reference, even for the final owner (removal is a separate explicit choice);
 *  - a shared worktree survives deletion of one owner while another remains.
 */
import { describe, test, expect, afterEach, beforeEach } from 'bun:test'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { SessionManager, createManagedSession } from '../../sessions/SessionManager'
import { createGitServices } from '../index'
import { initRepo, makeTmpDir, cleanup } from './test-helpers'

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
  mkdirSync(join(workspaceRootPath, 'sessions', id), { recursive: true })
  const managed = createManagedSession(
    { id, sdkCwd: join(workspaceRootPath, 'sessions', id) },
    workspace as any,
    { messagesLoaded: true, createdAt: Date.now() },
  )
  ;(sm as any).sessions.set(id, managed)
  return managed
}

describe('SessionManager lifecycle — worktree preservation (AC18)', () => {
  test('archiving a session preserves its managed worktree, registry record, and ownership', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm, services } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'arch1', wsRoot)

    const prep = await sm.prepareCheckout('arch1', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    const id = prep.checkout.managedWorktreeId!

    await sm.archiveSession('arch1')

    // Archive must never remove the checkout (spec: out of scope — automatic
    // worktree removal on archive).
    expect(existsSync(prep.checkout.checkoutPath)).toBe(true)
    const rec = services.registry.get(id)
    expect(rec).toBeDefined()
    expect(rec!.ownerSessionIds).toContain('arch1')
  })

  test('deleting the final owner preserves the checkout — removal is a separate choice', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm, services } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'del1', wsRoot)

    const prep = await sm.prepareCheckout('del1', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    const id = prep.checkout.managedWorktreeId!

    await sm.deleteSession('del1')

    // The checkout is NOT removed on delete; the owner reference is dropped.
    expect(existsSync(prep.checkout.checkoutPath)).toBe(true)
    const rec = services.registry.get(id)
    expect(rec).toBeDefined()
    expect(rec!.ownerSessionIds).not.toContain('del1')
  })

  test('deleting one owner of a shared worktree keeps it for the remaining owner', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm, services } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'parent', wsRoot)
    injectSession(sm, 'child', wsRoot)

    const prep = await sm.prepareCheckout('parent', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    const id = prep.checkout.managedWorktreeId!
    // Conversation branch: a second owner shares the worktree.
    services.worktrees.addOwner(id, 'child')

    await sm.deleteSession('parent')

    expect(existsSync(prep.checkout.checkoutPath)).toBe(true)
    const rec = services.registry.get(id)!
    expect(rec.ownerSessionIds).toEqual(['child'])
  })
})
