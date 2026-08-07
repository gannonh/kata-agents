import { describe, test, expect, afterEach, beforeEach } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  svc.worktreeSettings.update({
    materializationRoot: join(root, 'worktrees'),
    autoDeleteEnabled: true,
    retentionLimit: limit,
  })
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
    await svc.lifecycle.detachSession('session-1')
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
    await svc.lifecycle.detachSession('session-1')
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
    await svc.lifecycle.detachSession('session-1')
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
    svc.registry.updateLastUsedAt(first.managedWorktreeId, Date.now() - 10)
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

  test('one sweep removes every surplus worktree beyond the retention limit', async () => {
    harness = makeHarness(1)
    await initRepo(harness.repo)
    harness.svc.lifecycle.markReady()
    const svc = harness.svc

    const first = await makeManagedWorktree('first', ['s1'])
    const second = await makeManagedWorktree('second', ['s2'])
    const third = await makeManagedWorktree('third', ['s3'])
    // All three idle and unarchived; the limit is 1, so two are surplus.
    svc.registry.updateLastUsedAt(first.managedWorktreeId, Date.now() - 3000)
    svc.registry.updateLastUsedAt(second.managedWorktreeId, Date.now() - 2000)

    const result = await svc.lifecycle.runCleanupSweep()

    expect(result.outcome).toBe('succeeded')
    expect(result.removedWorktreeId).toBe(second.managedWorktreeId)
    expect((svc.registry.get(first.managedWorktreeId) as ManagedWorktreeRecordV2).state).toBe('snapshotted')
    expect((svc.registry.get(second.managedWorktreeId) as ManagedWorktreeRecordV2).state).toBe('snapshotted')
    expect((svc.registry.get(third.managedWorktreeId) as ManagedWorktreeRecordV2).state).toBe('ready')
    expect(existsSync(first.checkoutPath)).toBe(false)
    expect(existsSync(second.checkoutPath)).toBe(false)
    expect(existsSync(third.checkoutPath)).toBe(true)
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
    await svc.lifecycle.detachSession('session-1')
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
    await svc.lifecycle.detachSession('s1')
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


describe('review-fix regressions', () => {
  test('startup reconciliation never reclassifies snapshot-backed states', async () => {
    const { svc } = harness
    const record = await makeManagedWorktree('feature-x')
    // Delete snapshot-first, leaving a snapshotted record with no checkout.
    await svc.lifecycle.deleteWorktree(
      record.managedWorktreeId,
      (await svc.lifecycle.preview(record.managedWorktreeId)).previewFingerprint,
    )
    expect((svc.registry.get(record.managedWorktreeId) as ManagedWorktreeRecordV2).state).toBe('snapshotted')

    // Reconcile must keep the lifecycle-owned state, never classify the
    // removed checkout as `missing`.
    await svc.worktrees.reconcile({ knownSessionIds: new Set(['session-1']) })
    const after = svc.registry.get(record.managedWorktreeId) as ManagedWorktreeRecordV2
    expect(after.state).toBe('snapshotted')
    expect(after.snapshot).toBeTruthy()
  })

  test('a write during capture blocks automatic removal (stability fingerprint)', async () => {
    harness = makeHarness(1)
    await initRepo(harness.repo)
    harness.svc.lifecycle.markReady()
    const svc = harness.svc
    const first = await makeManagedWorktree('first', ['s1'])
    const second = await makeManagedWorktree('second', ['s2'])
    svc.registry.updateLastUsedAt(first.managedWorktreeId, Date.now() - 5000)

    // Simulate an external writer racing the sweep: capture is intercepted by
    // recomputing the fingerprint after capture started. The checkout already
    // holds a modified file, and the hook writes MORE content into that same
    // file — the porcelain-v2 status line stays identical, so only the
    // per-path content binding can detect the race.
    writeFileSync(join(first.checkoutPath, 'work.txt'), 'external write\n')
    const originalCapture = svc.snapshots.capture.bind(svc.snapshots)
    svc.snapshots.capture = (async (input: Parameters<typeof originalCapture>[0]) => {
      writeFileSync(join(first.checkoutPath, 'work.txt'), 'external write 2\n')
      return originalCapture(input)
    }) as typeof originalCapture

    const result = await svc.lifecycle.runCleanupSweep()
    expect(result.removedWorktreeId).toBeUndefined()
    // The racing write is detected: the candidate's removal failed and the
    // failure is persisted (cleanup-failed) with the checkout intact.
    const after = svc.registry.get(first.managedWorktreeId) as ManagedWorktreeRecordV2
    expect(after.state).toBe('cleanup-failed')
    expect(after.lastError).toContain('changed')
    expect(readFileSync(join(first.checkoutPath, 'work.txt'), 'utf8')).toBe('external write 2\n')
  })

  test('restore persists the restoring state before touching the checkout', async () => {
    const { svc } = harness
    const record = await makeManagedWorktree('feature-x')
    await svc.lifecycle.deleteWorktree(
      record.managedWorktreeId,
      (await svc.lifecycle.preview(record.managedWorktreeId)).previewFingerprint,
    )
    // Intercept restore: the state must already be `restoring` when the
    // snapshot service starts restoring.
    const originalRestore = svc.snapshots.restore.bind(svc.snapshots)
    const observed: { state: string | null } = { state: null }
    svc.snapshots.restore = (async (input: Parameters<typeof originalRestore>[0]) => {
      observed.state = (svc.registry.get(record.managedWorktreeId) as ManagedWorktreeRecordV2).state
      return originalRestore(input)
    }) as typeof originalRestore

    await svc.lifecycle.restoreWorktree(record.managedWorktreeId)
    expect(observed.state).toBe('restoring')
    expect((svc.registry.get(record.managedWorktreeId) as ManagedWorktreeRecordV2).state).toBe('ready')
  })

  test('inventory counts unowned records separately', async () => {
    harness = makeHarness(2)
    await initRepo(harness.repo)
    harness.svc.lifecycle.markReady()
    const svc = harness.svc
    const record = await makeManagedWorktree('feature-x', ['session-1'])
    await makeManagedWorktree('other', ['session-9'])
    // Disable auto-delete so the enqueued sweep does not remove the record.
    svc.worktreeSettings.update({ materializationRoot: harness.root + '/worktrees', autoDeleteEnabled: false })
    await svc.lifecycle.detachSession('session-1')

    const inventory = svc.lifecycle.inventory()
    expect(inventory.counts.unowned).toBe(1)
    expect(inventory.counts.materialized).toBe(2)
    expect(inventory.rows.find((r) => r.managedWorktreeId === record.managedWorktreeId)?.state).toBe('unowned')
  })

  test('a completed sweep releases the enqueue slot for later events', async () => {
    const { svc } = harness
    await makeManagedWorktree('feature-x')
    const first = await svc.lifecycle.enqueueCleanup()
    // Under the limit there is nothing to remove; the sweep still completes
    // and records its result.
    expect(['blocked', 'skipped']).toContain(first.outcome)
    // A second enqueue must run a NEW sweep, not reuse the resolved promise.
    const second = await svc.lifecycle.enqueueCleanup()
    expect(second).toBeDefined()
    expect(svc.lifecycle.inventory().lastCleanupResult?.at).toBeGreaterThanOrEqual(first.at)
  })

  test('removing a missing record releases owner leases', async () => {
    const { repo, svc } = harness
    const record = await makeManagedWorktree('feature-x')
    const { rmSync } = await import('node:fs')
    rmSync(record.checkoutPath, { recursive: true, force: true })
    await git(repo, ['worktree', 'prune'])
    await svc.worktrees.reconcile({ knownSessionIds: new Set(['session-1']) })

    await svc.lifecycle.deleteWorktree(record.managedWorktreeId, 'irrelevant')
    expect(svc.pathLeases.leasesForSession('session-1')).toEqual([])
  })
})

describe('orphan and pending-restore cleanup', () => {
  test('gc removes unreferenced payloads and stale staging dirs', async () => {
    const { svc } = harness
    const record = await makeManagedWorktree('feature-x')
    // A referenced payload survives GC.
    await svc.lifecycle.deleteWorktree(
      record.managedWorktreeId,
      (await svc.lifecycle.preview(record.managedWorktreeId)).previewFingerprint,
    )
    const snapshotted = svc.registry.get(record.managedWorktreeId) as ManagedWorktreeRecordV2
    const referencedPath = snapshotted.snapshot!.payloadPath
    // Orphans: an unreferenced payload dir + a stale staging dir.
    const orphanPath = join(harness.root, 'snapshots', 'deadbeefdeadbeef')
    mkdirSync(orphanPath, { recursive: true })
    writeFileSync(join(orphanPath, 'manifest.json'), JSON.stringify({ snapshotId: 'deadbeefdeadbeef' }))
    const stagingPath = join(harness.root, 'snapshots', '.tmp-deadbeef')
    mkdirSync(stagingPath, { recursive: true })

    await svc.lifecycle.reconcileJournal()

    expect(existsSync(orphanPath)).toBe(false)
    expect(existsSync(stagingPath)).toBe(false)
    // Referenced payload untouched; the record still restorable.
    expect(existsSync(join(referencedPath, 'manifest.json'))).toBe(true)
    const restored = await svc.lifecycle.restoreWorktree(record.managedWorktreeId)
    expect(restored.restored).toBe(true)
  })

  test('gc retains a payload referenced only by a failed handoff journal', async () => {
    const { svc } = harness
    const record = await makeManagedWorktree('feature-x')
    await svc.lifecycle.deleteWorktree(
      record.managedWorktreeId,
      (await svc.lifecycle.preview(record.managedWorktreeId)).previewFingerprint,
    )
    const snapshotted = svc.registry.get(record.managedWorktreeId) as ManagedWorktreeRecordV2
    const payloadPath = snapshotted.snapshot!.payloadPath
    // The managed source record is removed exactly like a managed-to-current
    // release; only the handoff journal retains the snapshot authority.
    svc.registry.remove(record.managedWorktreeId)
    const journal = svc.journal.begin({
      op: 'handoff',
      recordId: 'deadbeefdeadbeef',
      sessionIds: ['session-1'],
      policyVersion: 1,
      metadata: { retainedSnapshotId: snapshotted.snapshot!.snapshotId },
    })
    svc.journal.fail(journal.journalId, 'simulated post-release failure')
    const orphanPath = join(harness.root, 'snapshots', 'deadbeefdeadbeef')
    mkdirSync(orphanPath, { recursive: true })
    writeFileSync(join(orphanPath, 'manifest.json'), JSON.stringify({ snapshotId: 'deadbeefdeadbeef' }))

    await svc.lifecycle.reconcileJournal()

    expect(existsSync(join(payloadPath, 'manifest.json'))).toBe(true)
    expect(existsSync(orphanPath)).toBe(false)
  })

  test('pending restore cleanup removes payload and ref of a ready record', async () => {
    const { repo, svc } = harness
    const record = await makeManagedWorktree('feature-x')
    await svc.lifecycle.deleteWorktree(
      record.managedWorktreeId,
      (await svc.lifecycle.preview(record.managedWorktreeId)).previewFingerprint,
    )
    // Simulate the crash window: restore committed (ready) but the payload and
    // hidden ref were never removed. Restore does this itself; simulate by
    // moving the record back to ready with snapshot metadata intact.
    const snapshotted = svc.registry.get(record.managedWorktreeId) as ManagedWorktreeRecordV2
    const meta = snapshotted.snapshot!
    const readyWithSnapshot: ManagedWorktreeRecordV2 = {
      ...snapshotted,
      state: 'ready',
      snapshot: meta,
    }
    svc.registry.upsert(readyWithSnapshot)

    await svc.lifecycle.reconcileJournal()

    const after = svc.registry.get(record.managedWorktreeId) as ManagedWorktreeRecordV2
    expect(after.state).toBe('ready')
    expect(after.snapshot).toBeUndefined()
    expect(existsSync(join(meta.payloadPath, 'manifest.json'))).toBe(false)
    const ref = await git(repo, ['rev-parse', '--verify', '--quiet', meta.hiddenRef]).catch(() => '')
    expect(ref.trim()).toBe('')
  })

  test('each enqueue runs a fresh sweep', async () => {
    const { svc } = harness
    await makeManagedWorktree('feature-x')
    let sweeps = 0
    const original = svc.lifecycle.runCleanupSweep.bind(svc.lifecycle)
    svc.lifecycle.runCleanupSweep = (async () => {
      sweeps += 1
      return original()
    }) as typeof original

    await svc.lifecycle.enqueueCleanup()
    await svc.lifecycle.enqueueCleanup()
    await svc.lifecycle.enqueueCleanup()

    expect(sweeps).toBe(3)
  })
})

describe('UAT regressions', () => {
  test('a flagged owner blocks manual deletion even with a fresh fingerprint', async () => {
    const { svc } = harness
    const record = await makeManagedWorktree('feature-x', ['session-1', 'session-2'])
    const preview = await svc.lifecycle.preview(record.managedWorktreeId)
    expect(preview.blocked).toBe(false)
    // Flag AFTER the preview: flag state is deliberately not part of the
    // fingerprint, so the transaction itself must enforce the protection.
    flaggedSessions.add('session-2')
    const result = await svc.lifecycle.deleteWorktree(record.managedWorktreeId, preview.previewFingerprint)
    expect(result.deleted).toBe(false)
    expect(result.error).toContain('flagged')
    expect((svc.registry.get(record.managedWorktreeId) as ManagedWorktreeRecordV2).state).toBe('ready')
    expect(existsSync(record.checkoutPath)).toBe(true)
  })

  test('an active owner blocks manual deletion', async () => {
    const { svc } = harness
    const record = await makeManagedWorktree('feature-x')
    const preview = await svc.lifecycle.preview(record.managedWorktreeId)
    activeSessions.add('session-1')
    const result = await svc.lifecycle.deleteWorktree(record.managedWorktreeId, preview.previewFingerprint)
    expect(result.deleted).toBe(false)
    expect(result.error).toContain('active')
    expect(existsSync(record.checkoutPath)).toBe(true)
  })

  test('retry completes the release when the checkout was already partially released', async () => {
    const { svc } = harness
    const record = await makeManagedWorktree('feature-x')
    writeFile(record.checkoutPath, 'work.txt', 'work in progress\n')
    const preview = await svc.lifecycle.preview(record.managedWorktreeId)
    await svc.lifecycle.deleteWorktree(record.managedWorktreeId, preview.previewFingerprint)
    const snapshotted = svc.registry.get(record.managedWorktreeId) as ManagedWorktreeRecordV2
    expect(snapshotted.state).toBe('snapshotted')
    // Simulate the crash window of a release that never completed: only a
    // stray directory remains where the checkout was (no .git metadata, so no
    // working-tree fingerprint is computable).
    mkdirSync(record.checkoutPath, { recursive: true })
    writeFileSync(join(record.checkoutPath, 'stray.tmp'), 'partial release')
    svc.registry.upsert({ ...snapshotted, state: 'cleanup-failed' })
    const retried = await svc.lifecycle.retryWorktree(record.managedWorktreeId)
    expect(retried).toMatchObject({ retried: true, state: 'snapshotted' })
    expect(existsSync(record.checkoutPath)).toBe(false)
    // …and it still restores exactly.
    const restored = await svc.lifecycle.restoreWorktree(record.managedWorktreeId)
    expect(restored.restored).toBe(true)
    expect(readFileSync(join(restored.checkoutPath!, 'work.txt'), 'utf8')).toBe('work in progress\n')
  })

  test('retry refuses when a still-inspectable checkout changed after capture', async () => {
    const { svc } = harness
    const record = await makeManagedWorktree('feature-x')
    writeFile(record.checkoutPath, 'work.txt', 'work in progress\n')
    const preview = await svc.lifecycle.preview(record.managedWorktreeId)
    // Race the transaction between capture and the final stability check: the
    // snapshot captures the original content, then an external writer changes
    // the checkout before release. The delete fails with the checkout intact
    // and the record cleanup-failed with a valid snapshot.
    const originalCapture = svc.snapshots.capture.bind(svc.snapshots)
    svc.snapshots.capture = (async (input: Parameters<typeof originalCapture>[0]) => {
      const captured = await originalCapture(input)
      writeFileSync(join(record.checkoutPath, 'work.txt'), 'edited after capture\n')
      return captured
    }) as typeof originalCapture
    const failed = await svc.lifecycle.deleteWorktree(record.managedWorktreeId, preview.previewFingerprint)
    expect(failed.deleted).toBe(false)
    expect(failed.error).toContain('changed during capture')
    const stuck = svc.registry.get(record.managedWorktreeId) as ManagedWorktreeRecordV2
    expect(stuck.state).toBe('cleanup-failed')
    expect(stuck.snapshot).toBeDefined()
    // The checkout is fully inspectable and holds the newer content: the
    // retry must refuse rather than release it against the stale snapshot.
    const retried = await svc.lifecycle.retryWorktree(record.managedWorktreeId)
    expect(retried.retried).toBe(false)
    expect(retried.error).toContain('changed after its snapshot')
    expect(readFileSync(join(record.checkoutPath, 'work.txt'), 'utf8')).toBe('edited after capture\n')
  })

  test('reconciliation gives missing records actionable recovery text', async () => {
    const { svc, root } = harness
    const record = await makeManagedWorktree('feature-x')
    rmSync(record.checkoutPath, { recursive: true, force: true })
    await svc.worktrees.reconcile({ knownSessionIds: new Set(['session-1']) })
    const missing = svc.registry.get(record.managedWorktreeId) as ManagedWorktreeRecordV2
    expect(missing.state).toBe('missing')
    expect(missing.lastError ?? '').toContain('no longer on disk')
    const row = svc.lifecycle.inventory().rows.find((r) => r.managedWorktreeId === record.managedWorktreeId)
    expect(row?.lastError ?? '').toContain('no longer on disk')
    expect(root).toBeDefined()
  })

  test('session-delete removal never stamps the dropped session with owner state', async () => {
    harness = makeHarness(1)
    await initRepo(harness.repo)
    harness.svc.lifecycle.markReady()
    const stamped: string[][] = []
    const svc = harness.svc
    ;(svc.lifecycle as unknown as {
      deps: { applyOwnerSessionState: (sessionIds: string[]) => Promise<void> }
    }).deps.applyOwnerSessionState = async (sessionIds) => {
      stamped.push([...sessionIds])
    }
    const record = await makeManagedWorktree('feature-x', ['session-1'])

    const outcome = await svc.lifecycle.removeForSessionDeletion({
      sessionId: 'session-1',
      managedWorktreeId: record.managedWorktreeId,
    })

    expect(outcome.outcome).toBe('removed')
    // The session being deleted must not be persisted/flushed as an owner of
    // the removed worktree — that would recreate it at its original path.
    expect(stamped.flat()).not.toContain('session-1')
  })

  test('restore never re-associates an owner that detached mid-restore', async () => {
    const { svc } = harness
    const record = await makeManagedWorktree('feature-x', ['session-1'])
    writeFile(record.checkoutPath, 'work.txt', 'work in progress\n')
    await svc.lifecycle.deleteWorktree(
      record.managedWorktreeId,
      (await svc.lifecycle.preview(record.managedWorktreeId)).previewFingerprint,
    )
    // The owner detaches while the restore awaits snapshot I/O: the restored
    // record and its lease rebinding must use the CURRENT owner set, so the
    // detached session is not re-associated with the restored checkout.
    const originalRestore = svc.snapshots.restore.bind(svc.snapshots)
    svc.snapshots.restore = (async (input: Parameters<typeof originalRestore>[0]) => {
      await svc.lifecycle.detachSession('session-1')
      return originalRestore(input)
    }) as typeof originalRestore

    const restored = await svc.lifecycle.restoreWorktree(record.managedWorktreeId)

    expect(restored.restored).toBe(true)
    const after = svc.registry.get(record.managedWorktreeId) as ManagedWorktreeRecordV2
    expect(after.ownerSessionIds).toEqual([])
    expect(svc.pathLeases.leasesForSession('session-1')).toEqual([])
  })

  test('restore never leases back an owner that detached during session stamping', async () => {
    const { svc } = harness
    const record = await makeManagedWorktree('feature-x', ['session-1'])
    writeFile(record.checkoutPath, 'work.txt', 'work in progress\n')
    await svc.lifecycle.deleteWorktree(
      record.managedWorktreeId,
      (await svc.lifecycle.preview(record.managedWorktreeId)).previewFingerprint,
    )
    // The owner detaches while the restored state is being stamped onto
    // sessions: the lease rebinding must re-observe the owner set under the
    // registry lock so the detached session is not leased back onto the
    // restored checkout, where it would fence later cleanup.
    const deps = svc.lifecycle as unknown as {
      deps: {
        applyOwnerSessionState: (
          sessionIds: string[],
          state: { managedWorktreeId: string; state: string; checkoutPath?: string },
        ) => Promise<void>
      }
    }
    const originalApply = deps.deps.applyOwnerSessionState
    deps.deps.applyOwnerSessionState = async (sessionIds, state) => {
      await svc.lifecycle.detachSession('session-1')
      return originalApply(sessionIds, state)
    }

    const restored = await svc.lifecycle.restoreWorktree(record.managedWorktreeId)

    expect(restored.restored).toBe(true)
    const after = svc.registry.get(record.managedWorktreeId) as ManagedWorktreeRecordV2
    expect(after.ownerSessionIds).toEqual([])
    expect(svc.pathLeases.leasesForSession('session-1')).toEqual([])
  })

  test('startup reconciliation prunes stale lease markers', async () => {
    const { svc, root } = harness
    await makeManagedWorktree('feature-x')
    // A lease left by a process that has since exited would fence every
    // destructive transaction on that checkout as a foreign lease.
    const { resolve } = await import('node:path')
    const modulePath = resolve(import.meta.dir, '../path-leases.ts')
    const script = `
      import { PathLeaseManager } from ${JSON.stringify(modulePath)}
      new PathLeaseManager(${JSON.stringify(join(root, 'locks', 'path-leases'))}).lease('ghost', ${JSON.stringify(join(root, 'worktrees', 'x'))})
    `
    const child = Bun.spawnSync([process.execPath, '-e', script], { cwd: process.cwd() })
    expect(child.exitCode).toBe(0)
    expect(svc.pathLeases.leasesForSession('ghost')).toEqual([join(root, 'worktrees', 'x')])

    await svc.lifecycle.reconcileJournal()

    expect(svc.pathLeases.leasesForSession('ghost')).toEqual([])
  })
})
