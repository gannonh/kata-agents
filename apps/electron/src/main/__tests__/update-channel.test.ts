import { describe, expect, test } from 'bun:test'
import { resolveUpdateChannel } from '../update-channel'

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
