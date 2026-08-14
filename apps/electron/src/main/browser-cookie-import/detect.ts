import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  BrowserCookieProfile,
  BrowserCookieSource,
  BrowserCookieSourceFamily,
} from '@kata-sh/shared/protocol'
import { resolveChromiumCookiesPath } from './chromium-cookie-path'

export type ChromiumBrowserDef = {
  family: BrowserCookieSourceFamily
  label: string
  keychainService: string
  keychainAccount: string
  macRoot: string
  winRoot: string
  linuxRoot: string
}

/**
 * Extension point: add Chromium-family entries here. Chrome is the only
 * required product source for this issue.
 */
export const CHROMIUM_BROWSERS: readonly ChromiumBrowserDef[] = [
  {
    family: 'chrome',
    label: 'Google Chrome',
    keychainService: 'Chrome Safe Storage',
    keychainAccount: 'Chrome',
    macRoot: 'Google/Chrome',
    winRoot: 'Google/Chrome/User Data',
    linuxRoot: 'google-chrome',
  },
]

export type DetectedBrowser = {
  family: BrowserCookieSourceFamily
  label: string
  cookiesPath: string
  keychainService: string
  keychainAccount: string
  profiles: BrowserCookieProfile[]
  selectedProfile: string
}

export type CookieImportDetectFs = {
  existsSync: (path: string) => boolean
  readFileSync: (path: string, encoding: 'utf-8') => string
}

export type DetectCookieSourcesOptions = {
  platform?: NodeJS.Platform
  home?: string
  localAppData?: string
  xdgConfigHome?: string
  fs?: CookieImportDetectFs
}

const defaultFs: CookieImportDetectFs = {
  existsSync,
  readFileSync: (path, encoding) => readFileSync(path, encoding),
}

export function isSafeBrowserProfileDirectory(directory: string): boolean {
  return (
    directory.length > 0 &&
    directory !== '.' &&
    !directory.includes('\0') &&
    !directory.includes('/') &&
    !directory.includes('\\') &&
    !directory.includes('..')
  )
}

export function browserRootPath(
  def: ChromiumBrowserDef,
  options: DetectCookieSourcesOptions = {},
): string | null {
  const platform = options.platform ?? process.platform
  if (platform === 'darwin') {
    const home = options.home ?? process.env.HOME ?? ''
    return join(home, 'Library', 'Application Support', def.macRoot)
  }
  if (platform === 'win32') {
    const localAppData = options.localAppData ?? process.env.LOCALAPPDATA ?? ''
    if (!localAppData) return null
    return join(localAppData, def.winRoot)
  }
  if (platform === 'linux') {
    const home = options.home ?? process.env.HOME ?? ''
    const configHome = options.xdgConfigHome ?? process.env.XDG_CONFIG_HOME ?? join(home, '.config')
    return join(configHome, def.linuxRoot)
  }
  return null
}

export function discoverProfiles(
  browserRoot: string,
  fs: CookieImportDetectFs = defaultFs,
): BrowserCookieProfile[] {
  try {
    const localStatePath = join(browserRoot, 'Local State')
    if (!fs.existsSync(localStatePath)) {
      return [{ name: 'Default', directory: 'Default' }]
    }
    const raw = fs.readFileSync(localStatePath, 'utf-8')
    const localState = JSON.parse(raw) as { profile?: { info_cache?: Record<string, { name?: unknown }> } }
    const infoCache = localState?.profile?.info_cache
    if (!infoCache || typeof infoCache !== 'object') {
      return [{ name: 'Default', directory: 'Default' }]
    }
    const profiles: BrowserCookieProfile[] = []
    for (const [dir, info] of Object.entries(infoCache)) {
      if (!isSafeBrowserProfileDirectory(dir)) continue
      const profileName = typeof info?.name === 'string' && info.name.length > 0 ? info.name : dir
      profiles.push({ name: profileName, directory: dir })
    }
    return profiles.length > 0 ? profiles : [{ name: 'Default', directory: 'Default' }]
  } catch {
    return [{ name: 'Default', directory: 'Default' }]
  }
}

export function detectInstalledBrowsers(options: DetectCookieSourcesOptions = {}): DetectedBrowser[] {
  const fs = options.fs ?? defaultFs
  const detected: DetectedBrowser[] = []
  for (const browser of CHROMIUM_BROWSERS) {
    const root = browserRootPath(browser, options)
    if (!root) continue
    const profiles = discoverProfiles(root, fs)
    for (const profile of profiles) {
      const cookiesPath = resolveChromiumCookiesPath(join(root, profile.directory), fs.existsSync)
      if (!cookiesPath) continue
      detected.push({
        family: browser.family,
        label: browser.label,
        keychainService: browser.keychainService,
        keychainAccount: browser.keychainAccount,
        cookiesPath,
        profiles,
        selectedProfile: profile.directory,
      })
      break
    }
  }
  return detected
}

export function selectBrowserProfile(
  browser: DetectedBrowser,
  profileDirectory: string,
  options: DetectCookieSourcesOptions = {},
): DetectedBrowser | null {
  if (!isSafeBrowserProfileDirectory(profileDirectory)) return null
  const browserDef = CHROMIUM_BROWSERS.find((item) => item.family === browser.family)
  if (!browserDef) return null
  const root = browserRootPath(browserDef, options)
  if (!root) return null
  const fs = options.fs ?? defaultFs
  const cookiesPath = resolveChromiumCookiesPath(join(root, profileDirectory), fs.existsSync)
  if (!cookiesPath) return null
  return {
    ...browser,
    cookiesPath,
    selectedProfile: profileDirectory,
  }
}

export function toRendererCookieSource(browser: DetectedBrowser): BrowserCookieSource {
  return {
    family: browser.family,
    label: browser.label,
    profiles: browser.profiles,
    selectedProfile: browser.selectedProfile,
  }
}

export function detectInstalledCookieSources(options: DetectCookieSourcesOptions = {}): BrowserCookieSource[] {
  return detectInstalledBrowsers(options).map(toRendererCookieSource)
}
