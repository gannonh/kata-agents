import { describe, expect, test } from 'bun:test'
import {
  buildPublishConfig,
  generateConfig,
  resolveChannelFromVersion,
  resolveProductName,
  restrictMacArch,
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

  test('arch pins macOS targets to the single build arch', () => {
    // Each matrix leg must build ONE arch so the two legs do not emit
    // identically-named zips that collide (and corrupt) on artifact merge.
    const dualArchBase = {
      mac: {
        hardenedRuntime: true,
        target: [
          { target: 'dmg', arch: ['arm64', 'x64'] },
          { target: 'zip', arch: ['arm64', 'x64'] },
        ],
      },
    }
    const out = generateConfig({
      base: dualArchBase,
      version: '0.10.3-nightly.20260619.1',
      repository: 'gannonh/kata-agents',
      arch: 'arm64',
    })
    expect((out.mac as { target: unknown }).target).toEqual([
      { target: 'dmg', arch: ['arm64'] },
      { target: 'zip', arch: ['arm64'] },
    ])
  })
})

describe('restrictMacArch', () => {
  const base = {
    mac: {
      target: [
        { target: 'dmg', arch: ['arm64', 'x64'] },
        { target: 'zip', arch: ['arm64', 'x64'] },
      ],
    },
  }

  test('narrows every mac target offering the arch to that arch only', () => {
    expect(restrictMacArch(base, 'x64')).toEqual({
      mac: {
        target: [
          { target: 'dmg', arch: ['x64'] },
          { target: 'zip', arch: ['x64'] },
        ],
      },
    })
  })

  test('does not mutate the input config', () => {
    restrictMacArch(base, 'x64')
    expect(base.mac.target[0]?.arch).toEqual(['arm64', 'x64'])
  })

  test('leaves targets that do not offer the arch untouched', () => {
    const out = restrictMacArch(
      { mac: { target: [{ target: 'zip', arch: ['x64'] }] } },
      'arm64',
    )
    expect((out.mac as { target: unknown }).target).toEqual([{ target: 'zip', arch: ['x64'] }])
  })

  test('no-op when mac config has no target array', () => {
    const cfg = { mac: { hardenedRuntime: true } }
    expect(restrictMacArch(cfg, 'arm64')).toBe(cfg)
  })
})
