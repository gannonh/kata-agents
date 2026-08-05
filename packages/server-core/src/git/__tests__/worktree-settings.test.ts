import { describe, expect, test, afterEach } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createGitServices } from '../index'
import { WorktreeRegistry } from '../worktree-registry'
import { WorktreeSettingsError, WorktreeSettingsService } from '../worktree-settings-service'
import { cleanup, makeTmpDir } from './test-helpers'

const cleanups: string[] = []
function tmp(): string {
  const dir = makeTmpDir('kata-worktree-settings-test-')
  cleanups.push(dir)
  return dir
}

afterEach(() => {
  while (cleanups.length) cleanup(cleanups.pop()!)
})

function makeSettings() {
  const root = tmp()
  const defaultRoot = join(root, 'worktrees')
  const registryPath = join(defaultRoot, 'registry.json')
  const registry = new WorktreeRegistry(registryPath)
  const settings = new WorktreeSettingsService({
    serverId: 'server-a',
    defaultRoot,
    settingsPath: join(defaultRoot, 'settings.json'),
    registry,
    protectedPaths: [join(root, 'snapshots')],
  })
  return { root, defaultRoot, registry, settings }
}

describe('WorktreeSettingsService', () => {
  test('createGitServices rejects an injected settings service bound to a different registry', () => {
    const root = tmp()
    const foreignRoot = join(root, 'foreign')
    const foreignRegistry = new WorktreeRegistry(join(foreignRoot, 'registry.json'))
    const foreignSettings = new WorktreeSettingsService({
      serverId: 'foreign',
      defaultRoot: join(foreignRoot, 'worktrees'),
      settingsPath: join(foreignRoot, 'settings.json'),
      registry: foreignRegistry,
    })

    expect(() =>
      createGitServices({
        worktreeRoot: join(root, 'worktrees'),
        registryPath: join(root, 'worktrees', 'registry.json'),
        worktreeSettings: foreignSettings,
      }),
    ).toThrow(/active worktree registry/)
  })

  test('returns the default root as an immutable version-zero snapshot', () => {
    const { defaultRoot, settings } = makeSettings()

    const snapshot = settings.getSnapshot()

    expect(snapshot).toEqual({
      schemaVersion: 1,
      serverId: 'server-a',
      version: 0,
      materializationRoot: settings.expandPath(defaultRoot),
      capturedAt: expect.any(Number),
      autoDeleteEnabled: false,
      retentionLimit: 15,
    })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(existsSync(defaultRoot)).toBe(true)
  })

  test('persists auto-delete policy and retention limit per server', () => {
    const { root, settings } = makeSettings()

    const updated = settings.update({
      materializationRoot: join(root, 'custom-worktrees'),
      autoDeleteEnabled: false,
      retentionLimit: 3,
    })

    expect(updated.autoDeleteEnabled).toBe(false)
    expect(updated.retentionLimit).toBe(3)
    expect(updated.version).toBe(1)

    const reloaded = new WorktreeSettingsService({
      serverId: 'server-a',
      defaultRoot: join(root, 'worktrees'),
      settingsPath: join(root, 'worktrees', 'settings.json'),
      registry: new WorktreeRegistry(join(root, 'worktrees', 'registry.json')),
    })
    const snapshot = reloaded.getSnapshot()
    expect(snapshot.autoDeleteEnabled).toBe(false)
    expect(snapshot.retentionLimit).toBe(3)
    expect(snapshot.version).toBe(1)
  })

  test('rejects out-of-range retention limits and non-boolean auto-delete policy', () => {
    const { settings } = makeSettings()

    expect(() => settings.update({ materializationRoot: '~/x', retentionLimit: 0 })).toThrow(
      WorktreeSettingsError,
    )
    expect(() => settings.update({ materializationRoot: '~/x', retentionLimit: 1001 })).toThrow(
      WorktreeSettingsError,
    )
    expect(() => settings.update({ materializationRoot: '~/x', retentionLimit: 2.5 })).toThrow(
      WorktreeSettingsError,
    )
    expect(() =>
      settings.update({ materializationRoot: '~/x', autoDeleteEnabled: 'yes' as never }),
    ).toThrow(WorktreeSettingsError)
  })

  test('loads policy defaults when an existing settings file lacks them', () => {
    const { root, defaultRoot, settings } = makeSettings()
    mkdirSync(defaultRoot, { recursive: true })
    writeFileSync(
      join(defaultRoot, 'settings.json'),
      JSON.stringify({
        schemaVersion: 1,
        version: 4,
        materializationRoot: settings.expandPath(defaultRoot),
      }),
      'utf8',
    )
    const reloaded = new WorktreeSettingsService({
      serverId: 'server-a',
      defaultRoot,
      settingsPath: join(defaultRoot, 'settings.json'),
      registry: new WorktreeRegistry(join(defaultRoot, 'registry.json')),
    })
    const snapshot = reloaded.getSnapshot()
    expect(snapshot.autoDeleteEnabled).toBe(false)
    expect(snapshot.retentionLimit).toBe(15)
  })

  test('persists canonical absolute roots and increments the revision', () => {
    const { root, settings } = makeSettings()
    const customRoot = join(root, 'custom-worktrees')

    const updated = settings.update({ materializationRoot: customRoot })
    const reloaded = new WorktreeSettingsService({
      serverId: 'server-a',
      defaultRoot: join(root, 'worktrees'),
      settingsPath: join(root, 'worktrees', 'settings.json'),
      registry: new WorktreeRegistry(join(root, 'worktrees', 'registry.json')),
    })

    expect(updated.version).toBe(1)
    expect(updated.materializationRoot).toBe(settings.expandPath(customRoot))
    expect(reloaded.getSnapshot().materializationRoot).toBe(reloaded.expandPath(customRoot))
    expect(reloaded.getSnapshot().version).toBe(1)
    expect(existsSync(customRoot)).toBe(true)
  })

  test('expands a leading tilde and rejects relative or empty roots', () => {
    const { settings } = makeSettings()

    expect(() => settings.update({ materializationRoot: '' })).toThrow(WorktreeSettingsError)
    expect(() => settings.update({ materializationRoot: 'relative/path' })).toThrow(WorktreeSettingsError)
    expect(() => settings.update({ materializationRoot: '   ' })).toThrow(WorktreeSettingsError)
    expect(settings.expandPath('~/kata-worktrees')).toMatch(/kata-worktrees$/)
  })

  test('rejects protected, repository-overlapping, and registered-checkout roots', () => {
    const { root, registry, settings } = makeSettings()
    const repositoryRoot = join(root, 'repository')
    const checkoutPath = join(root, 'existing-checkout')
    mkdirSync(repositoryRoot, { recursive: true })
    mkdirSync(checkoutPath, { recursive: true })
    registry.upsert({
      managedWorktreeId: 'repo-aabbccdd',
      workspaceId: 'workspace',
      repositoryRoot,
      gitCommonDir: join(repositoryRoot, '.git'),
      checkoutPath,
      baseRef: 'main',
      expectedBranch: 'kata-agent/aabbccdd',
      createdAt: 1,
      ownerSessionIds: ['session'],
      state: 'ready',
    })

    expect(() => settings.update({ materializationRoot: join(root, 'snapshots', 'nested') })).toThrow(/protected/i)
    expect(() => settings.update({ materializationRoot: join(repositoryRoot, 'nested') })).toThrow(/repository/i)
    expect(() => settings.update({ materializationRoot: join(checkoutPath, 'nested') })).toThrow(/checkout/i)
  })

  test('allows resetting to the default root after managed checkouts exist', () => {
    const { root, defaultRoot, registry, settings } = makeSettings()
    registry.upsert({
      managedWorktreeId: 'repo-aabbccdd',
      workspaceId: 'workspace',
      repositoryRoot: join(root, 'repository'),
      gitCommonDir: join(root, 'repository', '.git'),
      checkoutPath: join(defaultRoot, 'workspace', '0123456789abcdef', 'aabbccdd'),
      baseRef: 'main',
      expectedBranch: 'kata-agent/aabbccdd',
      createdAt: 1,
      ownerSessionIds: ['session'],
      state: 'ready',
    })
    settings.update({ materializationRoot: join(root, 'custom') })

    const reset = settings.update({ materializationRoot: defaultRoot })

    expect(reset.materializationRoot).toBe(settings.expandPath(defaultRoot))
    expect(reset.version).toBe(2)
  })

  test('serializes updates from separate service instances', () => {
    const { root, defaultRoot } = makeSettings()
    const settingsPath = join(defaultRoot, 'settings.json')
    const registryPath = join(defaultRoot, 'registry.json')
    const first = new WorktreeSettingsService({
      serverId: 'server-a',
      defaultRoot,
      settingsPath,
      registry: new WorktreeRegistry(registryPath),
    })
    const second = new WorktreeSettingsService({
      serverId: 'server-a',
      defaultRoot,
      settingsPath,
      registry: new WorktreeRegistry(registryPath),
    })

    expect(first.update({ materializationRoot: join(root, 'one') }).version).toBe(1)
    expect(second.update({ materializationRoot: join(root, 'two') }).version).toBe(2)
    expect(first.getSnapshot().materializationRoot).toBe(first.expandPath(join(root, 'two')))
  })
})
