import { describe, test, expect, afterEach, beforeEach } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createGitServices, WorktreeLifecycleError } from '../index'
import type { GitServices } from '../index'
import type { ManagedWorktreeRecordV2 } from '@kata-sh/shared/protocol'
import { initRepo, makeTmpDir, cleanup, git, writeFile } from './test-helpers'

const cleanups: string[] = []
function tmp(): string {
  const dir = makeTmpDir('kata-lifecycle-test-')
  cleanups.push(dir)
  return dir
}
afterEach(() => {
  while (cleanups.length) cleanup(cleanups.pop()!)
})

interface Harness {
  root: string
  repo: string
  svc: GitServices
}

let harness: Harness
let activeSessions = new Set<string>()
let flaggedSessions = new Set<string>()
let quiesceResult = true

function makeHarness(limit = 15): Harness {
  const root = tmp()
  const repo = join(root, 'repo')
  const svc = createGitServices({
    worktreeRoot: join(root, 'worktrees'),
    registryPath: join(root, 'worktrees', 'registry.json'),
    snapshotsRoot: join(root, 'snapshots'),
    lockDirectory: join(root, 'locks'),
    lifecycleHooks: {
      quiesceRuntimes: async (sessionIds) => {
        if (!quiesceResult) return false
        for (const id of sessionIds) activeSessions.delete(id)
        return true
      },
      isSessionActive: (sessionId) => activeSessions.has(sessionId),
      isSessionFlagged: (sessionId) => flaggedSessions.has(sessionId),
      applyOwnerSessionState: () => undefined,
      touchSessionCheckout: () => undefined,
    },
  })
  svc.worktreeSettings.update({ materializationRoot: join(root, 'worktrees'), retentionLimit: limit })
  return { root, repo, svc }
}

beforeEach(async () => {
  activeSessions = new Set()
  flaggedSessions = new Set()
  quiesceResult = true
  harness = makeHarness()
  await initRepo(harness.repo)
  harness.svc.lifecycle.markReady()
})

async function commonDir(dir: string): Promise<string> {
  return (await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
}

async function makeManagedWorktree(
  name: string,
  owners: string[] = ['session-1'],
): Promise<ManagedWorktreeRecordV2> {
  const { repo, svc } = harness
  const branch = `kata-agent/${name}`
  const worktreePath = join(harness.root, 'worktrees', 'ws1', 'repo', `${name}-token`)
  await git(repo, ['worktree', 'add', '--no-track', '-b', branch, worktreePath, 'main'])
  const record: ManagedWorktreeRecordV2 = {
    schemaVersion: 2,
    managedWorktreeId: `repo-${'cd'.repeat(8)}-${name}`,
    workspaceId: 'ws1',
    displayName: name,
    repositoryRoot: repo,
    gitCommonDir: await commonDir(repo),
    checkoutPath: worktreePath,
    baseRef: 'main',
    expectedBranch: branch,
    materializationRoot: join(harness.root, 'worktrees'),
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    ownerSessionIds: owners,
    state: 'ready',
    policyVersion: 0,
  }
  svc.registry.upsert(record)
  for (const owner of owners) svc.pathLeases.lease(owner, worktreePath)
  return record
}

describe('readiness gate', () => {
  test('lifecycle mutations refuse before awaited reconciliation completes', async () => {
    const { svc } = harness
    const record = await makeManagedWorktree('feature-x')
    const freshSvc = createGitServices({
      worktreeRoot: join(harness.root, 'wt2'),
      registryPath: join(harness.root, 'wt2', 'registry.json'),
      snapshotsRoot: join(harness.root, 'snapshots'),
      lockDirectory: join(harness.root, 'locks'),
    })
    // Not marked ready: reconciliation has not completed.
    await expect(freshSvc.lifecycle.deleteWorktree(record.managedWorktreeId, 'x')).rejects.toMatchObject({
      code: 'LIFECYCLE_NOT_READY',
    })
    expect(freshSvc.lifecycle.isReady()).toBe(false)
    freshSvc.lifecycle.markReady()
    expect(freshSvc.lifecycle.isReady()).toBe(true)
  })
})

describe('preview', () => {
  test('names every owner with archived/active/flagged protection and a fresh fingerprint', async () => {
    const { svc } = harness
    const record = await makeManagedWorktree('feature-x', ['session-1', 'session-2'])
    writeFile(record.checkoutPath, 'work.txt', 'unsaved\n')
    activeSessions.add('session-2')

    const preview = await svc.lifecycle.preview(record.managedWorktreeId)

    expect(preview.exists).toBe(true)
    expect(preview.state).toBe('ready')
    expect(preview.owners.map((o) => o.sessionId).sort()).toEqual(['session-1', 'session-2'])
    expect(preview.owners.find((o) => o.sessionId === 'session-2')?.active).toBe(true)
    expect(preview.uncommittedFileCount).toBeGreaterThan(0)
    expect(preview.previewFingerprint).toHaveLength(64)
    expect(preview.blocked).toBe(true)
    expect(preview.blockedReason).toContain('session-2')
    expect(preview.ignoredPolicy).toEqual({ includeOnly: true, includeFileCount: 0 })
  })

  test('reports a missing record and snapshot availability', async () => {
    const { svc } = harness
    const preview = await svc.lifecycle.preview('repo-unknown')
    expect(preview.exists).toBe(false)
    expect(preview.blocked).toBe(true)

    const record = await makeManagedWorktree('feature-x')
    const deleted = await svc.lifecycle.deleteWorktree(
      record.managedWorktreeId,
      (await svc.lifecycle.preview(record.managedWorktreeId)).previewFingerprint,
    )
    expect(deleted.deleted).toBe(true)
    const after = await svc.lifecycle.preview(record.managedWorktreeId)
    expect(after.hasSnapshot).toBe(true)
    expect(after.state).toBe('snapshotted')
  })
})

describe('manual snapshot-first delete', () => {
  test('removes the checkout, retains the branch, pins a hidden ref, and keeps owners attached', async () => {
    const { repo, svc } = harness
    const record = await makeManagedWorktree('feature-x', ['session-1', 'session-2'])
    writeFile(record.checkoutPath, 'work.txt', 'precious\n')
    await git(record.checkoutPath, ['add', '.'])
    await git(record.checkoutPath, ['commit', '-m', 'unique work'])

    const preview = await svc.lifecycle.preview(record.managedWorktreeId)
    expect(preview.blocked).toBe(false)
    const result = await svc.lifecycle.deleteWorktree(record.managedWorktreeId, preview.previewFingerprint)

    expect(result.deleted).toBe(true)
    expect(result.state).toBe('snapshotted')
    const after = svc.registry.get(record.managedWorktreeId) as ManagedWorktreeRecordV2
    expect(after.state).toBe('snapshotted')
    expect(after.ownerSessionIds.sort()).toEqual(['session-1', 'session-2'])
    expect(after.snapshot).toBeTruthy()
    // Checkout gone; branch retained; hidden ref pins HEAD.
    expect(existsSync(record.checkoutPath)).toBe(false)
    expect((await git(repo, ['rev-parse', '--verify', `refs/heads/${record.expectedBranch}`])).trim()).toHaveLength(40)
    expect((await git(repo, ['rev-parse', '--verify', after.snapshot!.hiddenRef])).trim()).toBe(after.snapshot!.headOid)
    // Journal committed.
    expect(svc.journal.entries().filter((e) => e.recordId === record.managedWorktreeId).pop()?.status).toBe('committed')
  })

  test('refuses a stale preview fingerprint before any mutation', async () => {
    const { svc } = harness
    const record = await makeManagedWorktree('feature-x')
    const preview = await svc.lifecycle.preview(record.managedWorktreeId)
    // The worktree changes after the preview.
    writeFile(record.checkoutPath, 'new.txt', 'appeared after preview\n')

    const result = await svc.lifecycle.deleteWorktree(record.managedWorktreeId, preview.previewFingerprint)
    expect(result.deleted).toBe(false)
    expect(result.error).toContain('changed')
    const after = svc.registry.get(record.managedWorktreeId) as ManagedWorktreeRecordV2
    expect(after.state).toBe('ready')
    expect(existsSync(record.checkoutPath)).toBe(true)
    expect(after.snapshot).toBeUndefined()
  })

  test('blocks when an owning runtime cannot quiesce; nothing changes', async () => {
    const { svc } = harness
    const record = await makeManagedWorktree('feature-x')
    activeSessions.add('session-1')
    quiesceResult = false

    const result = await svc.lifecycle.deleteWorktree(
      record.managedWorktreeId,
      (await svc.lifecycle.preview(record.managedWorktreeId)).previewFingerprint,
    )
    expect(result.deleted).toBe(false)
    const after = svc.registry.get(record.managedWorktreeId) as ManagedWorktreeRecordV2
    expect(after.state).toBe('ready')
    expect(existsSync(record.checkoutPath)).toBe(true)
  })

  test('blocks on a foreign path lease (a live session outside the owner set)', async () => {
    const { svc } = harness
    const record = await makeManagedWorktree('feature-x', ['session-1'])
    // A session not reflected in registry owners still leases the path.
    svc.pathLeases.lease('ghost-session', record.checkoutPath)

    const result = await svc.lifecycle.deleteWorktree(
      record.managedWorktreeId,
      (await svc.lifecycle.preview(record.managedWorktreeId)).previewFingerprint,
    )
    expect(result.deleted).toBe(false)
    expect(result.error).toContain('ghost-session')
    expect(existsSync(record.checkoutPath)).toBe(true)
  })

  test('deleting an unowned record succeeds snapshot-first', async () => {
    const { svc } = harness
    const record = await makeManagedWorktree('feature-x', ['session-1'])
    svc.lifecycle.detachSession('session-1')
    expect((svc.registry.get(record.managedWorktreeId) as ManagedWorktreeRecordV2).state).toBe('unowned')

    const result = await svc.lifecycle.deleteWorktree(
      record.managedWorktreeId,
      (await svc.lifecycle.preview(record.managedWorktreeId)).previewFingerprint,
    )
    expect(result.deleted).toBe(true)
    expect(existsSync(record.checkoutPath)).toBe(false)
  })
})

describe('restore', () => {
  test('restores exact state, rebinds owners, then removes payload and hidden ref', async () => {
    const { repo, svc } = harness
    const record = await makeManagedWorktree('feature-x', ['session-1'])
    writeFile(record.checkoutPath, 'work.txt', 'staged content\n')
    await git(record.checkoutPath, ['add', 'work.txt'])
    writeFile(record.checkoutPath, 'untracked.txt', 'untracked content\n')

    const preview = await svc.lifecycle.preview(record.managedWorktreeId)
    const deleted = await svc.lifecycle.deleteWorktree(record.managedWorktreeId, preview.previewFingerprint)
    expect(deleted.deleted).toBe(true)
    const snapshotted = svc.registry.get(record.managedWorktreeId) as ManagedWorktreeRecordV2
    const snapshotId = snapshotted.snapshot!.snapshotId

    const restored = await svc.lifecycle.restoreWorktree(record.managedWorktreeId)

    expect(restored.restored).toBe(true)
    expect(restored.state).toBe('ready')
    expect(restored.checkoutPath).toBeTruthy()
    expect(restored.checkoutPath).not.toBe(record.checkoutPath)
    const after = svc.registry.get(record.managedWorktreeId) as ManagedWorktreeRecordV2
    expect(after.state).toBe('ready')
    expect(after.ownerSessionIds).toEqual(['session-1'])
    expect(after.snapshot).toBeUndefined()
    // Exact content restored: the staged projection still holds work.txt, and
    // the untracked file is back byte-for-byte.
    expect(await git(restored.checkoutPath!, ['diff', '--cached', '--name-only'])).toContain('work.txt')
    expect(existsSync(join(restored.checkoutPath!, 'untracked.txt'))).toBe(true)
    expect(readFileSync(join(restored.checkoutPath!, 'untracked.txt'), 'utf8')).toBe('untracked content\n')
    expect((await git(restored.checkoutPath!, ['symbolic-ref', '--short', 'HEAD'])).trim()).toBe(record.expectedBranch)
    // Payload and hidden ref removed only after the commit.
    expect(existsSync(join(harness.root, 'snapshots', snapshotId))).toBe(false)
    const ref = await git(repo, ['rev-parse', '--verify', '--quiet', `refs/kata/worktree-snapshots/${snapshotId}`]).catch(() => '')
    expect(ref.trim()).toBe('')
  })

  test('a differently advanced branch refuses restore and records restore-failed with payload retained', async () => {
    const { repo, svc } = harness
    const record = await makeManagedWorktree('feature-x')
    const preview = await svc.lifecycle.preview(record.managedWorktreeId)
    await svc.lifecycle.deleteWorktree(record.managedWorktreeId, preview.previewFingerprint)
    const snapshotted = svc.registry.get(record.managedWorktreeId) as ManagedWorktreeRecordV2

    // Advance the branch after capture.
    writeFile(repo, 'new.txt', 'new work\n')
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '-m', 'advance'])
    await git(repo, ['branch', '-f', record.expectedBranch, 'HEAD'])

    const restored = await svc.lifecycle.restoreWorktree(record.managedWorktreeId)
    expect(restored.restored).toBe(false)
    expect(restored.state).toBe('restore-failed')
    const after = svc.registry.get(record.managedWorktreeId) as ManagedWorktreeRecordV2
    expect(after.state).toBe('restore-failed')
    expect(after.lastError).toBeTruthy()
    // Payload + ref retained for retry.
    expect(existsSync(join(after.snapshot!.payloadPath, 'manifest.json'))).toBe(true)
    await svc.snapshots.verifyHiddenRef(repo, after.snapshot!)
  })

  test('retry re-runs a restore-failed step', async () => {
    const { repo, svc } = harness
    const record = await makeManagedWorktree('feature-x')
    const preview = await svc.lifecycle.preview(record.managedWorktreeId)
    await svc.lifecycle.deleteWorktree(record.managedWorktreeId, preview.previewFingerprint)
    writeFile(repo, 'new.txt', 'new work\n')
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '-m', 'advance'])
    await git(repo, ['branch', '-f', record.expectedBranch, 'HEAD'])

    // The first restore fails (branch advanced); the record becomes restore-failed.
    const failed = await svc.lifecycle.restoreWorktree(record.managedWorktreeId)
    expect(failed.state).toBe('restore-failed')
    // Retry re-runs the same failed step and fails again while the branch is advanced.
    expect((await svc.lifecycle.retryWorktree(record.managedWorktreeId)).state).toBe('restore-failed')
    // Restore the branch to the captured OID; retry now succeeds.
    const snapshotted = svc.registry.get(record.managedWorktreeId) as ManagedWorktreeRecordV2
    await git(repo, ['branch', '-f', record.expectedBranch, snapshotted.snapshot!.headOid])
    const retried = await svc.lifecycle.retryWorktree(record.managedWorktreeId)
    expect(retried.retried).toBe(true)
    expect(retried.state).toBe('ready')
  })
})

describe('permanent delete', () => {
  test('refuses while owners remain; succeeds with zero owners and retains the branch', async () => {
    const { repo, svc } = harness
    const record = await makeManagedWorktree('feature-x', ['session-1'])
    await svc.lifecycle.deleteWorktree(
      record.managedWorktreeId,
      (await svc.lifecycle.preview(record.managedWorktreeId)).previewFingerprint,
    )

    await expect(svc.lifecycle.permanentDelete(record.managedWorktreeId, true)).rejects.toMatchObject({
      code: 'LIFECYCLE_OWNERS_PRESENT',
    })

    // Owners detach (session deletion after restore is impossible here, so the
    // owners are dropped by their session-delete path).
    svc.lifecycle.detachSession('session-1')
    const result = await svc.lifecycle.permanentDelete(record.managedWorktreeId, true)
    expect(result.deleted).toBe(true)
    expect(svc.registry.get(record.managedWorktreeId)).toBeUndefined()
    expect((await git(repo, ['rev-parse', '--verify', `refs/heads/${record.expectedBranch}`])).trim()).toHaveLength(40)
  })

  test('requires the irreversibility confirmation', async () => {
    const { svc } = harness
    const record = await makeManagedWorktree('feature-x')
    await svc.lifecycle.deleteWorktree(
      record.managedWorktreeId,
      (await svc.lifecycle.preview(record.managedWorktreeId)).previewFingerprint,
    )
    svc.lifecycle.detachSession('session-1')
    await expect(svc.lifecycle.permanentDelete(record.managedWorktreeId, false)).rejects.toMatchObject({
      code: 'LIFECYCLE_FAILED',
    })
  })
})

describe('archive / unarchive', () => {
  test('one archived owner of a shared worktree does not trigger cleanup', async () => {
    const { svc } = harness
    const record = await makeManagedWorktree('feature-x', ['session-1', 'session-2'])
    const result = await svc.lifecycle.setArchived(record.managedWorktreeId, 'session-1', true)
    expect(result.cleanupEnqueued).toBe(false)
    const after = svc.registry.get(record.managedWorktreeId) as ManagedWorktreeRecordV2
    expect(after.archivedOwnerSessionIds).toEqual(['session-1'])
    expect(existsSync(record.checkoutPath)).toBe(true)
  })

  test('final-owner archive triggers cleanup only when all owners are archived and none protected', async () => {
    const { svc } = harness
    const record = await makeManagedWorktree('feature-x', ['session-1', 'session-2'])
    await svc.lifecycle.setArchived(record.managedWorktreeId, 'session-1', true)
    activeSessions.add('session-2')
    const result = await svc.lifecycle.setArchived(record.managedWorktreeId, 'session-2', true)
    // Active owner: cleanup is not enqueued.
    expect(result.cleanupEnqueued).toBe(false)
    activeSessions.delete('session-2')

    const second = await svc.lifecycle.setArchived(record.managedWorktreeId, 'session-2', false)
    expect(second.cleanupEnqueued).toBe(false)
    await svc.lifecycle.setArchived(record.managedWorktreeId, 'session-2', true)
    // Both archived, none active: the sweep runs and removes the checkout.
    const after = svc.registry.get(record.managedWorktreeId) as ManagedWorktreeRecordV2
    expect(after.state).toBe('snapshotted')
    expect(existsSync(record.checkoutPath)).toBe(false)
  })

  test('unarchive updates lastUsedAt and invalidates archive preflight (fingerprint binds archived owners)', async () => {
    const { svc } = harness
    const record = await makeManagedWorktree('feature-x', ['session-1', 'session-2'])
    await svc.lifecycle.setArchived(record.managedWorktreeId, 'session-1', true)
    // Archive does not bump activity; UNARCHIVE does (spec: lastUsedAt updates
    // on creation, restore, owner attach, unarchive, accepted message).
    const archived = svc.registry.get(record.managedWorktreeId) as ManagedWorktreeRecordV2
    expect(archived.lastUsedAt).toBe(record.lastUsedAt)
    await new Promise((resolve) => setTimeout(resolve, 5))
    await svc.lifecycle.setArchived(record.managedWorktreeId, 'session-1', false)
    const after = svc.registry.get(record.managedWorktreeId) as ManagedWorktreeRecordV2
    expect(after.lastUsedAt).toBeGreaterThan(record.lastUsedAt)

    // The preview fingerprint binds the archived-owner set: archive again,
    // preview, unarchive, then delete with the stale fingerprint is refused.
    await svc.lifecycle.setArchived(record.managedWorktreeId, 'session-1', true)
    const preview = await svc.lifecycle.preview(record.managedWorktreeId)
    await svc.lifecycle.setArchived(record.managedWorktreeId, 'session-1', false)
    const result = await svc.lifecycle.deleteWorktree(record.managedWorktreeId, preview.previewFingerprint)
    expect(result.deleted).toBe(false)
  })
})

describe('retention sweep (LRU)', () => {
  test('removes the least-recently-used idle worktree beyond the limit, ordered by lastUsedAt then createdAt then id', async () => {
    harness = makeHarness(2)
    await initRepo(harness.repo)
    harness.svc.lifecycle.markReady()
    const svc = harness.svc

    const first = await makeManagedWorktree('first', ['s1'])
    const second = await makeManagedWorktree('second', ['s2'])
    const third = await makeManagedWorktree('third', ['s3'])
    // Activity: first used most recently, second oldest.
    svc.registry.updateLastUsedAt(first.managedWorktreeId, Date.now() + 1000)
    svc.registry.updateLastUsedAt(second.managedWorktreeId, Date.now() - 1000)

    const result = await svc.lifecycle.runCleanupSweep()

    expect(result.outcome).toBe('succeeded')
    expect(result.removedWorktreeId).toBe(second.managedWorktreeId)
    expect(existsSync(second.checkoutPath)).toBe(false)
    expect(existsSync(first.checkoutPath)).toBe(true)
    expect(existsSync(third.checkoutPath)).toBe(true)
    expect((svc.registry.get(second.managedWorktreeId) as ManagedWorktreeRecordV2).state).toBe('snapshotted')
    void third
  })

  test('skips protected (active/flagged) candidates and continues past candidate-specific blocks', async () => {
    harness = makeHarness(1)
    await initRepo(harness.repo)
    harness.svc.lifecycle.markReady()
    const svc = harness.svc

    const protectedRec = await makeManagedWorktree('protected', ['s1'])
    const idleRec = await makeManagedWorktree('idle', ['s2'])
    activeSessions.add('s1')

    const result = await svc.lifecycle.runCleanupSweep()
    expect(result.removedWorktreeId).toBe(idleRec.managedWorktreeId)
    expect(existsSync(protectedRec.checkoutPath)).toBe(true)
  })

  test('skips records with foreign leases and reports when no candidate can satisfy the limit', async () => {
    harness = makeHarness(1)
    await initRepo(harness.repo)
    harness.svc.lifecycle.markReady()
    const svc = harness.svc

    const busy = await makeManagedWorktree('busy', ['s1'])
    const busy2 = await makeManagedWorktree('busy2', ['s2'])
    svc.pathLeases.lease('ghost', busy.checkoutPath)
    activeSessions.add('s2')

    const result = await svc.lifecycle.runCleanupSweep()
    expect(result.outcome).toBe('blocked')
    expect(result.reason).toContain('ghost')
    // Neither protected candidate was removed.
    expect(existsSync(busy.checkoutPath)).toBe(true)
    expect(existsSync(busy2.checkoutPath)).toBe(true)
  })

  test('disabling auto-delete prevents a queued sweep from starting a new candidate', async () => {
    harness = makeHarness(1)
    await initRepo(harness.repo)
    harness.svc.lifecycle.markReady()
    const svc = harness.svc

    await makeManagedWorktree('first', ['s1'])
    await makeManagedWorktree('second', ['s2'])
    // Disable auto-delete; the sweep must not remove anything.
    svc.worktreeSettings.update({ materializationRoot: harness.root + '/worktrees', autoDeleteEnabled: false })

    const result = await svc.lifecycle.runCleanupSweep()
    expect(result.outcome).toBe('skipped')
    for (const record of svc.registry.list()) {
      expect(existsSync((record as ManagedWorktreeRecordV2).checkoutPath)).toBe(true)
    }
  })

  test('a just-created or restored checkout receives current activity', async () => {
    const { svc } = harness
    const record = await makeManagedWorktree('feature-x')
    expect(record.lastUsedAt).toBeGreaterThanOrEqual(record.createdAt)
    // Restore bumps lastUsedAt.
    const preview = await svc.lifecycle.preview(record.managedWorktreeId)
    await svc.lifecycle.deleteWorktree(record.managedWorktreeId, preview.previewFingerprint)
    await new Promise((resolve) => setTimeout(resolve, 5))
    await svc.lifecycle.restoreWorktree(record.managedWorktreeId)
    const after = svc.registry.get(record.managedWorktreeId) as ManagedWorktreeRecordV2
    expect(after.lastUsedAt).toBeGreaterThan(record.lastUsedAt)
  })
})

describe('session-delete integration', () => {
  test('plain detach removes only that owner; remaining owners and checkout survive', async () => {
    const { svc } = harness
    const record = await makeManagedWorktree('feature-x', ['session-1', 'session-2'])
    svc.lifecycle.detachSession('session-1')
    const after = svc.registry.get(record.managedWorktreeId) as ManagedWorktreeRecordV2
    expect(after.ownerSessionIds).toEqual(['session-2'])
    expect(after.state).toBe('ready')
    expect(existsSync(record.checkoutPath)).toBe(true)
    expect(svc.pathLeases.leasesForSession('session-1')).toEqual([])
  })

  test('final-owner detach leaves an unowned record and enqueues policy cleanup', async () => {
    harness = makeHarness(1)
    await initRepo(harness.repo)
    harness.svc.lifecycle.markReady()
    const svc = harness.svc
    const record = await makeManagedWorktree('feature-x', ['session-1'])
    const other = await makeManagedWorktree('other', ['session-9'])
    // The unowned record is the least recently used.
    svc.registry.updateLastUsedAt(record.managedWorktreeId, Date.now() - 5000)
    // With auto-delete disabled, final-owner detach leaves the unowned record.
    svc.worktreeSettings.update({ materializationRoot: harness.root + '/worktrees', autoDeleteEnabled: false })

    await svc.lifecycle.detachSession('session-1')

    const after = svc.registry.get(record.managedWorktreeId) as ManagedWorktreeRecordV2
    expect(after.state).toBe('unowned')
    expect(existsSync(record.checkoutPath)).toBe(true)
    expect(svc.lifecycle.inventory().lastCleanupResult?.outcome).toBe('skipped')

    // Re-enabling auto-delete and sweeping removes the unowned checkout
    // snapshot-first (materialized count exceeds the limit; unowned is idle).
    svc.worktreeSettings.update({ materializationRoot: harness.root + '/worktrees', autoDeleteEnabled: true })
    await svc.lifecycle.runCleanupSweep()
    const removed = svc.registry.get(record.managedWorktreeId) as ManagedWorktreeRecordV2
    expect(removed.state).toBe('snapshotted')
    expect(existsSync(record.checkoutPath)).toBe(false)
    // The other owner's checkout survives.
    expect(existsSync(other.checkoutPath)).toBe(true)
  })

  test('delete-session-and-worktree is refused while another owner exists', async () => {
    const { svc } = harness
    const record = await makeManagedWorktree('feature-x', ['session-1', 'session-2'])
    const outcome = await svc.lifecycle.removeForSessionDeletion({
      sessionId: 'session-1',
      managedWorktreeId: record.managedWorktreeId,
    })
    expect(outcome.outcome).toBe('blocked')
    expect(existsSync(record.checkoutPath)).toBe(true)
  })

  test('delete-session-and-worktree for the final owner removes snapshot-first and drops the session', async () => {
    const { svc } = harness
    const record = await makeManagedWorktree('feature-x', ['session-1'])
    writeFile(record.checkoutPath, 'work.txt', 'precious\n')

    const outcome = await svc.lifecycle.removeForSessionDeletion({
      sessionId: 'session-1',
      managedWorktreeId: record.managedWorktreeId,
    })

    expect(outcome.outcome).toBe('removed')
    const after = svc.registry.get(record.managedWorktreeId) as ManagedWorktreeRecordV2
    expect(after.state).toBe('snapshotted')
    expect(after.ownerSessionIds).toEqual([])
    expect(existsSync(record.checkoutPath)).toBe(false)
    expect(svc.pathLeases.leasesForSession('session-1')).toEqual([])
    // A session-delete request can never remove a worktree with another owner —
    // covered above; here the final owner's lease is released.
    expect(svc.journal.entries().some((e) => e.op === 'session-delete' && e.status === 'committed')).toBe(true)
  })
})

describe('lastUsedAt hooks', () => {
  test('touchForSession updates the owning record on accepted user messages', async () => {
    const { svc } = harness
    const record = await makeManagedWorktree('feature-x', ['session-1'])
    const before = (svc.registry.get(record.managedWorktreeId) as ManagedWorktreeRecordV2).lastUsedAt
    await new Promise((resolve) => setTimeout(resolve, 5))
    svc.lifecycle.touchForSession('session-1')
    const after = svc.registry.get(record.managedWorktreeId) as ManagedWorktreeRecordV2
    expect(after.lastUsedAt).toBeGreaterThan(before)
    // A session without a worktree lease is a no-op.
    expect(() => svc.lifecycle.touchForSession('no-lease')).not.toThrow()
  })
})

describe('journal reconciliation', () => {
  test('classifies an interrupted delete before capture as a rollback', async () => {
    const { svc } = harness
    const record = await makeManagedWorktree('feature-x')
    // Simulate a crash after the snapshotting registry commit but before the
    // captured step: state snapshotting, journal in-progress without capture.
    const entry = svc.journal.begin({ op: 'delete', recordId: record.managedWorktreeId, sessionIds: ['session-1'], policyVersion: 0 })
    svc.journal.step(entry.journalId, 'locks-acquired')
    svc.journal.step(entry.journalId, 'quiesced')
    svc.journal.step(entry.journalId, 'fingerprint-validated')
    svc.journal.step(entry.journalId, 'registry-snapshotting')
    svc.registry.upsert({ ...record, state: 'snapshotting' })

    const report = await svc.lifecycle.reconcileJournal()

    expect(report.recovered).toBe(1)
    const after = svc.registry.get(record.managedWorktreeId) as ManagedWorktreeRecordV2
    expect(after.state).toBe('ready')
    expect(existsSync(record.checkoutPath)).toBe(true)
  })

  test('resumes an interrupted delete whose capture and removal completed', async () => {
    const { repo, svc } = harness
    const record = await makeManagedWorktree('feature-x')
    // Complete capture + removal manually, then leave the journal in progress.
    const captured = await svc.snapshots.capture({
      record,
      finalFingerprint: 'fp',
      previewFingerprint: 'fp',
      policyVersion: 0,
    })
    const { rmSync } = await import('node:fs')
    rmSync(record.checkoutPath, { recursive: true, force: true })
    await git(repo, ['worktree', 'prune'])
    svc.registry.upsert({ ...record, state: 'snapshotted', snapshot: captured.meta })
    const entry = svc.journal.begin({ op: 'delete', recordId: record.managedWorktreeId, sessionIds: ['session-1'], policyVersion: 0 })
    svc.journal.step(entry.journalId, 'captured')
    svc.journal.step(entry.journalId, 'registry-snapshotted')
    svc.journal.step(entry.journalId, 'checkout-removed')

    const report = await svc.lifecycle.reconcileJournal()

    expect(report.resumed).toBe(1)
    expect(svc.journal.inProgress()).toEqual([])
  })

  test('marks an interrupted restore as restore-failed', async () => {
    const { svc } = harness
    const record = await makeManagedWorktree('feature-x')
    const entry = svc.journal.begin({ op: 'restore', recordId: record.managedWorktreeId, sessionIds: ['session-1'], policyVersion: 0 })
    svc.journal.step(entry.journalId, 'locks-acquired')
    svc.registry.upsert({ ...record, state: 'restoring' })

    const report = await svc.lifecycle.reconcileJournal()

    expect(report.recovered).toBe(1)
    const after = svc.registry.get(record.managedWorktreeId) as ManagedWorktreeRecordV2
    expect(after.state).toBe('restore-failed')
  })
})

describe('inventory', () => {
  test('aggregates counts and exposes sanitized failure text without payload bytes', async () => {
    const { svc } = harness
    await makeManagedWorktree('feature-x', ['s1'])
    const inventory = svc.lifecycle.inventory()
    expect(inventory.counts.materialized).toBe(1)
    expect(inventory.counts.total).toBe(1)
    expect(inventory.policy.retentionLimit).toBe(15)
    expect(inventory.policy.autoDeleteEnabled).toBe(true)
    expect(inventory.rows[0]!.owners).toEqual([{ sessionId: 's1', archived: false, active: false, flagged: false }])
    expect(inventory.rows[0]!.snapshot).toBeUndefined()
    // Policy change reflects in inventory.
    svc.worktreeSettings.update({ materializationRoot: harness.root + '/worktrees', retentionLimit: 3 })
    expect(svc.lifecycle.inventory().policy.retentionLimit).toBe(3)
  })

  test('delete then permanent-delete removes the row from inventory', async () => {
    const { svc } = harness
    const record = await makeManagedWorktree('feature-x', ['s1'])
    await svc.lifecycle.deleteWorktree(
      record.managedWorktreeId,
      (await svc.lifecycle.preview(record.managedWorktreeId)).previewFingerprint,
    )
    expect(svc.lifecycle.inventory().counts.snapshotted).toBe(1)
    svc.lifecycle.detachSession('s1')
    await svc.lifecycle.permanentDelete(record.managedWorktreeId, true)
    expect(svc.lifecycle.inventory().counts.total).toBe(0)
  })
})

describe('missing-record handling', () => {
  test('a reconcile-classified missing record can be confirmed-removed journaled', async () => {
    const { repo, svc } = harness
    const record = await makeManagedWorktree('feature-x')
    // Classify missing: checkout gone from disk and git worktree list.
    const { rmSync } = await import('node:fs')
    rmSync(record.checkoutPath, { recursive: true, force: true })
    await git(repo, ['worktree', 'prune'])
    const report = await svc.worktrees.reconcile({ knownSessionIds: new Set(['session-1']) })
    expect(report.markedMissing).toBe(1)

    const result = await svc.lifecycle.deleteWorktree(record.managedWorktreeId, 'irrelevant')
    expect(result.deleted).toBe(true)
    expect(svc.registry.get(record.managedWorktreeId)).toBeUndefined()
    expect(svc.journal.entries().pop()?.status).toBe('committed')
    // The branch survives.
    expect((await git(repo, ['rev-parse', '--verify', `refs/heads/${record.expectedBranch}`])).trim()).toHaveLength(40)
  })
})

