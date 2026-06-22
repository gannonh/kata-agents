import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href
const UPDATE_CHANNEL_MODULE_PATH = pathToFileURL(
  join(import.meta.dir, '..', '..', '..', '..', 'apps', 'electron', 'src', 'main', 'update-channel.ts'),
).href

/**
 * Create an isolated config dir with a valid root config (one workspace) so
 * loadStoredConfig()'s workspaces-array + active-workspace validation passes.
 * Mirrors the setup in storage-update-llm-connection.test.ts.
 */
function setup(extraConfig: Record<string, unknown> = {}) {
  const configDir = mkdtempSync(join(tmpdir(), 'craft-agent-config-'))
  const workspaceRoot = join(configDir, 'workspaces', 'my-workspace')
  mkdirSync(workspaceRoot, { recursive: true })

  writeFileSync(
    join(workspaceRoot, 'config.json'),
    JSON.stringify({
      id: 'ws-config-1',
      name: 'My Workspace',
      slug: 'my-workspace',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }, null, 2),
    'utf-8',
  )

  const configPath = join(configDir, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      workspaces: [{ id: 'ws-1', name: 'My Workspace', rootPath: workspaceRoot, createdAt: Date.now() }],
      activeWorkspaceId: 'ws-1',
      activeSessionId: null,
      ...extraConfig,
    }, null, 2),
    'utf-8',
  )

  function readConfig(): Record<string, unknown> {
    return JSON.parse(readFileSync(configPath, 'utf-8'))
  }

  function runWithStorage<T>(fnBody: string): T {
    const run = Bun.spawnSync([
      process.execPath,
      '--eval',
      `import { ${fnBody.includes('loadStoredConfig') ? 'loadStoredConfig,' : ''} setUpdateChannel, getUpdateChannel } from '${STORAGE_MODULE_PATH}'; ${fnBody}`,
    ], {
      env: { ...process.env, CRAFT_CONFIG_DIR: configDir },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (run.exitCode !== 0) {
      throw new Error(`storage subprocess failed:\n${run.stdout.toString()}\n${run.stderr.toString()}`)
    }
    return JSON.parse(run.stdout.toString() || 'null') as T
  }

  return { configDir, configPath, readConfig, runWithStorage }
}

describe('updateChannel persistence', () => {
  // AC6: a persisted user selection overrides the version-derived default,
  // and the configuredByUser flag is what distinguishes an explicit choice
  // from a stale/legacy value. These tests pin the round-trip the controller
  // relies on: set → get must return exactly what was written.
  it('round-trips a nightly preference with configuredByUser=true', () => {
    const { runWithStorage, readConfig } = setup()

    runWithStorage('setUpdateChannel("nightly")')

    const config = readConfig()
    expect(config.updateChannel).toBe('nightly')
    expect(config.updateChannelConfiguredByUser).toBe(true)

    const result = runWithStorage<{ channel: string; configuredByUser: boolean }>(
      `const r = getUpdateChannel("0.10.3"); console.log(JSON.stringify(r));`,
    )
    expect(result.channel).toBe('nightly')
    expect(result.configuredByUser).toBe(true)
  })

  it('round-trips a latest preference with configuredByUser=true', () => {
    const { runWithStorage, readConfig } = setup()

    runWithStorage('setUpdateChannel("latest")')

    const config = readConfig()
    expect(config.updateChannel).toBe('latest')
    expect(config.updateChannelConfiguredByUser).toBe(true)

    const result = runWithStorage<{ channel: string; configuredByUser: boolean }>(
      `const r = getUpdateChannel("0.10.3-nightly.20260619.1"); console.log(JSON.stringify(r));`,
    )
    // User explicitly chose latest even though installed build is nightly.
    expect(result.channel).toBe('latest')
    expect(result.configuredByUser).toBe(true)
  })

  it('returns version-derived default when no preference is persisted', () => {
    const { runWithStorage } = setup()

    const stable = runWithStorage<{ channel: string; configuredByUser: boolean }>(
      `const r = getUpdateChannel("0.10.3"); console.log(JSON.stringify(r));`,
    )
    expect(stable.channel).toBe('latest')
    expect(stable.configuredByUser).toBe(false)

    const nightly = runWithStorage<{ channel: string; configuredByUser: boolean }>(
      `const r = getUpdateChannel("0.10.3-nightly.20260619.1"); console.log(JSON.stringify(r));`,
    )
    expect(nightly.channel).toBe('nightly')
    expect(nightly.configuredByUser).toBe(false)
  })

  it('legacy config (channel set, configuredByUser missing) falls back to version default', () => {
    // An old config written before this feature has updateChannel: 'nightly'
    // but no configuredByUser flag. We must NOT honor it as an explicit choice;
    // a stable build would otherwise silently track the nightly feed.
    const { runWithStorage } = setup({ updateChannel: 'nightly' })

    const result = runWithStorage<{ channel: string; configuredByUser: boolean }>(
      `const r = getUpdateChannel("0.10.3"); console.log(JSON.stringify(r));`,
    )
    expect(result.channel).toBe('latest')
    expect(result.configuredByUser).toBe(false)
  })

  it('setting a channel persists the written value across reads', () => {
    const { runWithStorage } = setup()

    runWithStorage('setUpdateChannel("nightly")')
    const first = runWithStorage<{ channel: string; configuredByUser: boolean }>(
      `const r = getUpdateChannel("0.10.3"); console.log(JSON.stringify(r));`,
    )
    expect(first.channel).toBe('nightly')

    // A second read in a fresh process must see the same persisted value
    // (proves it was actually written to disk, not just in-memory).
    const second = runWithStorage<{ channel: string; configuredByUser: boolean }>(
      `const r = getUpdateChannel("0.10.3"); console.log(JSON.stringify(r));`,
    )
    expect(second.channel).toBe('nightly')
    expect(second.configuredByUser).toBe(true)
  })
})
