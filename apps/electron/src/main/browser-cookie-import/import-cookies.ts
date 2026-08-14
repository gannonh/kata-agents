import { copyFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  BrowserCookieImportResult,
  BrowserCookieImportSummary,
  CookieImportErrorCode,
} from '@kata-sh/shared/protocol'
import { DEFAULT_KATA_BROWSER_PROFILE_ID } from '@kata-sh/shared/protocol'
import { DEFAULT_BROWSER_PARTITION, partitionCookiesDir } from './apply-pending'
import { resolveChromiumCookiesPath } from './chromium-cookie-path'
import { createChromiumCookieSnapshot } from './chromium-cookie-snapshot'
import { decryptCookieValueRaw, getEncryptionKey, type EncryptionKeyResult } from './decrypt'
import type { DetectedBrowser } from './detect'
import { buildChromiumCookieInsertParams, type ChromiumCookieColumnInfo } from './insert-params'
import { createCookieImportLogger, type CookieImportLog } from './log'
import { openCookieDatabase, type CookieSqliteDatabase } from './sqlite'
import {
  clearPendingCookieImport,
  createFileCookieImportStateStore,
  recordLastImport,
  setPendingCookieImport,
  type CookieImportStateStore,
} from './state'
import {
  chromiumSameSite,
  chromiumTimestampToUnix,
  deriveUrl,
  isExpiredUnix,
  isIntegrityCookie,
  type CookieSameSite,
} from './validate'

export type CookieSetDetails = {
  url: string
  name: string
  value: string
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  sameSite?: CookieSameSite
  expirationDate?: number
}

export type CookieImportSession = {
  cookies: {
    set: (details: CookieSetDetails) => Promise<void>
    remove: (url: string, name: string) => Promise<void>
    flushStore: () => Promise<void>
  }
  clearStorageData: (filter: { storages: Array<'cookies'> }) => Promise<void>
  setUserAgent?: (ua: string) => void
}

export type CookieImportRuntime = {
  getSession: (partition: string) => CookieImportSession
  getUserDataPath: () => string
  getEncryptionKey?: (
    service: string,
    account: string,
    browser: DetectedBrowser,
  ) => EncryptionKeyResult | null
  getUserAgent?: (family: DetectedBrowser['family']) => string | null
  now?: () => number
  log?: CookieImportLog
  store?: CookieImportStateStore
  openDatabase?: typeof openCookieDatabase
  platform?: NodeJS.Platform
}

type DecryptedCookie = {
  decryptedValue: Buffer
  value: string
  domain: string
  name: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: CookieSameSite
  expirationDate: number | undefined
}

function fail(code: CookieImportErrorCode): BrowserCookieImportResult {
  return { ok: false, code }
}

function discardFile(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    /* best-effort */
  }
}

export async function importCookiesFromDetectedBrowser(
  browser: DetectedBrowser,
  options: CookieImportRuntime & {
    partition?: string
    profileId?: string
  } = {
    getSession: () => {
      throw new Error('getSession required')
    },
    getUserDataPath: () => {
      throw new Error('getUserDataPath required')
    },
  },
): Promise<BrowserCookieImportResult> {
  const partition = options.partition ?? DEFAULT_BROWSER_PARTITION
  const profileId = options.profileId ?? DEFAULT_KATA_BROWSER_PROFILE_ID
  const log = options.log ?? createCookieImportLogger(() => {})
  const nowSeconds = Math.floor((options.now?.() ?? Date.now()) / 1000)
  const openDatabase = options.openDatabase ?? openCookieDatabase
  const userDataPath = options.getUserDataPath()
  const store = options.store ?? createFileCookieImportStateStore(userDataPath)
  const resolveKey = options.getEncryptionKey
    ?? ((service: string, account: string, detected: DetectedBrowser) =>
      getEncryptionKey(service, account, detected, {}, options.platform ?? process.platform))

  log('import start', { family: browser.family, partition })

  if (!existsSync(browser.cookiesPath)) {
    return fail('cookies-missing')
  }

  const targetSession = options.getSession(partition)
  await targetSession.cookies.flushStore()

  const partitionDir = partitionCookiesDir(userDataPath, partition)
  let liveCookiesPath = resolveChromiumCookiesPath(partitionDir)

  if (!liveCookiesPath) {
    try {
      await targetSession.cookies.set({ url: 'https://localhost', name: '__init', value: '1' })
      await targetSession.cookies.remove('https://localhost', '__init')
      await targetSession.cookies.flushStore()
    } catch {
      /* flushStore may still create the file */
    }
    liveCookiesPath = resolveChromiumCookiesPath(partitionDir)
  }

  if (!liveCookiesPath) {
    return fail('session-unavailable')
  }

  const stagingDir = join(userDataPath, 'cookie-import-staging')
  const partitionSegment = partition.replace('persist:', '').replace(/[^a-zA-Z0-9_-]/g, '_')
  const stagingCookiesPath = join(stagingDir, `Cookies-${partitionSegment}-${Date.now()}-${randomUUID()}`)
  let stagingAvailable = false
  try {
    mkdirSync(stagingDir, { recursive: true })
    copyFileSync(liveCookiesPath, stagingCookiesPath)
    stagingAvailable = true
  } catch (err) {
    log('staging copy unavailable', { code: (err as NodeJS.ErrnoException).code })
    discardFile(stagingCookiesPath)
  }

  let sourceSnapshot: ReturnType<typeof createChromiumCookieSnapshot>
  try {
    sourceSnapshot = createChromiumCookieSnapshot(browser.cookiesPath)
  } catch {
    discardFile(stagingCookiesPath)
    return fail('cookies-locked')
  }

  let sourceDb: CookieSqliteDatabase | null = null
  let stagingDb: CookieSqliteDatabase | null = null
  const closeStagingDb = (): void => {
    try {
      stagingDb?.close()
    } catch {
      /* best-effort */
    }
    stagingDb = null
  }

  try {
    sourceDb = openDatabase(sourceSnapshot.databasePath, { readOnly: true, readBigInts: true })
    let targetColumnInfo: ChromiumCookieColumnInfo[] | null = null
    let colList: string | null = null
    let placeholders: string | null = null
    if (stagingAvailable) {
      try {
        stagingDb = openDatabase(stagingCookiesPath)
        targetColumnInfo = stagingDb.prepare('PRAGMA table_info(cookies)').all() as ChromiumCookieColumnInfo[]
        const targetCols = targetColumnInfo.map((row) => row.name)
        colList = targetCols.join(', ')
        placeholders = targetCols.map(() => '?').join(', ')
        stagingDb.exec('DELETE FROM cookies')
      } catch (err) {
        log('staging database unusable', { error: String(err) })
        stagingAvailable = false
        targetColumnInfo = null
        colList = null
        placeholders = null
        closeStagingDb()
        discardFile(stagingCookiesPath)
      }
    }

    const sourceRows = sourceDb.prepare('SELECT * FROM cookies ORDER BY rowid').all()
    sourceDb.close()
    sourceDb = null

    if (sourceRows.length === 0) {
      closeStagingDb()
      discardFile(stagingCookiesPath)
      return fail('empty-import')
    }

    const needsSourceKey = sourceRows.some((sourceRow) => {
      const encRaw = sourceRow.encrypted_value
      return encRaw instanceof Uint8Array && encRaw.length > 0
    })
    const sourceKey = needsSourceKey
      ? resolveKey(browser.keychainService, browser.keychainAccount, browser)
      : null
    if (needsSourceKey && !['darwin', 'linux', 'win32'].includes(options.platform ?? process.platform)) {
      closeStagingDb()
      discardFile(stagingCookiesPath)
      return fail('unsupported-platform')
    }
    if (needsSourceKey && !sourceKey) {
      closeStagingDb()
      discardFile(stagingCookiesPath)
      return fail('keychain-denied')
    }

    let skipped = 0
    const domainSet = new Set<string>()
    const decryptedCookies: DecryptedCookie[] = []
    let decryptFailures = 0

    let insertStmt: ReturnType<CookieSqliteDatabase['prepare']> | null = null
    const disableStaging = (reason: string): void => {
      log('staging disabled', { reason })
      stagingAvailable = false
      insertStmt = null
      closeStagingDb()
      discardFile(stagingCookiesPath)
    }

    if (stagingDb && colList && placeholders) {
      try {
        insertStmt = stagingDb.prepare(`INSERT OR REPLACE INTO cookies (${colList}) VALUES (${placeholders})`)
        stagingDb.exec('BEGIN TRANSACTION')
      } catch (err) {
        disableStaging(String(err))
      }
    } else if (stagingAvailable) {
      disableStaging('staged database exposed no cookies columns')
    }

    for (const sourceRow of sourceRows) {
      const encRaw = sourceRow.encrypted_value
      const encBuf = encRaw instanceof Uint8Array ? Buffer.from(encRaw) : null
      const plainRaw = sourceRow.value

      let decryptedValue: Buffer
      if (encBuf && encBuf.length > 0) {
        const raw = sourceKey ? decryptCookieValueRaw(encBuf, sourceKey) : null
        if (!raw) {
          skipped++
          decryptFailures++
          continue
        }
        decryptedValue = raw
      } else if (plainRaw instanceof Uint8Array) {
        decryptedValue = Buffer.from(plainRaw)
      } else if (typeof plainRaw === 'string') {
        decryptedValue = Buffer.from(plainRaw, 'latin1')
      } else {
        decryptedValue = Buffer.alloc(0)
      }

      const domain = String(sourceRow.host_key ?? '')
      const name = String(sourceRow.name ?? '')
      if (!domain || !name) {
        skipped++
        continue
      }
      if (isIntegrityCookie(name, domain)) {
        skipped++
        continue
      }

      const expiresUtc = chromiumTimestampToUnix((sourceRow.expires_utc as bigint | number | string) ?? 0)
      if (isExpiredUnix(expiresUtc > 0 ? expiresUtc : undefined, nowSeconds)) {
        skipped++
        continue
      }

      const secure = sourceRow.is_secure === 1n || sourceRow.is_secure === 1
      const httpOnly = sourceRow.is_httponly === 1n || sourceRow.is_httponly === 1
      const sameSite = chromiumSameSite(Number(sourceRow.samesite ?? 0))
      const path = typeof sourceRow.path === 'string' && sourceRow.path.length > 0 ? sourceRow.path : '/'
      const value = decryptedValue.toString('latin1')
      const cleanDomain = domain.startsWith('.') ? domain.slice(1) : domain
      domainSet.add(cleanDomain)

      decryptedCookies.push({
        decryptedValue,
        value,
        domain,
        name,
        path,
        secure,
        httpOnly,
        sameSite,
        expirationDate: expiresUtc > 0 ? expiresUtc : undefined,
      })

      if (insertStmt && targetColumnInfo) {
        try {
          insertStmt.run(...buildChromiumCookieInsertParams(targetColumnInfo, sourceRow, decryptedValue))
        } catch (err) {
          disableStaging(String(err))
        }
      }
    }

    if (needsSourceKey && decryptFailures === sourceRows.length) {
      closeStagingDb()
      discardFile(stagingCookiesPath)
      if (sourceKey?.keyringDenied) return fail('keychain-denied')
      return fail('unsupported-encryption')
    }

    if (stagingDb) {
      try {
        stagingDb.exec('COMMIT')
        closeStagingDb()
      } catch (err) {
        disableStaging(String(err))
      }
    }

    if (decryptedCookies.length === 0) {
      discardFile(stagingCookiesPath)
      return fail('empty-import')
    }

    await targetSession.clearStorageData({ storages: ['cookies'] })

    let memoryLoaded = 0
    let memoryFailed = 0
    for (const cookie of decryptedCookies) {
      const url = deriveUrl(cookie.domain, cookie.secure)
      if (!url) {
        memoryFailed++
        continue
      }
      try {
        const isHostPrefixed = cookie.name.startsWith('__Host-')
        await targetSession.cookies.set({
          url,
          name: cookie.name,
          value: cookie.value,
          ...(isHostPrefixed ? {} : { domain: cookie.domain }),
          path: isHostPrefixed ? '/' : cookie.path,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          sameSite: cookie.sameSite,
          expirationDate: cookie.expirationDate,
        })
        memoryLoaded++
      } catch {
        memoryFailed++
      }
    }

    log('memory load', { loaded: memoryLoaded, failed: memoryFailed, domains: domainSet.size })

    let warning: BrowserCookieImportSummary['warning']
    if (memoryFailed > 0 && stagingAvailable) {
      setPendingCookieImport(store, partition, stagingCookiesPath)
    } else if (memoryLoaded === 0) {
      clearPendingCookieImport(store, partition)
      discardFile(stagingCookiesPath)
      return fail('session-unavailable')
    } else if (memoryFailed > 0) {
      clearPendingCookieImport(store, partition)
      discardFile(stagingCookiesPath)
      warning = {
        code: 'restart-fallback-unavailable',
        loadedCookies: memoryLoaded,
        failedCookies: memoryFailed,
      }
    } else {
      clearPendingCookieImport(store, partition)
      discardFile(stagingCookiesPath)
    }

    const ua = options.getUserAgent?.(browser.family)
    if (ua) targetSession.setUserAgent?.(ua)

    const summary: BrowserCookieImportSummary = {
      totalCookies: sourceRows.length,
      importedCookies: memoryLoaded,
      skippedCookies: skipped,
      domains: [...domainSet].sort(),
      ...(warning ? { warning } : {}),
    }

    const profileName =
      browser.profiles.find((profile) => profile.directory === browser.selectedProfile)?.name
      ?? browser.selectedProfile
    const source = {
      family: browser.family,
      label: browser.label,
      profileName,
    }
    recordLastImport(store, {
      profileId,
      source,
      importedAt: options.now?.() ?? Date.now(),
      summary,
    })

    return { ok: true, profileId, summary, source }
  } catch (err) {
    try {
      sourceDb?.close()
    } catch {
      /* already closed */
    }
    closeStagingDb()
    discardFile(stagingCookiesPath)
    log('import failed', { error: String(err) })
    return fail('malformed-records')
  } finally {
    try {
      sourceSnapshot.cleanup()
    } catch {
      /* best-effort */
    }
  }
}
