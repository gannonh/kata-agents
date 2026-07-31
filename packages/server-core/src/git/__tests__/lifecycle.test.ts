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
import { describe, test, expect, afterEach, beforeEach, jest } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SessionManager, createManagedSession } from '../../sessions/SessionManager'
import { createGitServices } from '../index'
import { runGit } from '../command-runner'
import type { WorktreeRemovalRisk } from '@kata-sh/shared/protocol'
import { listSessions as listStoredSessions } from '@kata-sh/shared/sessions'
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

function confirmationFor(risk: WorktreeRemovalRisk) {
  return {
    uncommittedFileCount: risk.uncommittedFileCount,
    unpushedCommitCount: risk.unpushedCommitCount,
    branchHasUniqueWork: risk.branchHasUniqueWork,
    confirmationFingerprint: risk.confirmationFingerprint,
  }
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
  test('cleanup failures cannot interrupt a completed deletion transaction', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm } = makeManager()
    const wsRoot = tmp()
    const managed = injectSession(sm, 'cleanup-throws', wsRoot)

    const prep = await sm.prepareCheckout('cleanup-throws', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    ;(sm as any).getBrowserPaneManagerForSession = () => ({
      destroyForSession: () => {
        throw new Error('injected browser cleanup failure')
      },
    })
    managed.agent = {
      quiesceForTeardown: async () => {},
      dispose: () => {
        throw new Error('injected agent cleanup failure')
      },
    } as any

    const result = await sm.deleteSession('cleanup-throws', {
      removeManagedWorktree: true,
    })

    expect(result.deleted).toBe(true)
    expect(result.worktreeRemoval?.removed).toBe(true)
    expect(existsSync(prep.checkout.checkoutPath)).toBe(false)
    expect((sm as any).sessions.has('cleanup-throws')).toBe(false)
    expect(existsSync(join(wsRoot, 'sessions', 'cleanup-throws'))).toBe(false)
    const transactionRoot = join(wsRoot, '.kata-session-deletions')
    expect(
      !existsSync(transactionRoot) || readdirSync(transactionRoot).length === 0,
    ).toBe(true)
  })

  test('authoritatively removes the checkout while the session still exists', async () => {
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
    const originalRemove = services.worktrees.removeWorktree.bind(services.worktrees)
    let sessionPresentAtRemoval = false
    services.worktrees.removeWorktree = (async (...args: Parameters<typeof originalRemove>) => {
      sessionPresentAtRemoval = (sm as any).sessions.has('combo')
      return originalRemove(...args)
    }) as typeof services.worktrees.removeWorktree

    const result = await sm.deleteSession('combo', { removeManagedWorktree: true })

    expect(sessionPresentAtRemoval).toBe(true)
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

  test('a session-storage staging failure blocks checkout removal and preserves the session', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm, services } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'storage-failure', wsRoot)

    const prep = await sm.prepareCheckout('storage-failure', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    let removalCalled = false
    const originalRemove = services.worktrees.removeWorktree.bind(services.worktrees)
    services.worktrees.removeWorktree = (async (...args: Parameters<typeof originalRemove>) => {
      removalCalled = true
      return originalRemove(...args)
    }) as typeof services.worktrees.removeWorktree
    ;(sm as any).stageSessionStorageForDeletion = async () => {
      throw new Error('injected storage failure')
    }

    const result = await sm.deleteSession('storage-failure', {
      removeManagedWorktree: true,
    })

    expect(result.deleted).toBe(false)
    expect(result.worktreeRemoval?.blockedReason).toContain('staged for safe deletion')
    expect(removalCalled).toBe(false)
    expect(existsSync(prep.checkout.checkoutPath)).toBe(true)
    expect((sm as any).sessions.has('storage-failure')).toBe(true)
  })

  test('startup recovery restores a staged session when checkout removal did not complete', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'recover-staged', wsRoot)

    const prep = await sm.prepareCheckout('recover-staged', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    const originalPath = join(wsRoot, 'sessions', 'recover-staged')
    const staged = await (sm as any).stageSessionStorageForDeletion(
      wsRoot,
      'recover-staged',
      prep.checkout.managedWorktreeId,
    )
    expect(existsSync(originalPath)).toBe(false)
    expect(listStoredSessions(wsRoot).some(session => session.id === 'recover-staged')).toBe(false)

    ;(sm as any).recoverStagedSessionDeletions(wsRoot)

    expect(existsSync(originalPath)).toBe(true)
    expect(existsSync(staged.transactionPath)).toBe(false)
    expect(listStoredSessions(wsRoot).some(session => session.id === 'recover-staged')).toBe(true)
  })

  test('a leftover finalized transaction cannot resurrect a session after checkout removal', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm, services } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'purge-staged', wsRoot)

    const prep = await sm.prepareCheckout('purge-staged', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    const id = prep.checkout.managedWorktreeId!
    const staged = await (sm as any).stageSessionStorageForDeletion(
      wsRoot,
      'purge-staged',
      id,
    )
    services.registry.remove(id)

    expect(listStoredSessions(wsRoot).some(session => session.id === 'purge-staged')).toBe(false)
    ;(sm as any).recoverStagedSessionDeletions(wsRoot)

    expect(existsSync(staged.transactionPath)).toBe(false)
    expect(listStoredSessions(wsRoot).some(session => session.id === 'purge-staged')).toBe(false)
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

    const risk = await sm.inspectManagedWorktreeRemoval('dirty')
    const missingConfirmation = await sm.deleteSession('dirty', {
      removeManagedWorktree: true,
      forceWorktreeRemoval: true,
    })
    expect(missingConfirmation.deleted).toBe(false)
    expect(missingConfirmation.worktreeRemoval?.blockedReason).toContain('confirmation is missing')
    expect(existsSync(prep.checkout.checkoutPath)).toBe(true)

    const confirmed = await sm.deleteSession('dirty', {
      removeManagedWorktree: true,
      forceWorktreeRemoval: true,
      worktreeRemovalConfirmation: confirmationFor(risk),
    })
    expect(confirmed.deleted).toBe(true)
    expect(confirmed.worktreeRemoval?.removed).toBe(true)
    expect(existsSync(prep.checkout.checkoutPath)).toBe(false)
  })

  test('rejects destructive removal when work appears after its confirmation was shown', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'stale-confirmation', wsRoot)

    const prep = await sm.prepareCheckout('stale-confirmation', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    writeFileSync(join(prep.checkout.checkoutPath, 'shown-to-user.txt'), 'first file\n')

    // This is the snapshot displayed by DeleteSessionDialog. The checkout then
    // changes before the delete request reaches the server.
    const displayedRisk = await sm.inspectManagedWorktreeRemoval('stale-confirmation')
    expect(displayedRisk.uncommittedFileCount).toBe(1)
    writeFileSync(join(prep.checkout.checkoutPath, 'appeared-later.txt'), 'second file\n')

    const result = await sm.deleteSession('stale-confirmation', {
      removeManagedWorktree: true,
      forceWorktreeRemoval: true,
      worktreeRemovalConfirmation: confirmationFor(displayedRisk),
    })

    // A force flag is only authorization for the exact displayed summary. New
    // work leaves both the session and checkout intact for a fresh inspection.
    expect(result.deleted).toBe(false)
    expect(result.worktreeRemoval?.blocked).toBe(true)
    expect(result.worktreeRemoval?.blockedReason).toContain('changed after')
    expect(existsSync(prep.checkout.checkoutPath)).toBe(true)
    expect((sm as any).sessions.has('stale-confirmation')).toBe(true)
  })

  test('rejects destructive removal when different work replaces the confirmed work at the same counts', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'substituted-confirmation', wsRoot)

    const prep = await sm.prepareCheckout('substituted-confirmation', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    const inspectedPath = join(prep.checkout.checkoutPath, 'inspected.txt')
    writeFileSync(inspectedPath, 'work the user inspected\n')

    const displayedRisk = await sm.inspectManagedWorktreeRemoval('substituted-confirmation')
    expect(displayedRisk.uncommittedFileCount).toBe(1)

    unlinkSync(inspectedPath)
    writeFileSync(
      join(prep.checkout.checkoutPath, 'replacement-secret.txt'),
      'different work with the same aggregate count\n',
    )

    const result = await sm.deleteSession('substituted-confirmation', {
      removeManagedWorktree: true,
      forceWorktreeRemoval: true,
      worktreeRemovalConfirmation: confirmationFor(displayedRisk),
    })

    expect(result.deleted).toBe(false)
    expect(result.worktreeRemoval?.blocked).toBe(true)
    expect(result.worktreeRemoval?.blockedReason).toContain('changed after')
    expect(existsSync(prep.checkout.checkoutPath)).toBe(true)
    expect((sm as any).sessions.has('substituted-confirmation')).toBe(true)
  })

  test('rejects destructive removal when staged content changes but the worktree file and counts do not', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'substituted-index', wsRoot)

    const prep = await sm.prepareCheckout('substituted-index', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    const checkoutPath = prep.checkout.checkoutPath
    writeFileSync(join(checkoutPath, 'README.md'), 'first staged content\n')
    await runGit(['add', '--', 'README.md'], { cwd: checkoutPath })
    writeFileSync(join(checkoutPath, 'README.md'), 'unchanged working-tree content\n')

    const displayedRisk = await sm.inspectManagedWorktreeRemoval('substituted-index')
    expect(displayedRisk.uncommittedFileCount).toBe(1)

    const replacementObject = await runGit(['hash-object', '-w', '--stdin'], {
      cwd: checkoutPath,
      input: 'replacement staged content\n',
    })
    await runGit(
      ['update-index', '--cacheinfo', `100644,${replacementObject.stdout.trim()},README.md`],
      { cwd: checkoutPath },
    )

    const result = await sm.deleteSession('substituted-index', {
      removeManagedWorktree: true,
      forceWorktreeRemoval: true,
      worktreeRemovalConfirmation: confirmationFor(displayedRisk),
    })

    expect(result.deleted).toBe(false)
    expect(result.worktreeRemoval?.blocked).toBe(true)
    expect(result.worktreeRemoval?.blockedReason).toContain('changed after')
    expect(existsSync(join(checkoutPath, 'README.md'))).toBe(true)
    expect((sm as any).sessions.has('substituted-index')).toBe(true)
  })

  test('rejects destructive removal when a different unique commit replaces the confirmed commit', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'substituted-commit', wsRoot)

    const prep = await sm.prepareCheckout('substituted-commit', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    writeFileSync(join(prep.checkout.checkoutPath, 'first.txt'), 'first unique commit\n')
    await runGit(['add', '--', 'first.txt'], { cwd: prep.checkout.checkoutPath })
    await runGit(['commit', '-m', 'first unique commit'], { cwd: prep.checkout.checkoutPath })

    const displayedRisk = await sm.inspectManagedWorktreeRemoval('substituted-commit')
    expect(displayedRisk.unpushedCommitCount).toBe(1)

    await runGit(['reset', '--hard', 'main'], { cwd: prep.checkout.checkoutPath })
    writeFileSync(join(prep.checkout.checkoutPath, 'replacement.txt'), 'replacement commit\n')
    await runGit(['add', '--', 'replacement.txt'], { cwd: prep.checkout.checkoutPath })
    await runGit(['commit', '-m', 'replacement unique commit'], {
      cwd: prep.checkout.checkoutPath,
    })

    const result = await sm.deleteSession('substituted-commit', {
      removeManagedWorktree: true,
      forceWorktreeRemoval: true,
      worktreeRemovalConfirmation: confirmationFor(displayedRisk),
    })

    expect(result.deleted).toBe(false)
    expect(result.worktreeRemoval?.blocked).toBe(true)
    expect(result.worktreeRemoval?.blockedReason).toContain('changed after')
    expect(existsSync(prep.checkout.checkoutPath)).toBe(true)
    expect((sm as any).sessions.has('substituted-commit')).toBe(true)
  })

  test('rejects destructive removal when the checkout branch changes after confirmation', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'changed-branch', wsRoot)

    const prep = await sm.prepareCheckout('changed-branch', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    writeFileSync(join(prep.checkout.checkoutPath, 'inspected.txt'), 'confirmed work\n')
    const displayedRisk = await sm.inspectManagedWorktreeRemoval('changed-branch')

    await runGit(['switch', '-c', 'external-replacement-branch'], {
      cwd: prep.checkout.checkoutPath,
    })

    const result = await sm.deleteSession('changed-branch', {
      removeManagedWorktree: true,
      forceWorktreeRemoval: true,
      worktreeRemovalConfirmation: confirmationFor(displayedRisk),
    })

    expect(result.deleted).toBe(false)
    expect(result.worktreeRemoval?.blocked).toBe(true)
    expect(existsSync(prep.checkout.checkoutPath)).toBe(true)
    expect((sm as any).sessions.has('changed-branch')).toBe(true)
  })

  test('rejects destructive removal when HEAD changes but the unique-work count remains zero', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'changed-head', wsRoot)

    const prep = await sm.prepareCheckout('changed-head', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    const checkoutPath = prep.checkout.checkoutPath
    const displayedRisk = await sm.inspectManagedWorktreeRemoval('changed-head')
    expect(displayedRisk.unpushedCommitCount).toBe(0)

    writeFileSync(join(checkoutPath, 'replacement-head.txt'), 'new checkout identity\n')
    await runGit(['add', '--', 'replacement-head.txt'], { cwd: checkoutPath })
    await runGit(['commit', '-m', 'replace checkout head'], { cwd: checkoutPath })
    const replacementHead = await runGit(['rev-parse', 'HEAD'], { cwd: checkoutPath })
    await runGit(['update-ref', 'refs/heads/main', replacementHead.stdout.trim()], {
      cwd: repo,
    })

    const currentRisk = await sm.inspectManagedWorktreeRemoval('changed-head')
    expect(currentRisk.unpushedCommitCount).toBe(0)
    expect(currentRisk.uncommittedFileCount).toBe(0)

    const result = await sm.deleteSession('changed-head', {
      removeManagedWorktree: true,
      forceWorktreeRemoval: true,
      worktreeRemovalConfirmation: confirmationFor(displayedRisk),
    })

    expect(result.deleted).toBe(false)
    expect(result.worktreeRemoval?.blocked).toBe(true)
    expect(result.worktreeRemoval?.blockedReason).toContain('changed after')
    expect(existsSync(checkoutPath)).toBe(true)
    expect((sm as any).sessions.has('changed-head')).toBe(true)
  })

  test('has no dry-run gap that can delete the session after a late checkout change', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm, services } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'late-change', wsRoot)

    const prep = await sm.prepareCheckout('late-change', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    const checkoutPath = prep.checkout.checkoutPath
    writeFileSync(join(checkoutPath, 'displayed.txt'), 'displayed work\n')
    const displayedRisk = await sm.inspectManagedWorktreeRemoval('late-change')

    const originalRemove = services.worktrees.removeWorktree.bind(services.worktrees)
    let removalCalls = 0
    services.worktrees.removeWorktree = (async (...args: Parameters<typeof originalRemove>) => {
      removalCalls += 1
      writeFileSync(join(checkoutPath, 'late-write.txt'), 'arrived at authoritative removal\n')
      return originalRemove(...args)
    }) as typeof services.worktrees.removeWorktree

    const result = await sm.deleteSession('late-change', {
      removeManagedWorktree: true,
      forceWorktreeRemoval: true,
      worktreeRemovalConfirmation: confirmationFor(displayedRisk),
    })

    expect(removalCalls).toBe(1)
    expect(result.deleted).toBe(false)
    expect(result.worktreeRemoval?.blocked).toBe(true)
    expect(result.worktreeRemoval?.blockedReason).toContain('changed after')
    expect(existsSync(checkoutPath)).toBe(true)
    expect((sm as any).sessions.has('late-change')).toBe(true)
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
      quiesceForTeardown: async () => {
        order.push(
          existsSync(prep.checkout.checkoutPath)
            ? 'quiesce:checkout-present'
            : 'quiesce:checkout-removed',
        )
        managed.isProcessing = false
      },
      dispose: () => {
        order.push('dispose')
      },
    } as any

    const result = await sm.deleteSession('busy', {
      removeManagedWorktree: true,
    })

    expect(order[0]).toBe('quiesce:checkout-present')
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

describe('SessionManager.deleteSession — backend quiescence contract', () => {
  test('waits for backend teardown before inspecting or removing the checkout', async () => {
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

    let release!: () => void
    const teardown = new Promise<void>((resolve) => { release = resolve })
    let quiesceCalled = false
    managed.agent = {
      quiesceForTeardown: async () => {
        quiesceCalled = true
        await teardown
      },
      dispose: () => {},
    } as any

    const deletion = sm.deleteSession('slowStop', { removeManagedWorktree: true })
    await Promise.resolve()
    await Promise.resolve()

    expect(quiesceCalled).toBe(true)
    expect(existsSync(prep.checkout.checkoutPath)).toBe(true)

    release()
    const result = await deletion
    expect(result.deleted).toBe(true)
    expect(result.worktreeRemoval?.removed).toBe(true)
    expect(existsSync(prep.checkout.checkoutPath)).toBe(false)
  })

  test('calls teardown for an idle agent that still owns a persistent checkout runtime', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm } = makeManager()
    const wsRoot = tmp()
    const managed = injectSession(sm, 'idlePi', wsRoot)
    const prep = await sm.prepareCheckout('idlePi', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })

    let quiesceCalls = 0
    managed.agent = {
      quiesceForTeardown: async () => { quiesceCalls += 1 },
      dispose: () => {},
    } as any

    const result = await sm.deleteSession('idlePi', { removeManagedWorktree: true })
    expect(quiesceCalls).toBe(1)
    expect(result.deleted).toBe(true)
    expect(existsSync(prep.checkout.checkoutPath)).toBe(false)
  })

  test('blocks managed removal on teardown rejection but still permits plain deletion', async () => {
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
      quiesceForTeardown: async () => { throw new Error('exit unconfirmed') },
      dispose: () => {},
    } as any

    const blocked = await sm.deleteSession('wedged', { removeManagedWorktree: true })
    expect(blocked.deleted).toBe(false)
    expect(blocked.worktreeRemoval?.blocked).toBe(true)
    expect(blocked.worktreeRemoval?.blockedReason).toContain('has not finished stopping')
    expect(existsSync(prep.checkout.checkoutPath)).toBe(true)
    expect((sm as any).sessions.has('wedged')).toBe(true)

    const plain = await sm.deleteSession('wedged')
    expect(plain.deleted).toBe(true)
    expect(existsSync(prep.checkout.checkoutPath)).toBe(true)
  })

  test('uses a bounded timeout when backend teardown never settles', async () => {
    jest.useFakeTimers()
    try {
      const { sm } = makeManager()
      const wsRoot = tmp()
      const managed = injectSession(sm, 'timeout', wsRoot)
      managed.agent = {
        quiesceForTeardown: () => new Promise<void>(() => {}),
      } as any

      const waiting = (sm as any).awaitAgentTeardown('timeout', managed, 50)
      jest.advanceTimersByTime(50)
      await expect(waiting).resolves.toBe(false)
    } finally {
      jest.useRealTimers()
    }
  })

  test('holds the destructive inspection until the final write is inside the quiesced boundary', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm } = makeManager()
    const wsRoot = tmp()
    const managed = injectSession(sm, 'lastWrite', wsRoot)
    const prep = await sm.prepareCheckout('lastWrite', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    const displayedRisk = await sm.inspectManagedWorktreeRemoval('lastWrite')

    let release!: () => void
    const teardown = new Promise<void>((resolve) => { release = resolve })
    managed.agent = {
      quiesceForTeardown: async () => { await teardown },
      dispose: () => {},
    } as any

    const deletion = sm.deleteSession('lastWrite', {
      removeManagedWorktree: true,
      forceWorktreeRemoval: true,
      worktreeRemovalConfirmation: confirmationFor(displayedRisk),
    })
    await Promise.resolve()
    await Promise.resolve()
    writeFileSync(join(prep.checkout.checkoutPath, 'last-write.txt'), 'completed before teardown\n')
    release()

    const result = await deletion
    expect(result.deleted).toBe(false)
    expect(result.worktreeRemoval?.blocked).toBe(true)
    expect(result.worktreeRemoval?.blockedReason).toContain('changed after')
    expect(existsSync(join(prep.checkout.checkoutPath, 'last-write.txt'))).toBe(true)
    expect((sm as any).sessions.has('lastWrite')).toBe(true)
  })
})

describe('SessionManager.deleteSession — a destructive confirmation is not blanket authorization', () => {
  // `forceWorktreeRemoval` alone would license discarding whatever the server
  // finds at removal time. The user only ever consented to the exact work the
  // dialog displayed, so any later change must require a fresh confirmation.
  test('refuses when the checkout gained uncommitted files since the confirmation', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'stale', wsRoot)

    const prep = await sm.prepareCheckout('stale', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    // The user saw one file and confirmed. A second appeared afterwards.
    writeFileSync(join(prep.checkout.checkoutPath, 'seen.txt'), 'shown in the dialog\n')
    const displayedRisk = await sm.inspectManagedWorktreeRemoval('stale')
    writeFileSync(join(prep.checkout.checkoutPath, 'unseen.txt'), 'appeared after the dialog\n')

    const result = await sm.deleteSession('stale', {
      removeManagedWorktree: true,
      forceWorktreeRemoval: true,
      worktreeRemovalConfirmation: confirmationFor(displayedRisk),
    })

    expect(result.deleted).toBe(false)
    expect(result.worktreeRemoval?.blocked).toBe(true)
    expect(result.worktreeRemoval?.blockedReason).toContain('changed after')
    // Nothing destroyed, including the file the user never saw.
    expect(existsSync(join(prep.checkout.checkoutPath, 'unseen.txt'))).toBe(true)
    expect(existsSync(prep.checkout.checkoutPath)).toBe(true)
  })

  test('proceeds when the confirmation still matches the checkout', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'fresh', wsRoot)

    const prep = await sm.prepareCheckout('fresh', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    writeFileSync(join(prep.checkout.checkoutPath, 'seen.txt'), 'shown in the dialog\n')
    const displayedRisk = await sm.inspectManagedWorktreeRemoval('fresh')

    const result = await sm.deleteSession('fresh', {
      removeManagedWorktree: true,
      forceWorktreeRemoval: true,
      worktreeRemovalConfirmation: confirmationFor(displayedRisk),
    })

    expect(result.deleted).toBe(true)
    expect(result.worktreeRemoval?.removed).toBe(true)
    expect(existsSync(prep.checkout.checkoutPath)).toBe(false)
  })

  test('refuses when work disappears after the confirmation', async () => {
    const repo = tmp()
    await initRepo(repo)
    const { sm } = makeManager()
    const wsRoot = tmp()
    injectSession(sm, 'shrank', wsRoot)

    const prep = await sm.prepareCheckout('shrank', {
      mode: 'managed-worktree',
      workingDirectory: repo,
      baseRef: 'main',
    })
    const keptPath = join(prep.checkout.checkoutPath, 'kept.txt')
    const removedPath = join(prep.checkout.checkoutPath, 'removed-after-confirmation.txt')
    writeFileSync(keptPath, 'one file\n')
    writeFileSync(removedPath, 'second file\n')
    const displayedRisk = await sm.inspectManagedWorktreeRemoval('shrank')
    unlinkSync(removedPath)

    const result = await sm.deleteSession('shrank', {
      removeManagedWorktree: true,
      forceWorktreeRemoval: true,
      worktreeRemovalConfirmation: confirmationFor(displayedRisk),
    })

    expect(result.deleted).toBe(false)
    expect(result.worktreeRemoval?.blocked).toBe(true)
    expect(result.worktreeRemoval?.blockedReason).toContain('changed after')
    expect(existsSync(keptPath)).toBe(true)
    expect(existsSync(prep.checkout.checkoutPath)).toBe(true)
  })
})
