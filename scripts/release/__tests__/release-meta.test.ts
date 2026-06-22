import { describe, expect, test } from 'bun:test'
import {
  resolveNightlyReleaseMetadata,
  resolveNightlyTargetVersion,
  resolveStableCore,
} from '../resolve-nightly-release'
import { mergeManifests } from '../merge-update-manifests'
import { setPackageVersion } from '../update-release-package-versions'
import {
  MACOS_RELEASE_SIGNING_SECRET_NAMES,
  resolveMacOsReleaseSigning,
} from '../check-macos-release-signing'

describe('resolveStableCore', () => {
  test('strips prerelease and build metadata', () => {
    expect(resolveStableCore('0.10.3-nightly.20260619.1')).toBe('0.10.3')
    expect(resolveStableCore('0.10.3+build.7')).toBe('0.10.3')
    expect(resolveStableCore('0.10.3')).toBe('0.10.3')
  })
})

describe('resolveNightlyTargetVersion', () => {
  // Nightlies are pre-releases of the NEXT patch so they sort above the current
  // stable release in semver (0.10.3 stable < 0.10.4-nightly.* < 0.10.4).
  test('bumps patch by one', () => {
    expect(resolveNightlyTargetVersion('0.10.3')).toBe('0.10.4')
    expect(resolveNightlyTargetVersion('0.10.3-nightly.20260619.1')).toBe('0.10.4')
  })

  test('rejects non-semver core', () => {
    expect(() => resolveNightlyTargetVersion('not.a.version')).toThrow()
  })
})

describe('resolveNightlyReleaseMetadata', () => {
  test('produces version, v-prefixed tag, name, and short sha', () => {
    const meta = resolveNightlyReleaseMetadata('0.10.4', '20260619', 7, 'abcdef0123456789')
    expect(meta.version).toBe('0.10.4-nightly.20260619.7')
    expect(meta.tag).toBe('v0.10.4-nightly.20260619.7')
    expect(meta.shortSha).toBe('abcdef012345')
    expect(meta.name).toContain('0.10.4-nightly.20260619.7')
    expect(meta.name).toContain('abcdef012345')
  })
})

describe('mergeManifests', () => {
  test('combines per-arch macOS file entries without path-level checksum metadata', () => {
    const merged = mergeManifests('mac', {
      version: '0.10.5-nightly.20260621.23',
      files: [{ url: 'Kata-Agents-arm64.zip', sha512: 'arm64', size: 1 }],
      path: 'Kata-Agents-arm64.zip',
      sha512: 'arm64',
      releaseDate: '2026-06-21T22:00:00.000Z',
    }, {
      version: '0.10.5-nightly.20260621.23',
      files: [{ url: 'Kata-Agents-x64.zip', sha512: 'x64', size: 2 }],
      path: 'Kata-Agents-x64.zip',
      sha512: 'x64',
      releaseDate: '2026-06-21T22:01:00.000Z',
    })

    expect(merged.files).toEqual([
      { url: 'Kata-Agents-arm64.zip', sha512: 'arm64', size: 1 },
      { url: 'Kata-Agents-x64.zip', sha512: 'x64', size: 2 },
    ])
    expect(merged.releaseDate).toBe('2026-06-21T22:01:00.000Z')
    expect(merged.path).toBeUndefined()
    expect(merged.sha512).toBeUndefined()
  })

  test('rejects conflicting entries for the same asset', () => {
    expect(() => mergeManifests('mac', {
      version: '0.10.5',
      files: [{ url: 'Kata-Agents-arm64.zip', sha512: 'a', size: 1 }],
      releaseDate: '2026-06-21T22:00:00.000Z',
    }, {
      version: '0.10.5',
      files: [{ url: 'Kata-Agents-arm64.zip', sha512: 'b', size: 1 }],
      releaseDate: '2026-06-21T22:00:00.000Z',
    })).toThrow(/conflicting file entry/)
  })
})

describe('setPackageVersion', () => {
  const pkg = '{\n  "name": "x",\n  "version": "0.10.3",\n  "private": true\n}\n'

  test('replaces the first version field and preserves formatting', () => {
    const { text, changed } = setPackageVersion(pkg, '0.10.4-nightly.20260619.7')
    expect(changed).toBe(true)
    expect(text).toContain('"version": "0.10.4-nightly.20260619.7"')
    // Surrounding lines untouched (no full reserialization).
    expect(text).toContain('"name": "x"')
    expect(text).toContain('"private": true')
  })

  test('is a no-op when version already matches', () => {
    const { text, changed } = setPackageVersion(pkg, '0.10.3')
    expect(changed).toBe(false)
    expect(text).toBe(pkg)
  })

  test('throws when no version field exists', () => {
    expect(() => setPackageVersion('{"name":"x"}', '1.0.0')).toThrow()
  })
})

describe('resolveMacOsReleaseSigning', () => {
  const full = {
    CSC_LINK: 'base64',
    CSC_KEY_PASSWORD: 'pw',
    APPLE_ID: 'id@example.com',
    APPLE_APP_SPECIFIC_PASSWORD: 'app-pw',
    APPLE_TEAM_ID: 'TEAM',
  }

  test('ready when all secrets present', () => {
    const r = resolveMacOsReleaseSigning(full)
    expect(r.ready).toBe(true)
    expect(r.missing).toEqual([])
  })

  test('reports each missing secret', () => {
    const r = resolveMacOsReleaseSigning({ ...full, CSC_LINK: undefined, APPLE_TEAM_ID: '' })
    expect(r.ready).toBe(false)
    expect(r.missing).toEqual(['CSC_LINK', 'APPLE_TEAM_ID'])
  })

  test('exposes the canonical secret-name list', () => {
    expect(MACOS_RELEASE_SIGNING_SECRET_NAMES).toEqual([
      'CSC_LINK',
      'CSC_KEY_PASSWORD',
      'APPLE_ID',
      'APPLE_APP_SPECIFIC_PASSWORD',
      'APPLE_TEAM_ID',
    ])
  })
})
