import type { BrowserCookieImportState, CookieImportErrorCode } from '@kata-sh/shared/protocol'

export const COOKIE_IMPORT_ERROR_I18N_KEYS = {
  'chrome-not-found': 'browser.cookieImport.error.chromeNotFound',
  'cookies-locked': 'browser.cookieImport.error.cookiesLocked',
  'cookies-missing': 'browser.cookieImport.error.cookiesMissing',
  'empty-import': 'browser.cookieImport.error.emptyImport',
  'invalid-profile': 'browser.cookieImport.error.invalidProfile',
  'keychain-denied': 'browser.cookieImport.error.keychainDenied',
  'malformed-records': 'browser.cookieImport.error.malformedRecords',
  'session-unavailable': 'browser.cookieImport.error.sessionUnavailable',
  'unsupported-encryption': 'browser.cookieImport.error.unsupportedEncryption',
  'unsupported-platform': 'browser.cookieImport.error.unsupportedPlatform',
} as const satisfies Record<CookieImportErrorCode, string>

export type CookieImportErrorI18nKey = (typeof COOKIE_IMPORT_ERROR_I18N_KEYS)[CookieImportErrorCode]

export function cookieImportErrorI18nKey(code: CookieImportErrorCode): CookieImportErrorI18nKey {
  return COOKIE_IMPORT_ERROR_I18N_KEYS[code]
}

export function cookieImportStatusI18n(lastImport: BrowserCookieImportState | null): {
  key: string
  values?: Record<string, string | number>
} {
  if (!lastImport) return { key: 'browser.cookieImport.lastImportNone' }
  if (lastImport.summary.warning?.code === 'restart-fallback-unavailable') {
    return {
      key: 'browser.cookieImport.warning.restartFallbackUnavailable',
      values: {
        source: lastImport.source.label,
        profile: lastImport.source.profileName,
        loaded: lastImport.summary.warning.loadedCookies,
        failed: lastImport.summary.warning.failedCookies,
      },
    }
  }
  return {
    key: 'browser.cookieImport.lastImport',
    values: {
      source: lastImport.source.label,
      profile: lastImport.source.profileName,
      count: lastImport.summary.importedCookies,
    },
  }
}
