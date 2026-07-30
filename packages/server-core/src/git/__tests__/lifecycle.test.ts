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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
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

describe('SessionManager.deleteSession — server-owned removal ordering (AC18–AC19)', () => {
  test('removes the checkout only after the session is durably deleted', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm, services } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'combo', wsRoot)

    const prep = await sm.prepareCheckout('combo', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    const id = prep.checkout.managedWorktreeId!

    const result = await sm.deleteSession('combo', { removeManagedWorktree: true })

    expect(result.deleted).toBe(true)
    expect(result.worktreeRemoval?.removed).toBe(true)
    expect(existsSync(prep.checkout.checkoutPath)).toBe(false)
    expect(services.registry.get(id)).toBeUndefined()
    expect((sm as any).sessions.has('combo')).toBe(false)
  })

  test('a blocked removal changes nothing at all — the session and checkout both survive', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm, services } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'owner', wsRoot)
    injectSession(sm, 'sharer', wsRoot)

    const prep = await sm.prepareCheckout('owner', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    const id = prep.checkout.managedWorktreeId!
    // A second session shares the worktree, so removal is blocked.
    services.worktrees.addOwner(id, 'sharer')

    const result = await sm.deleteSession('owner', { removeManagedWorktree: true })

    // The guards ran before anything was touched: nothing was deleted, and the
    // caller learns why. Previously the client removed the worktree first, so a
    // failure after that point left a session with a dangling checkout.
    expect(result.deleted).toBe(false)
    expect(result.worktreeRemoval?.blocked).toBe(true)
    expect(existsSync(prep.checkout.checkoutPath)).toBe(true)
    expect((sm as any).sessions.has('owner')).toBe(true)
    expect(services.registry.get(id)!.ownerSessionIds).toContain('owner')
  })

  test('uncommitted work blocks removal unless the destructive choice is confirmed', async () => {
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
    writeFileSync(join(prep.checkout.checkoutPath, 'scratch.txt'), 'unsaved work\n')

    const unconfirmed = await sm.deleteSession('dirty', { removeManagedWorktree: true })
    expect(unconfirmed.deleted).toBe(false)
    expect(unconfirmed.worktreeRemoval?.blocked).toBe(true)
    expect(existsSync(prep.checkout.checkoutPath)).toBe(true)

    const confirmed = await sm.deleteSession('dirty', {
      removeManagedWorktree: true,
      forceWorktreeRemoval: true,
    })
    expect(confirmed.deleted).toBe(true)
    expect(confirmed.worktreeRemoval?.removed).toBe(true)
    expect(existsSync(prep.checkout.checkoutPath)).toBe(false)
  })

  test('stops a processing agent before the checkout is inspected or removed', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm } = makeManager()
    const wsRoot = tmp()
    const managed = injectSession(sm, 'busy', wsRoot)

    const prep = await sm.prepareCheckout('busy', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })

    // A turn is in flight. The agent must be aborted while the checkout is still
    // present: aborting after removal would let the agent write files that the
    // destructive confirmation never counted.
    const order: string[] = []
    managed.isProcessing = true
    managed.agent = {
      forceAbort: () => {
        order.push(
          existsSync(prep.checkout.checkoutPath)
            ? 'forceAbort:checkout-present'
            : 'forceAbort:checkout-removed',
        )
        // Real backends clear their own flag here; the turn loop clears the
        // session-level one as it unwinds.
        managed.isProcessing = false
      },
      dispose: () => {
        order.push('dispose')
      },
    } as any

    const result = await sm.deleteSession('busy', {
      removeManagedWorktree: true,
      forceWorktreeRemoval: true,
    })

    expect(order[0]).toBe('forceAbort:checkout-present')
    expect(result.deleted).toBe(true)
    expect(result.worktreeRemoval?.removed).toBe(true)
    expect(existsSync(prep.checkout.checkoutPath)).toBe(false)
  })

  test('deleting without the removal choice still preserves the checkout', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm, services } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'keep', wsRoot)

    const prep = await sm.prepareCheckout('keep', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    const id = prep.checkout.managedWorktreeId!

    const result = await sm.deleteSession('keep')
    expect(result.deleted).toBe(true)
    expect(result.worktreeRemoval).toBeUndefined()
    expect(existsSync(prep.checkout.checkoutPath)).toBe(true)
    expect(services.registry.get(id)!.ownerSessionIds).not.toContain('keep')
  })
})

describe('SessionManager.updateWorkingDirectory — bound checkouts are authoritative', () => {
  test('rejects repointing a prepared session away from its checkout', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm } = makeManager()
    const wsRoot = tmp()
    const managed = injectSession(sm, 'bound', wsRoot)

    const prep = await sm.prepareCheckout('bound', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })

    // Without this guard the agent would edit `elsewhere` while the Changes
    // surface and every Git action stayed bound to the worktree.
    const elsewhere = tmp()
    sm.updateWorkingDirectory('bound', elsewhere)

    expect(managed.workingDirectory).toBe(prep.checkout.checkoutPath)
    expect(managed.sdkCwd).toBe(prep.workingDirectory)
  })

  test('accepts a no-op update to the bound checkout path itself', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm } = makeManager()
    const wsRoot = tmp()
    const managed = injectSession(sm, 'noop', wsRoot)

    const prep = await sm.prepareCheckout('noop', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })

    sm.updateWorkingDirectory('noop', prep.checkout.checkoutPath)
    expect(managed.workingDirectory).toBe(prep.checkout.checkoutPath)
  })

  test('leaves sessions without a checkout free to change directory', async () => {
    const { sm } = makeManager()
    const wsRoot = tmp()
    const managed = injectSession(sm, 'free', wsRoot)

    const target = tmp()
    sm.updateWorkingDirectory('free', target)
    expect(managed.workingDirectory).toBe(target)
  })
})

describe('SessionManager.deleteSession — removeManagedWorktree is safe for any caller', () => {
  // Unattended cleanup (auto-delete of an empty session, the delete-session deep
  // link) cannot inspect the session first, so it always passes the option. A
  // session with nothing to clean up must still be deleted — a client hint must
  // never block that.
  test('deletes a session with no checkout even when removal is requested', async () => {
    const { sm } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'plain', wsRoot)

    const result = await sm.deleteSession('plain', { removeManagedWorktree: true })
    expect(result.deleted).toBe(true)
    expect(result.worktreeRemoval).toBeUndefined()
    expect((sm as any).sessions.has('plain')).toBe(false)
  })

  test('cleans up an unused managed worktree prepared but never sent to', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm, services } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'abandoned', wsRoot)

    const prep = await sm.prepareCheckout('abandoned', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    const id = prep.checkout.managedWorktreeId!

    // No force: a clean provisional checkout needs none.
    const result = await sm.deleteSession('abandoned', { removeManagedWorktree: true })

    expect(result.deleted).toBe(true)
    expect(result.worktreeRemoval?.removed).toBe(true)
    expect(existsSync(prep.checkout.checkoutPath)).toBe(false)
    expect(services.registry.get(id)).toBeUndefined()
  })

  test('keeps both the session and the checkout when the worktree holds work', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'hasWork', wsRoot)

    const prep = await sm.prepareCheckout('hasWork', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    writeFileSync(join(prep.checkout.checkoutPath, 'draft.txt'), 'not committed\n')

    // Unattended cleanup never forces, so this is blocked — and because removal
    // is blocked the session survives too, staying the route to that work
    // rather than leaving an unreachable checkout on disk.
    const result = await sm.deleteSession('hasWork', { removeManagedWorktree: true })

    expect(result.deleted).toBe(false)
    expect(result.worktreeRemoval?.blocked).toBe(true)
    expect(existsSync(prep.checkout.checkoutPath)).toBe(true)
    expect((sm as any).sessions.has('hasWork')).toBe(true)
  })

  test('does not block deletion when another session owns the worktree', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm, services } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'primary', wsRoot)
    injectSession(sm, 'secondary', wsRoot)

    const prep = await sm.prepareCheckout('primary', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    const id = prep.checkout.managedWorktreeId!
    services.worktrees.addOwner(id, 'secondary')

    // `secondary` shares the worktree but is not its recorded checkout owner in
    // its own session record, so it has nothing to remove: it is deleted and the
    // shared worktree is untouched.
    const result = await sm.deleteSession('secondary', { removeManagedWorktree: true })
    expect(result.deleted).toBe(true)
    expect(existsSync(prep.checkout.checkoutPath)).toBe(true)
    expect(services.registry.get(id)!.ownerSessionIds).toContain('primary')
  })
})

describe('SessionManager.deleteSession — removal waits for real agent quiescence', () => {
  // `forceAbort` only requests teardown. A fixed sleep was a guess: a subprocess
  // still mid-write can land files afterwards, and a forced removal would then
  // discard work no destructive confirmation ever counted.
  test('waits for the backend to report idle before removing the checkout', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm } = makeManager()
    const wsRoot = tmp()
    const managed = injectSession(sm, 'slowStop', wsRoot)

    const prep = await sm.prepareCheckout('slowStop', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })

    // The backend keeps reporting "processing" for several polls after the
    // abort, then goes idle. Removal must not happen until it does.
    let processing = true
    let pollsWhileProcessing = 0
    const observed: string[] = []
    managed.isProcessing = true
    managed.agent = {
      forceAbort: () => {},
      dispose: () => {},
      isProcessing: () => {
        if (processing) {
          pollsWhileProcessing += 1
          if (pollsWhileProcessing >= 3) {
            processing = false
            // The turn loop unwinding is what clears the session-level flag.
            managed.isProcessing = false
            observed.push(
              existsSync(prep.checkout.checkoutPath) ? 'idle:present' : 'idle:already-removed',
            )
          }
        }
        return processing
      },
    } as any

    const result = await sm.deleteSession('slowStop', {
      removeManagedWorktree: true,
      forceWorktreeRemoval: true,
    })

    // It polled rather than assuming, and the checkout was still intact for the
    // whole time the backend claimed to be busy.
    expect(pollsWhileProcessing).toBeGreaterThanOrEqual(3)
    expect(observed).toEqual(['idle:present'])
    expect(result.deleted).toBe(true)
    expect(result.worktreeRemoval?.removed).toBe(true)
    expect(existsSync(prep.checkout.checkoutPath)).toBe(false)
  })

  test('refuses removal — and the deletion — when the agent never stops', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm } = makeManager()
    const wsRoot = tmp()
    const managed = injectSession(sm, 'wedged', wsRoot)

    const prep = await sm.prepareCheckout('wedged', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })

    managed.isProcessing = true
    managed.agent = {
      forceAbort: () => {},
      dispose: () => {},
      isProcessing: () => true,
    } as any

    const result = await (sm as any).deleteSession(
      'wedged',
      { removeManagedWorktree: true, forceWorktreeRemoval: true },
    )

    // A wedged backend must never let a force removal race it. Nothing is
    // deleted, so the session stays and can be deleted again — without the
    // removal option it never touches the checkout at all.
    expect(result.deleted).toBe(false)
    expect(result.worktreeRemoval?.blocked).toBe(true)
    expect(result.worktreeRemoval?.blockedReason).toContain('has not finished stopping')
    expect(existsSync(prep.checkout.checkoutPath)).toBe(true)
    expect((sm as any).sessions.has('wedged')).toBe(true)

    const plain = await sm.deleteSession('wedged')
    expect(plain.deleted).toBe(true)
    expect(existsSync(prep.checkout.checkoutPath)).toBe(true)
  }, 20000)
})

describe('SessionManager.deleteSession — the backend flag alone cannot wave removal through', () => {
  // `forceAbort` synchronously clears the state `isProcessing()` reads on both
  // backends (ClaudeAgent nulls `currentQuery`, PiAgent sets `_isProcessing =
  // false`), so it reports idle the instant the abort is requested. If that were
  // the barrier, removal would proceed while the turn was still unwinding.
  test('keeps waiting while the turn is unwinding even though the backend claims idle', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm } = makeManager()
    const wsRoot = tmp()
    const managed = injectSession(sm, 'abortLies', wsRoot)

    const prep = await sm.prepareCheckout('abortLies', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })

    const observed: string[] = []
    managed.isProcessing = true
    managed.agent = {
      // Mirrors real backend behaviour: idle immediately on abort.
      forceAbort: () => {},
      dispose: () => {},
      isProcessing: () => false,
    } as any

    // The turn loop finishes a little later, as `onProcessingStopped` would.
    setTimeout(() => {
      observed.push(existsSync(prep.checkout.checkoutPath) ? 'unwound:present' : 'unwound:removed')
      managed.isProcessing = false
    }, 400)

    const result = await sm.deleteSession('abortLies', {
      removeManagedWorktree: true,
      forceWorktreeRemoval: true,
    })

    // The checkout must still have been intact when the turn finally unwound —
    // proof the wait outlasted the backend's immediate "idle".
    expect(observed).toEqual(['unwound:present'])
    expect(result.deleted).toBe(true)
    expect(result.worktreeRemoval?.removed).toBe(true)
  })
})
