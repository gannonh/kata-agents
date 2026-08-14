import { describe, expect, it } from 'bun:test'
import { COOKIE_IMPORT_ERROR_CODES } from '@kata-sh/shared/protocol'
import {
  COOKIE_IMPORT_ERROR_I18N_KEYS,
  cookieImportErrorI18nKey,
  cookieImportStatusI18n,
} from '../cookie-import-i18n'

describe('cookie import i18n mapping', () => {
  it('maps every error code to a browser.cookieImport key without secret-looking labels', () => {
    for (const code of COOKIE_IMPORT_ERROR_CODES) {
      const key = cookieImportErrorI18nKey(code)
      expect(key.startsWith('browser.cookieImport.error.')).toBe(true)
      expect(COOKIE_IMPORT_ERROR_I18N_KEYS[code]).toBe(key)
      expect(key).not.toMatch(/password|Cookies\//i)
      expect(key).not.toContain('Library/')
    }
  })

  it('surfaces last-import counts and restart warnings without cookie values', () => {
    expect(cookieImportStatusI18n(null)).toEqual({
      key: 'browser.cookieImport.lastImportNone',
    })
    expect(cookieImportStatusI18n({
      profileId: 'default',
      source: { family: 'chrome', label: 'Google Chrome', profileName: 'Person 1' },
      importedAt: 1,
      summary: { totalCookies: 2, importedCookies: 2, skippedCookies: 0, domains: ['example.com'] },
    })).toEqual({
      key: 'browser.cookieImport.lastImport',
      values: { source: 'Google Chrome', profile: 'Person 1', count: 2 },
    })
    const withWarning = cookieImportStatusI18n({
      profileId: 'default',
      source: { family: 'chrome', label: 'Google Chrome', profileName: 'Person 1' },
      importedAt: 1,
      summary: {
        totalCookies: 2,
        importedCookies: 1,
        skippedCookies: 0,
        domains: ['example.com'],
        warning: { code: 'restart-fallback-unavailable', loadedCookies: 1, failedCookies: 1 },
      },
    })
    expect(withWarning.key).toBe('browser.cookieImport.warning.restartFallbackUnavailable')
    expect(withWarning.values).toEqual({
      source: 'Google Chrome',
      profile: 'Person 1',
      count: 1,
      failed: 1,
    })
    expect(JSON.stringify(withWarning)).not.toMatch(/sid=|cookie-value|secret/i)
  })
})
