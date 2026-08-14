import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  detectInstalledBrowsers,
  detectInstalledCookieSources,
  isSafeBrowserProfileDirectory,
  selectBrowserProfile,
  toRendererCookieSource,
} from '../detect'

function writeChromeInstall(root: string, profiles: Array<{ directory: string; name: string; cookies: 'network' | 'legacy' | 'none' }>) {
  const infoCache: Record<string, { name: string }> = {}
  for (const profile of profiles) {
    infoCache[profile.directory] = { name: profile.name }
    const profileDir = join(root, profile.directory)
    if (profile.cookies === 'network') {
      mkdirSync(join(profileDir, 'Network'), { recursive: true })
      writeFileSync(join(profileDir, 'Network', 'Cookies'), '')
    } else if (profile.cookies === 'legacy') {
      mkdirSync(profileDir, { recursive: true })
      writeFileSync(join(profileDir, 'Cookies'), '')
    } else {
      mkdirSync(profileDir, { recursive: true })
    }
  }
  writeFileSync(join(root, 'Local State'), JSON.stringify({ profile: { info_cache: infoCache } }))
}

describe('Chrome cookie source detection', () => {
  it('presents Chrome profiles without filesystem paths or keychain identifiers', () => {
    const home = mkdtempSync(join(tmpdir(), 'kata-chrome-detect-'))
    try {
      const chromeRoot = join(home, 'Library', 'Application Support', 'Google', 'Chrome')
      mkdirSync(chromeRoot, { recursive: true })
      writeChromeInstall(chromeRoot, [
        { directory: 'Default', name: 'Person 1', cookies: 'network' },
        { directory: 'Profile 1', name: 'Work', cookies: 'legacy' },
        { directory: '../escape', name: 'Bad', cookies: 'network' },
      ])

      const sources = detectInstalledCookieSources({ platform: 'darwin', home })
      expect(sources).toEqual([
        {
          family: 'chrome',
          label: 'Google Chrome',
          selectedProfile: 'Default',
          profiles: [
            { name: 'Person 1', directory: 'Default' },
            { name: 'Work', directory: 'Profile 1' },
          ],
        },
      ])

      const serialized = JSON.stringify(sources)
      expect(serialized).not.toContain(chromeRoot)
      expect(serialized).not.toContain('Cookies')
      expect(serialized).not.toContain('keychain')
      expect(serialized).not.toContain('Safe Storage')
      expect(serialized).not.toContain('Application Support')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('returns no sources when Chrome data is missing', () => {
    const home = mkdtempSync(join(tmpdir(), 'kata-chrome-missing-'))
    try {
      expect(detectInstalledCookieSources({ platform: 'darwin', home })).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('keeps internal detection secrets off the renderer mapping', () => {
    const home = mkdtempSync(join(tmpdir(), 'kata-chrome-internal-'))
    try {
      const chromeRoot = join(home, 'Library', 'Application Support', 'Google', 'Chrome')
      mkdirSync(chromeRoot, { recursive: true })
      writeChromeInstall(chromeRoot, [{ directory: 'Default', name: 'Person 1', cookies: 'network' }])
      const [internal] = detectInstalledBrowsers({ platform: 'darwin', home })
      expect(internal.cookiesPath).toContain('Cookies')
      expect(internal.keychainService).toBe('Chrome Safe Storage')
      const renderer = toRendererCookieSource(internal)
      expect(renderer).not.toHaveProperty('cookiesPath')
      expect(renderer).not.toHaveProperty('keychainService')
      expect(renderer).not.toHaveProperty('keychainAccount')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('rejects profile traversal and missing profile cookies', () => {
    const home = mkdtempSync(join(tmpdir(), 'kata-chrome-select-'))
    try {
      const chromeRoot = join(home, 'Library', 'Application Support', 'Google', 'Chrome')
      mkdirSync(chromeRoot, { recursive: true })
      writeChromeInstall(chromeRoot, [
        { directory: 'Default', name: 'Person 1', cookies: 'network' },
        { directory: 'Profile 1', name: 'Work', cookies: 'none' },
      ])
      const [browser] = detectInstalledBrowsers({ platform: 'darwin', home })
      expect(selectBrowserProfile(browser, '../etc', { platform: 'darwin', home })).toBeNull()
      expect(selectBrowserProfile(browser, 'Profile 1', { platform: 'darwin', home })).toBeNull()
      expect(selectBrowserProfile(browser, 'Default', { platform: 'darwin', home })?.selectedProfile).toBe('Default')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('detects Chrome on Windows and Linux roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'kata-chrome-cross-'))
    try {
      const winRoot = join(root, 'Local', 'Google', 'Chrome', 'User Data')
      mkdirSync(winRoot, { recursive: true })
      writeChromeInstall(winRoot, [{ directory: 'Default', name: 'Default', cookies: 'network' }])
      expect(
        detectInstalledCookieSources({
          platform: 'win32',
          localAppData: join(root, 'Local'),
        })[0]?.label,
      ).toBe('Google Chrome')

      const linuxRoot = join(root, '.config', 'google-chrome')
      mkdirSync(linuxRoot, { recursive: true })
      writeChromeInstall(linuxRoot, [{ directory: 'Default', name: 'Default', cookies: 'legacy' }])
      expect(
        detectInstalledCookieSources({
          platform: 'linux',
          home: root,
        })[0]?.profiles[0]?.directory,
      ).toBe('Default')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('treats empty, relative, and traversal directories as unsafe', () => {
    expect(isSafeBrowserProfileDirectory('')).toBe(false)
    expect(isSafeBrowserProfileDirectory('.')).toBe(false)
    expect(isSafeBrowserProfileDirectory('Default/../Other')).toBe(false)
    expect(isSafeBrowserProfileDirectory('Default\\Other')).toBe(false)
    expect(isSafeBrowserProfileDirectory('Default')).toBe(true)
  })
})
