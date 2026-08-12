import { describe, test, expect, afterEach } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import {
  WorktreeRegistry,
  WorktreeRegistryError,
  getWorktreeRegistryEvidencePaths,
} from '../worktree-registry'
import { CrossProcessFileLock, DEFAULT_LOCK_TIMEOUT_MS } from '../mutation-lock'
import type { ManagedWorktreeRecordV2 } from '@kata-sh/shared/protocol'
import { cleanup, makeTmpDir } from './test-helpers'

const cleanups: string[] = []
function tmp(): string {
  const dir = makeTmpDir('kata-registry-test-')
  cleanups.push(dir)
  return dir
}
afterEach(() => {
  while (cleanups.length) cleanup(cleanups.pop()!)
})

function legacyRecord(root: string, id = 'repo-aabbccdd') {
  const token = id.slice(-8)
  return {
    managedWorktreeId: id,
    workspaceId: 'workspace-1',
    repositoryRoot: join(root, 'source'),
    gitCommonDir: join(root, 'source', '.git'),
    checkoutPath: join(root, 'workspace-1', '0123456789abcdef', token),
    baseRef: 'main',
    expectedBranch: `kata-agent/${token}`,
    createdAt: 123,
    ownerSessionIds: ['session-1'],
    state: 'ready' as const,
  }
}

function writeV1(path: string, record: ReturnType<typeof legacyRecord>): string {
  const raw = JSON.stringify({ version: 1, records: [record] }, null, 2) + '\n'
  writeFileSync(path, raw)
  return raw
}

describe('WorktreeRegistry', () => {
  test('upgrades V1 in place with recoverable hash-bound evidence and is idempotent', async () => {
    const root = tmp()
    const path = join(root, 'registry.json')
    const source = writeV1(path, legacyRecord(root))
    const registry = new WorktreeRegistry(path)

    await registry.load()
    const upgraded = (await registry.get('repo-aabbccdd')) as ManagedWorktreeRecordV2
    expect(upgraded.schemaVersion).toBe(2)
    expect(upgraded.managedWorktreeId).toBe('repo-aabbccdd')
    expect(upgraded.checkoutPath).toBe(legacyRecord(root).checkoutPath)
    expect(upgraded.expectedBranch).toBe('kata-agent/aabbccdd')
    expect(upgraded.displayName).toBe('aabbccdd')
    expect(upgraded.materializationRoot).toBe(root)
    expect(upgraded.workspaceId).toBe('workspace-1')
    expect(upgraded.baseRef).toBe('main')
    expect(upgraded.ownerSessionIds).toEqual(['session-1'])
    expect(upgraded.state).toBe('ready')

    const paths = getWorktreeRegistryEvidencePaths(path)
    expect(existsSync(paths.backupPath)).toBe(true)
    expect(readFileSync(paths.backupPath, 'utf8')).toBe(source)
    const evidence = registry.getUpgradeEvidence()!
    expect(evidence.status).toBe('complete')
    expect(evidence.sourceHash).toBe(createHash('sha256').update(source).digest('hex'))
    expect(evidence.backupHash).toBe(evidence.sourceHash)
    expect(evidence.registryHash).toBe(
      createHash('sha256').update(readFileSync(path, 'utf8')).digest('hex'),
    )

    const before = statSync(path).mtimeMs
    await registry.load()
    expect(statSync(path).mtimeMs).toBe(before)
    expect(await registry.list()).toHaveLength(1)
  })

  test('recovers a V2 registry rewritten with a V1 wrapper by an older process', async () => {
    const root = tmp()
    const path = join(root, 'registry.json')
    writeV1(path, legacyRecord(root))
    const registry = new WorktreeRegistry(path)
    await registry.load()

    const evidencePaths = getWorktreeRegistryEvidencePaths(path)
    const originalBackup = readFileSync(evidencePaths.backupPath)
    const originalCompletedAt = registry.getUpgradeEvidence()!.completedAt
    const downgraded = JSON.parse(readFileSync(path, 'utf8')) as {
      version: number
      records: ManagedWorktreeRecordV2[]
    }
    downgraded.version = 1
    downgraded.records[0]!.state = 'missing'
    writeFileSync(path, JSON.stringify(downgraded, null, 2) + '\n')

    const recovered = new WorktreeRegistry(path)
    expect((await recovered.get('repo-aabbccdd'))?.state).toBe('missing')
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(2)
    expect(readFileSync(evidencePaths.backupPath)).toEqual(originalBackup)
    expect(recovered.getUpgradeEvidence()).toMatchObject({
      completedAt: originalCompletedAt,
      registryHash: createHash('sha256').update(readFileSync(path)).digest('hex'),
    })
  })

  test('fails closed on ambiguous V1 wrappers containing V2 records', async () => {
    const root = tmp()
    const path = join(root, 'registry.json')
    writeV1(path, legacyRecord(root))
    await new WorktreeRegistry(path).load()

    const mixed = JSON.parse(readFileSync(path, 'utf8'))
    mixed.version = 1
    mixed.records.push(legacyRecord(root, 'repo-eeff0011'))
    const mixedBytes = JSON.stringify(mixed, null, 2) + '\n'
    writeFileSync(path, mixedBytes)
    await expect(new WorktreeRegistry(path).load()).rejects.toThrow(WorktreeRegistryError)
    expect(readFileSync(path, 'utf8')).toBe(mixedBytes)

    mixed.records.pop()
    const noEvidenceBytes = JSON.stringify(mixed, null, 2) + '\n'
    writeFileSync(path, noEvidenceBytes)
    const evidencePaths = getWorktreeRegistryEvidencePaths(path)
    rmSync(evidencePaths.backupPath)
    rmSync(evidencePaths.markerPath)
    await expect(new WorktreeRegistry(path).load()).rejects.toThrow(WorktreeRegistryError)
    expect(readFileSync(path, 'utf8')).toBe(noEvidenceBytes)
  })

  test('fails closed when legacy rewrite evidence is not bound to its source backup', async () => {
    const root = tmp()
    const path = join(root, 'registry.json')
    writeV1(path, legacyRecord(root))
    await new WorktreeRegistry(path).load()

    const evidencePaths = getWorktreeRegistryEvidencePaths(path)
    const downgraded = JSON.parse(readFileSync(path, 'utf8'))
    downgraded.version = 1
    const downgradedBytes = JSON.stringify(downgraded, null, 2) + '\n'
    writeFileSync(path, downgradedBytes)
    const evidence = JSON.parse(readFileSync(evidencePaths.markerPath, 'utf8'))
    evidence.sourceHash = '0'.repeat(64)
    writeFileSync(evidencePaths.markerPath, JSON.stringify(evidence, null, 2) + '\n')

    await expect(new WorktreeRegistry(path).load()).rejects.toThrow(WorktreeRegistryError)
    expect(readFileSync(path, 'utf8')).toBe(downgradedBytes)
  })

  test('resumes interrupted legacy rewrite recovery with its original completion time', async () => {
    const root = tmp()
    const path = join(root, 'registry.json')
    writeV1(path, legacyRecord(root))
    const seed = new WorktreeRegistry(path)
    await seed.load()
    const completedAt = seed.getUpgradeEvidence()!.completedAt

    const downgraded = JSON.parse(readFileSync(path, 'utf8'))
    downgraded.version = 1
    const downgradedBytes = JSON.stringify(downgraded, null, 2) + '\n'
    writeFileSync(path, downgradedBytes)
    const interrupted = new WorktreeRegistry(path, undefined, {
      beforeReplace: () => writeFileSync(path, `${downgradedBytes} `),
    })
    await expect(interrupted.load()).rejects.toThrow(WorktreeRegistryError)

    writeFileSync(path, downgradedBytes)
    const recovered = new WorktreeRegistry(path)
    expect(await recovered.list()).toHaveLength(1)
    expect(recovered.getUpgradeEvidence()).toMatchObject({ status: 'complete', completedAt })
  })

  test('fails closed on malformed V2 records beneath a V1 wrapper', async () => {
    const root = tmp()
    const path = join(root, 'registry.json')
    writeV1(path, legacyRecord(root))
    await new WorktreeRegistry(path).load()

    const downgraded = JSON.parse(readFileSync(path, 'utf8'))
    downgraded.version = 1
    downgraded.records[0].displayName = ''
    const malformed = JSON.stringify(downgraded, null, 2) + '\n'
    writeFileSync(path, malformed)

    await expect(new WorktreeRegistry(path).load()).rejects.toThrow(WorktreeRegistryError)
    expect(readFileSync(path, 'utf8')).toBe(malformed)
  })

  test('fails closed on corrupt and unsupported sources without clearing source bytes', async () => {
    const root = tmp()
    const path = join(root, 'registry.json')
    const corrupt = '{"version":2,"records":[}'
    writeFileSync(path, corrupt)
    const registry = new WorktreeRegistry(path)

    await expect(registry.list()).rejects.toMatchObject({
      name: 'WorktreeRegistryError',
      code: 'REGISTRY_CORRUPT',
    })
    expect(readFileSync(path, 'utf8')).toBe(corrupt)

    const unsupported = JSON.stringify({ version: 99, records: [] })
    writeFileSync(path, unsupported)
    await expect(registry.load()).rejects.toThrow(WorktreeRegistryError)
    expect(readFileSync(path, 'utf8')).toBe(unsupported)
  })

  test('does not authorize stale cache after the source becomes corrupt', async () => {
    const root = tmp()
    const path = join(root, 'registry.json')
    const registry = new WorktreeRegistry(path)
    await registry.upsert(legacyRecord(root))
    const corrupt = '{"version":2,"records":'
    writeFileSync(path, corrupt)

    await expect(registry.get('repo-aabbccdd')).rejects.toThrow(WorktreeRegistryError)
    expect(readFileSync(path, 'utf8')).toBe(corrupt)
  })

  test('recovers a missing fixed registry from the preserved V1 source backup', async () => {
    const root = tmp()
    const path = join(root, 'registry.json')
    writeV1(path, legacyRecord(root))
    const registry = new WorktreeRegistry(path)
    await registry.load()
    rmSync(path)

    const recovered = new WorktreeRegistry(path)
    expect(await recovered.list()).toHaveLength(1)
    expect(((await recovered.get('repo-aabbccdd')) as ManagedWorktreeRecordV2).schemaVersion).toBe(2)
    expect(existsSync(path)).toBe(true)
  })

  test('fails closed instead of restoring an old V1 backup after later V2 mutation', async () => {
    const root = tmp()
    const path = join(root, 'registry.json')
    writeV1(path, legacyRecord(root))
    const registry = new WorktreeRegistry(path)
    await registry.load()
    await registry.upsert(legacyRecord(root, 'repo-eeff0011'))
    const backup = readFileSync(getWorktreeRegistryEvidencePaths(path).backupPath)
    rmSync(path)

    const recovered = new WorktreeRegistry(path)
    await expect(recovered.list()).rejects.toMatchObject({ code: 'REGISTRY_CONFLICT' })
    expect(existsSync(path)).toBe(false)
    expect(readFileSync(getWorktreeRegistryEvidencePaths(path).backupPath)).toEqual(backup)
  })

  test('rejects a divergent source against a complete registry hash marker', async () => {
    const root = tmp()
    const path = join(root, 'registry.json')
    writeV1(path, legacyRecord(root))
    const registry = new WorktreeRegistry(path)
    await registry.load()
    const current = (await registry.get('repo-aabbccdd')) as ManagedWorktreeRecordV2
    const divergent = {
      ...current,
      managedWorktreeId: 'repo-eeff0011',
      expectedBranch: 'kata-agent/eeff0011',
      displayName: 'eeff0011',
      checkoutPath: join(root, 'workspace-1', '0123456789abcdef', 'eeff0011'),
    }
    writeFileSync(path, JSON.stringify({ version: 2, records: [current, divergent] }, null, 2) + '\n')
    const source = readFileSync(path, 'utf8')

    await expect(registry.load()).rejects.toMatchObject({ code: 'REGISTRY_CONFLICT' })
    expect(readFileSync(path, 'utf8')).toBe(source)
  })

  test('rejects an intervening writer instead of overwriting its new record', async () => {
    const root = tmp()
    const path = join(root, 'registry.json')
    const seed = new WorktreeRegistry(path)
    await seed.upsert(legacyRecord(root, 'repo-aabbccdd'))
    const first = (await seed.get('repo-aabbccdd')) as ManagedWorktreeRecordV2
    const second = {
      ...first,
      managedWorktreeId: 'repo-eeff0011',
      expectedBranch: 'kata-agent/eeff0011',
      displayName: 'eeff0011',
      checkoutPath: join(root, 'workspace-1', '0123456789abcdef', 'eeff0011'),
    }
    const writerBytes = JSON.stringify({ version: 2, records: [first, second] }, null, 2) + '\n'
    const racing = new WorktreeRegistry(path, undefined, {
      beforePersist: () => writeFileSync(path, writerBytes),
    })

    await expect(racing.setState(first.managedWorktreeId, 'blocked')).rejects.toThrow(WorktreeRegistryError)
    expect(readFileSync(path, 'utf8')).toBe(writerBytes)
    expect((await new WorktreeRegistry(path).list()).map((record) => record.managedWorktreeId).sort()).toEqual([
      'repo-aabbccdd',
      'repo-eeff0011',
    ])
  })

  test('aborts before rename when a writer changes the source at the deterministic race hook', async () => {
    const root = tmp()
    const path = join(root, 'registry.json')
    const seed = new WorktreeRegistry(path)
    await seed.upsert(legacyRecord(root, 'repo-aabbccdd'))
    const first = (await seed.get('repo-aabbccdd')) as ManagedWorktreeRecordV2
    const second = {
      ...first,
      managedWorktreeId: 'repo-eeff0011',
      expectedBranch: 'kata-agent/eeff0011',
      displayName: 'eeff0011',
      checkoutPath: join(root, 'workspace-1', '0123456789abcdef', 'eeff0011'),
    }
    const writerBytes = JSON.stringify({ version: 2, records: [first, second] }, null, 2) + '\n'
    const racing = new WorktreeRegistry(path, undefined, {
      beforeReplace: () => writeFileSync(path, writerBytes),
    })

    await expect(racing.setState(first.managedWorktreeId, 'blocked')).rejects.toThrow(WorktreeRegistryError)
    expect(readFileSync(path, 'utf8')).toBe(writerBytes)
  })

  test('rejects a source that conflicts with prior upgrade evidence', async () => {
    const root = tmp()
    const path = join(root, 'registry.json')
    writeV1(path, legacyRecord(root))
    const registry = new WorktreeRegistry(path)
    await registry.load()

    // A V1 source with a different hash after an upgrade is not safe to
    // overwrite with stale migration output.
    const changed = writeV1(path, { ...legacyRecord(root), ownerSessionIds: ['new-owner'] })
    await expect(registry.load()).rejects.toMatchObject({ code: 'REGISTRY_CONFLICT' })
    expect(readFileSync(path, 'utf8')).toBe(changed)
  })

  test('competing instances serialize owner binding and removal claims', async () => {
    const root = tmp()
    const path = join(root, 'registry.json')
    const first = new WorktreeRegistry(path)
    const second = new WorktreeRegistry(path)
    const record = legacyRecord(root)
    await first.upsert(record)

    expect(await second.addOwnerIfReady(record.managedWorktreeId, 'session-2')).toEqual({
      status: 'added',
    })
    expect(await first.beginRemoval(record.managedWorktreeId, 'session-1')).toEqual({
      status: 'other-owner',
    })

    await second.removeOwner(record.managedWorktreeId, 'session-2')
    expect(await first.beginRemoval(record.managedWorktreeId, 'session-1')).toEqual({
      status: 'started',
    })
    expect(await second.addOwnerIfReady(record.managedWorktreeId, 'session-3')).toMatchObject({
      status: 'not-ready',
      state: 'removing',
    })
  })

  test('missing and blocked records remain retryable for explicit removal', async () => {
    const root = tmp()
    const path = join(root, 'registry.json')
    const registry = new WorktreeRegistry(path)
    const record = legacyRecord(root)
    await registry.upsert(record)

    for (const state of ['missing', 'blocked'] as const) {
      await registry.setState(record.managedWorktreeId, state)
      expect(await registry.beginRemoval(record.managedWorktreeId, 'session-1')).toEqual({
        status: 'started',
      })
      await registry.setState(record.managedWorktreeId, 'ready')
    }
  })

  test('accepts and persists Phase 2 lifecycle states', async () => {
    const root = tmp()
    const path = join(root, 'registry.json')
    const registry = new WorktreeRegistry(path)
    const record = legacyRecord(root)
    await registry.upsert(record)

    const states = [
      'snapshotting',
      'snapshotted',
      'restoring',
      'cleanup-failed',
      'restore-failed',
      'unowned',
    ] as const
    for (const state of states) {
      await registry.setState(record.managedWorktreeId, state)
      const reloaded = new WorktreeRegistry(path)
      expect((await reloaded.get(record.managedWorktreeId))?.state).toBe(state)
    }
    // Invalid states stay rejected.
    await expect(
      registry.setState(record.managedWorktreeId, 'not-a-state' as never),
    ).rejects.toThrow(WorktreeRegistryError)
  })

  test('persists and validates Phase 2 record fields (snapshot, policy, archive, errors)', async () => {
    const root = tmp()
    const path = join(root, 'registry.json')
    const registry = new WorktreeRegistry(path)
    const baseRecord = legacyRecord(root)
    const record: ManagedWorktreeRecordV2 = {
      ...baseRecord,
      schemaVersion: 2,
      workspaceId: 'workspace-1',
      displayName: 'feature-x',
      materializationRoot: root,
      lastUsedAt: 123,
      state: 'snapshotted',
      policyVersion: 7,
      archivedOwnerSessionIds: ['session-1'],
      lastError: 'snapshot verification failed (sanitized)',
      stateChangedAt: 456,
      lastCleanupResult: {
        at: 789,
        outcome: 'succeeded',
        policyVersion: 7,
        removedWorktreeId: baseRecord.managedWorktreeId,
      },
      snapshot: {
        snapshotId: '0123456789abcdef',
        schemaVersion: 1,
        hiddenRef: 'refs/kata/worktree-snapshots/0123456789abcdef',
        headOid: 'a'.repeat(40),
        branch: 'kata-agent/feature-x',
        manifestHash: 'b'.repeat(64),
        payloadPath: join(root, 'snapshots', '0123456789abcdef'),
        createdAt: 456,
        fileCount: 3,
        totalBytes: 1024,
        fingerprint: 'fp-capture',
        policyVersion: 7,
        previewFingerprint: 'fp-preview',
      },
    }
    await registry.upsert(record)

    const reloaded = new WorktreeRegistry(path)
    expect(await reloaded.get(record.managedWorktreeId)).toEqual(record)

    // Invalid optional shapes fail closed.
    for (const invalid of [
      { snapshot: { ...record.snapshot!, headOid: 'xyz' } },
      { snapshot: { ...record.snapshot!, manifestHash: 'short' } },
      { snapshot: { ...record.snapshot!, payloadPath: 'relative/path' } },
      { policyVersion: -1 },
      { archivedOwnerSessionIds: ['a', 'a'] },
      { lastError: '' },
      { lastCleanupResult: { at: 1, outcome: 'mystery', policyVersion: 0 } },
      { stateChangedAt: Number.NaN },
    ] as Array<Partial<ManagedWorktreeRecordV2>>) {
      await expect(registry.upsert({ ...record, ...invalid })).rejects.toThrow(WorktreeRegistryError)
    }
  })

  test('runExclusive holds the cross-process lock across a transaction', async () => {
    const root = tmp()
    const path = join(root, 'registry.json')
    const registry = new WorktreeRegistry(path)
    const record = legacyRecord(root)
    await registry.upsert(record)

    const modulePath = resolve(import.meta.dir, '../worktree-registry.ts')
    const signal = join(root, 'tx-started')
    const blocked = await registry.runExclusive(async (tx) => {
      const current = tx.get(record.managedWorktreeId)!
      writeFileSync(signal, 'entered')
      // A separate process must not be able to mutate while the transaction
      // holds the registry lock: give it a short timeout and expect failure.
      const script = `
        import { WorktreeRegistry } from ${JSON.stringify(modulePath)}
        import { writeFileSync } from 'node:fs'
        const registry = new WorktreeRegistry(${JSON.stringify(path)}, { timeoutMs: 400, retryDelayMs: 5 })
        // Signal BEFORE the attempt: a load/parse failure must not pass the
        // test as a lock-induced block.
        writeFileSync(${JSON.stringify(join(root, 'racer-attempted'))}, 'entered')
        try {
          await registry.addOwnerIfReady(${JSON.stringify(record.managedWorktreeId)}, 'racer')
          writeFileSync(${JSON.stringify(join(root, 'racer-won'))}, 'won')
        } catch (error) {
          writeFileSync(${JSON.stringify(join(root, 'racer-failed'))}, error instanceof Error ? error.message : String(error))
        }
      `
      const child = spawn(process.execPath, ['-e', script], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      })
      let childOutput = ''
      child.stdout.on('data', (chunk) => { childOutput += String(chunk) })
      child.stderr.on('data', (chunk) => { childOutput += String(chunk) })
      await new Promise<void>((done) => child.on('exit', () => done()))
      // The child loaded the module and reached the acquisition attempt; it
      // must have been blocked by the held registry lock, not by a child-side
      // failure.
      expect(existsSync(join(root, 'racer-attempted'))).toBe(true)
      expect(existsSync(join(root, 'racer-won'))).toBe(false)
      expect(existsSync(join(root, 'racer-failed'))).toBe(true)
      expect(readFileSync(join(root, 'racer-failed'), 'utf8')).toContain('registry lock')
      expect(childOutput).toBe('')
      current.state = 'snapshotting'
      tx.commit()
      return current.state
    })

    expect(blocked).toBe('snapshotting')
    expect((await registry.get(record.managedWorktreeId))?.state).toBe('snapshotting')
    // A second instance sees the committed state.
    expect((await new WorktreeRegistry(path).get(record.managedWorktreeId))?.state).toBe('snapshotting')
  })

  test('runExclusive discards uncommitted changes', async () => {
    const root = tmp()
    const path = join(root, 'registry.json')
    const registry = new WorktreeRegistry(path)
    const record = legacyRecord(root)
    await registry.upsert(record)

    await registry.runExclusive(async (tx) => {
      tx.get(record.managedWorktreeId)!.state = 'removing'
      // No commit: the mutation must not persist.
    })
    expect((await registry.get(record.managedWorktreeId))?.state).toBe('ready')
  })

  // -------------------------------------------------------------------------
  // Async lock-contention regression tests (spec: #45 acceptance criteria)
  // -------------------------------------------------------------------------

  test('same-process contention: event loop stays responsive and read sees committed state', async () => {
    const root = tmp()
    const path = join(root, 'registry.json')
    const registry = new WorktreeRegistry(path)
    const record = legacyRecord(root)
    await registry.upsert(record)

    const locked = join(root, 'locked')
    const transaction = registry.runExclusive(async (tx) => {
      tx.get(record.managedWorktreeId)!.state = 'snapshotting'
      writeFileSync(locked, 'held')
      await new Promise((resolve) => setTimeout(resolve, 120))
      tx.commit()
      return tx.get(record.managedWorktreeId)!.state
    })

    // Wait until the transaction has actually acquired the lock, so the read
    // below is guaranteed to contend.
    for (let i = 0; i < 200 && !existsSync(locked); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(existsSync(locked)).toBe(true)

    // Start a concurrent registry read while the lock is held.
    const read = registry.get(record.managedWorktreeId)

    // A zero-delay timer must fire while the read is still pending — proof the
    // event loop is not blocked by lock acquisition.
    let timerFired = false
    await new Promise<void>((resolve) => setTimeout(() => { timerFired = true; resolve() }, 0))
    expect(timerFired).toBe(true)

    expect(await transaction).toBe('snapshotting')
    // The read resolves with the committed state after the lock is released.
    expect((await read)?.state).toBe('snapshotting')
  })

  test('cross-process contention: parent event loop responsive and read sees authoritative state', async () => {
    const root = tmp()
    const path = join(root, 'registry.json')
    const registry = new WorktreeRegistry(path)
    const record = legacyRecord(root)
    await registry.upsert(record)

    const modulePath = resolve(import.meta.dir, '../worktree-registry.ts')
    const childAcquired = join(root, 'child-acquired')
    const releaseSignal = join(root, 'parent-release')
    const script = `
      import { writeFileSync, existsSync } from 'node:fs'
      import { WorktreeRegistry } from ${JSON.stringify(modulePath)}
      const registry = new WorktreeRegistry(${JSON.stringify(path)}, { timeoutMs: 10000, retryDelayMs: 5 })
      await registry.runExclusive(async (tx) => {
        tx.get(${JSON.stringify(record.managedWorktreeId)})!.state = 'blocked'
        writeFileSync(${JSON.stringify(childAcquired)}, 'acquired')
        for (let i = 0; i < 2000 && !existsSync(${JSON.stringify(releaseSignal)}); i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
        tx.commit()
      })
    `
    const child = spawn(process.execPath, ['-e', script], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    let childOutput = ''
    child.stdout.on('data', (chunk) => { childOutput += String(chunk) })
    child.stderr.on('data', (chunk) => { childOutput += String(chunk) })

    try {
      for (let i = 0; i < 200 && !existsSync(childAcquired); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(existsSync(childAcquired)).toBe(true)

      // Start a concurrent registry read while the child holds the lock.
      const read = registry.get(record.managedWorktreeId)

      // A zero-delay timer must fire while the read is pending — the parent
      // event loop continues despite cross-process lock contention.
      let timerFired = false
      await new Promise<void>((resolve) => setTimeout(() => { timerFired = true; resolve() }, 0))
      expect(timerFired).toBe(true)

      // Release the child; the read must resolve with the child's committed
      // authoritative state.
      writeFileSync(releaseSignal, 'release')
      expect((await read)?.state).toBe('blocked')
      expect(childOutput).toBe('')
    } finally {
      writeFileSync(releaseSignal, 'release')
      if (!child.killed) child.kill('SIGKILL')
    }
  })

  test('timeout: waiting operation rejects REGISTRY_LOCK_FAILED while the event loop stays responsive', async () => {
    const root = tmp()
    const path = join(root, 'registry.json')
    const record = legacyRecord(root)
    await new WorktreeRegistry(path).upsert(record)

    // Hold the registry's cross-process lock in a child process past a short
    // parent-side timeout, without releasing.
    const lockPath = getWorktreeRegistryEvidencePaths(path).lockPath
    const lockModulePath = resolve(import.meta.dir, '../mutation-lock.ts')
    const childHeld = join(root, 'child-held')
    const script = `
      import { writeFileSync } from 'node:fs'
      import { CrossProcessFileLock } from ${JSON.stringify(lockModulePath)}
      const lock = new CrossProcessFileLock(${JSON.stringify(lockPath)}, { timeoutMs: 10000, retryDelayMs: 5 })
      await lock.run(async () => {
        writeFileSync(${JSON.stringify(childHeld)}, 'held')
        await new Promise((resolve) => setTimeout(resolve, 2000))
      })
    `
    const child = spawn(process.execPath, ['-e', script], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    child.stdout.on('data', () => {})
    child.stderr.on('data', () => {})

    try {
      for (let i = 0; i < 200 && !existsSync(childHeld); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(existsSync(childHeld)).toBe(true)

      // A registry configured with a short timeout must reject acquisition.
      const registry = new WorktreeRegistry(path, { timeoutMs: 300, retryDelayMs: 5 })
      const read = registry.get(record.managedWorktreeId)

      // A zero-delay timer must fire while acquisition is pending.
      let timerFired = false
      await new Promise<void>((resolve) => setTimeout(() => { timerFired = true; resolve() }, 0))
      expect(timerFired).toBe(true)

      await expect(read).rejects.toMatchObject({ code: 'REGISTRY_LOCK_FAILED' })
    } finally {
      if (!child.killed) child.kill('SIGKILL')
    }

    // The production default acquisition timeout is unchanged.
    expect(DEFAULT_LOCK_TIMEOUT_MS).toBe(60_000)
  })
})
