import { describe, expect, test } from 'bun:test'
import {
  buildPublishConfig,
  generateConfig,
  resolveChannelFromVersion,
  resolveProductName,
} from '../release-config'

describe('resolveChannelFromVersion', () => {
  // The channel is derived purely from the version string so a build always
  // publishes to the feed matching the artifact it produced (AC7/AC6).
  test('nightly version → nightly', () => {
    expect(resolveChannelFromVersion('0.10.3-nightly.20260619.1')).toBe('nightly')
  })

  test('plain semver → stable', () => {
    expect(resolveChannelFromVersion('0.10.3')).toBe('stable')
  })

  test('non-nightly prerelease (e.g. beta) → stable', () => {
    // Only the nightly format selects the nightly feed; other prereleases ride
    // the latest channel, matching the kata-code shape.
    expect(resolveChannelFromVersion('0.10.3-beta.1')).toBe('stable')
  })
})

describe('buildPublishConfig', () => {
  test('stable → github release, no channel key', () => {
    const cfg = buildPublishConfig('stable', 'gannonh/kata-agents')
    expect(cfg).toEqual({
      provider: 'github',
      owner: 'gannonh',
      repo: 'kata-agents',
      releaseType: 'release',
    })
    expect('channel' in cfg).toBe(false)
  })

  test('nightly → github prerelease with channel:nightly', () => {
    const cfg = buildPublishConfig('nightly', 'gannonh/kata-agents')
    expect(cfg).toEqual({
      provider: 'github',
      owner: 'gannonh',
      repo: 'kata-agents',
      releaseType: 'prerelease',
      channel: 'nightly',
    })
  })

  test('rejects malformed GITHUB_REPOSITORY', () => {
    expect(() => buildPublishConfig('stable', 'no-slash')).toThrow()
    expect(() => buildPublishConfig('stable', 'a/b/c')).toThrow()
    expect(() => buildPublishConfig('stable', '')).toThrow()
  })
})

describe('resolveProductName', () => {
  test('stable keeps base name', () => {
    expect(resolveProductName('stable')).toBe('Kata Agents')
  })

  test('nightly gets the (Nightly) suffix', () => {
    expect(resolveProductName('nightly')).toBe('Kata Agents (Nightly)')
  })
})

describe('generateConfig', () => {
  const base = {
    appId: 'com.lukilabs.craft-agent',
    productName: 'Kata Agents',
    publish: { provider: 'generic', url: 'https://agents.craft.do/electron/latest' },
    mac: { hardenedRuntime: true },
  }

  test('stable build replaces generic feed with github, keeps base name', () => {
    const out = generateConfig({
      base,
      version: '0.10.3',
      repository: 'gannonh/kata-agents',
    })
    expect(out.publish).toEqual([
      { provider: 'github', owner: 'gannonh', repo: 'kata-agents', releaseType: 'release' },
    ])
    expect(out.productName).toBe('Kata Agents')
    // Untouched fields survive (AC12: no identity-infra changes beyond the feed).
    expect(out.appId).toBe('com.lukilabs.craft-agent')
    expect(out.mac).toEqual({ hardenedRuntime: true })
  })

  test('nightly build injects prerelease channel + Nightly product name', () => {
    const out = generateConfig({
      base,
      version: '0.10.3-nightly.20260619.1',
      repository: 'gannonh/kata-agents',
    })
    expect(out.publish).toEqual([
      {
        provider: 'github',
        owner: 'gannonh',
        repo: 'kata-agents',
        releaseType: 'prerelease',
        channel: 'nightly',
      },
    ])
    expect(out.productName).toBe('Kata Agents (Nightly)')
    expect(out.appId).toBe('com.lukilabs.craft-agent')
  })

  test('explicit channel override wins over version inference', () => {
    const out = generateConfig({
      base,
      version: '0.10.3',
      repository: 'gannonh/kata-agents',
      channel: 'nightly',
    })
    expect((out.publish as Array<{ channel?: string }>)[0]?.channel).toBe('nightly')
  })
})
