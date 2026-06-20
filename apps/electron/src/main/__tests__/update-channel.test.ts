import { describe, expect, test } from 'bun:test'
import { resolveUpdateChannel, resolveSelectedChannel } from '../update-channel'

describe('resolveUpdateChannel', () => {
  // The installed build's own version decides which feed it follows, so a
  // nightly install never silently jumps onto the stable channel (AC8).
  test('nightly version → nightly channel', () => {
    expect(resolveUpdateChannel('0.10.3-nightly.20260619.1')).toBe('nightly')
  })

  test('plain semver → latest channel', () => {
    // electron-updater's stable channel manifest is latest.yml, so stable maps
    // to the "latest" channel name (not "stable").
    expect(resolveUpdateChannel('0.10.3')).toBe('latest')
  })

  test('non-nightly prerelease → latest channel', () => {
    expect(resolveUpdateChannel('0.10.3-beta.1')).toBe('latest')
  })
})

describe('resolveSelectedChannel', () => {
  // AC6: the installed app version supplies the default channel; a persisted
  // user selection overrides that default. These tests pin the four
  // combinations the controller relies on, plus the legacy fallback that
  // prevents an old config (written before the configuredByUser flag existed)
  // from silently forcing a channel the user never chose.
  test('stable build with no preference → latest (default)', () => {
    const result = resolveSelectedChannel('0.10.3')
    expect(result.channel).toBe('latest')
    expect(result.configuredByUser).toBe(false)
  })

  test('nightly build with no preference → nightly (default)', () => {
    const result = resolveSelectedChannel('0.10.3-nightly.20260619.1')
    expect(result.channel).toBe('nightly')
    expect(result.configuredByUser).toBe(false)
  })

  test('stable build with user preference nightly → nightly (override)', () => {
    const result = resolveSelectedChannel('0.10.3', {
      channel: 'nightly',
      configuredByUser: true,
    })
    expect(result.channel).toBe('nightly')
    expect(result.configuredByUser).toBe(true)
  })

  test('nightly build with user preference latest → latest (override)', () => {
    const result = resolveSelectedChannel('0.10.3-nightly.20260619.1', {
      channel: 'latest',
      configuredByUser: true,
    })
    expect(result.channel).toBe('latest')
    expect(result.configuredByUser).toBe(true)
  })

  test('legacy config without configuredByUser flag → version-derived default', () => {
    // An old config may carry an updateChannel value but no configuredByUser
    // flag (written before this feature existed). We must NOT honor that stale
    // value as an explicit user choice; fall back to the version-derived
    // default so a stable build never silently tracks nightly.
    const result = resolveSelectedChannel('0.10.3', {
      channel: 'nightly',
      configuredByUser: undefined,
    })
    expect(result.channel).toBe('latest')
    expect(result.configuredByUser).toBe(false)
  })

  test('explicit user preference matching the version default is still configured', () => {
    // If the user on a nightly build explicitly picks nightly, that's still a
    // user-configured state (not the same as "never configured").
    const result = resolveSelectedChannel('0.10.3-nightly.20260619.1', {
      channel: 'nightly',
      configuredByUser: true,
    })
    expect(result.channel).toBe('nightly')
    expect(result.configuredByUser).toBe(true)
  })
})
