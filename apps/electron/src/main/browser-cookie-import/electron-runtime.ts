import { execFileSync } from 'node:child_process'
import { app, session } from 'electron'
import { createCookieImportLogger } from './log'
import type { CookieImportRuntime } from './import-cookies'
import { mainLog } from '../logger'
import { applyPendingCookieImport } from './apply-pending'

export function getChromeUserAgent(platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== 'darwin') return null
  try {
    const version = execFileSync(
      'defaults',
      ['read', '/Applications/Google Chrome.app/Contents/Info', 'CFBundleShortVersionString'],
      { encoding: 'utf-8', timeout: 5_000 },
    ).trim()
    if (!version) return null
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`
  } catch {
    return null
  }
}

export function createElectronCookieImportRuntime(): CookieImportRuntime {
  return {
    getSession: (partition) => {
      const target = session.fromPartition(partition)
      return {
        cookies: {
          set: (details) => target.cookies.set(details),
          remove: (url, name) => target.cookies.remove(url, name),
          flushStore: () => target.cookies.flushStore(),
        },
        clearStorageData: (filter) => target.clearStorageData(filter),
        setUserAgent: (ua) => target.setUserAgent(ua),
      }
    },
    getUserDataPath: () => app.getPath('userData'),
    getUserAgent: () => getChromeUserAgent(),
    log: createCookieImportLogger((line) => mainLog.info(line)),
    platform: process.platform,
  }
}

let cookieImportPrepared = false

export function prepareBrowserCookiePartition(): void {
  if (cookieImportPrepared || !app.isReady()) return
  cookieImportPrepared = true
  applyPendingCookieImport({ userDataPath: app.getPath('userData') })
}
