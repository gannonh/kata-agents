import { describe, test, expect, afterEach } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  WorktreeRegistry,
  WorktreeRegistryError,
  getWorktreeRegistryEvidencePaths,
} from '../worktree-registry'
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
  test('upgrades V1 in place with recoverable hash-bound evidence and is idempotent', () => {
    const root = tmp()
    const path = join(root, 'registry.json')
    const source = writeV1(path, legacyRecord(root))
    const registry = new WorktreeRegistry(path)

    registry.load()
    const upgraded = registry.get('repo-aabbccdd') as ManagedWorktreeRecordV2
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
    registry.load()
    expect(statSync(path).mtimeMs).toBe(before)
    expect(registry.list()).toHaveLength(1)
  })

  test('fails closed on corrupt and unsupported sources without clearing source bytes', () => {
    const root = tmp()
    const path = join(root, 'registry.json')
    const corrupt = '{"version":2,"records":[}'
    writeFileSync(path, corrupt)
    const registry = new WorktreeRegistry(path)

    expect(() => registry.list()).toThrow(WorktreeRegistryError)
    try {
      registry.list()
    } catch (error) {
      expect(error).toMatchObject({ name: 'WorktreeRegistryError', code: 'REGISTRY_CORRUPT' })
    }
    expect(readFileSync(path, 'utf8')).toBe(corrupt)

    const unsupported = JSON.stringify({ version: 99, records: [] })
    writeFileSync(path, unsupported)
    expect(() => registry.load()).toThrow(WorktreeRegistryError)
    expect(readFileSync(path, 'utf8')).toBe(unsupported)
  })

  test('does not authorize stale cache after the source becomes corrupt', () => {
    const root = tmp()
    const path = join(root, 'registry.json')
    const registry = new WorktreeRegistry(path)
    registry.upsert(legacyRecord(root))
    const corrupt = '{"version":2,"records":'
    writeFileSync(path, corrupt)

    expect(() => registry.get('repo-aabbccdd')).toThrow(WorktreeRegistryError)
    expect(readFileSync(path, 'utf8')).toBe(corrupt)
  })

  test('recovers a missing fixed registry from the preserved V1 source backup', () => {
    const root = tmp()
    const path = join(root, 'registry.json')
    writeV1(path, legacyRecord(root))
    const registry = new WorktreeRegistry(path)
    registry.load()
    rmSync(path)

    const recovered = new WorktreeRegistry(path)
    expect(recovered.list()).toHaveLength(1)
    expect((recovered.get('repo-aabbccdd') as ManagedWorktreeRecordV2).schemaVersion).toBe(2)
    expect(existsSync(path)).toBe(true)
  })

  test('fails closed instead of restoring an old V1 backup after later V2 mutation', () => {
    const root = tmp()
    const path = join(root, 'registry.json')
    writeV1(path, legacyRecord(root))
    const registry = new WorktreeRegistry(path)
    registry.load()
    registry.upsert(legacyRecord(root, 'repo-eeff0011'))
    const backup = readFileSync(getWorktreeRegistryEvidencePaths(path).backupPath)
    rmSync(path)

    const recovered = new WorktreeRegistry(path)
    expect(() => recovered.list()).toThrow(WorktreeRegistryError)
    try {
      recovered.list()
    } catch (error) {
      expect(error).toMatchObject({ code: 'REGISTRY_CONFLICT' })
    }
    expect(existsSync(path)).toBe(false)
    expect(readFileSync(getWorktreeRegistryEvidencePaths(path).backupPath)).toEqual(backup)
  })

  test('rejects a divergent source against a complete registry hash marker', () => {
    const root = tmp()
    const path = join(root, 'registry.json')
    writeV1(path, legacyRecord(root))
    const registry = new WorktreeRegistry(path)
    registry.load()
    const current = registry.get('repo-aabbccdd') as ManagedWorktreeRecordV2
    const divergent = {
      ...current,
      managedWorktreeId: 'repo-eeff0011',
      expectedBranch: 'kata-agent/eeff0011',
      displayName: 'eeff0011',
      checkoutPath: join(root, 'workspace-1', '0123456789abcdef', 'eeff0011'),
    }
    writeFileSync(path, JSON.stringify({ version: 2, records: [current, divergent] }, null, 2) + '\n')
    const source = readFileSync(path, 'utf8')

    expect(() => registry.load()).toThrow(WorktreeRegistryError)
    try {
      registry.load()
    } catch (error) {
      expect(error).toMatchObject({ code: 'REGISTRY_CONFLICT' })
    }
    expect(readFileSync(path, 'utf8')).toBe(source)
  })

  test('rejects a source that conflicts with prior upgrade evidence', () => {
    const root = tmp()
    const path = join(root, 'registry.json')
    writeV1(path, legacyRecord(root))
    const registry = new WorktreeRegistry(path)
    registry.load()

    // A V1 source with a different hash after an upgrade is not safe to
    // overwrite with stale migration output.
    const changed = writeV1(path, { ...legacyRecord(root), ownerSessionIds: ['new-owner'] })
    expect(() => registry.load()).toThrow(WorktreeRegistryError)
    try {
      registry.load()
    } catch (error) {
      expect(error).toMatchObject({ code: 'REGISTRY_CONFLICT' })
    }
    expect(readFileSync(path, 'utf8')).toBe(changed)
  })

  test('competing instances retain distinct read-modify-write records', () => {
    const root = tmp()
    const path = join(root, 'registry.json')
    const first = new WorktreeRegistry(path)
    const second = new WorktreeRegistry(path)
    first.upsert(legacyRecord(root, 'repo-aabbccdd'))
    second.upsert(legacyRecord(root, 'repo-eeff0011'))

    expect(first.list().map((record) => record.managedWorktreeId).sort()).toEqual([
      'repo-aabbccdd',
      'repo-eeff0011',
    ])
    expect(second.list()).toHaveLength(2)
  })
})
