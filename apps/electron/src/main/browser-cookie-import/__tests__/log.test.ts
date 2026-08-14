import { describe, expect, it } from 'bun:test'
import { createCookieImportLogger, logContainsSecret, summarizeCookieImportError } from '../log'

describe('cookie import logging', () => {
  it('bounds error summaries without scanning the full payload', () => {
    const secret = `secret-cookie-value-${'x'.repeat(400)}`
    const summary = summarizeCookieImportError(new Error(`Import failed\n\t${secret}`))
    expect(summary.length).toBeLessThanOrEqual(180)
    expect(summary.startsWith('Import failed secret-cookie-value')).toBe(true)
  })

  it('omits raw cookie values and keychain material from log extras', () => {
    const lines: string[] = []
    const log = createCookieImportLogger((line) => lines.push(line))
    log('imported', {
      value: 'raw-cookie-secret',
      cookiesPath: '/Users/me/Library/Cookies',
      keychainService: 'Chrome Safe Storage',
      password: 'keychain-password',
      loaded: 3,
    })
    expect(lines.join('\n')).toContain('"loaded":3')
    expect(logContainsSecret(lines.join('\n'), [
      'raw-cookie-secret',
      'keychain-password',
      'Chrome Safe Storage',
      '/Users/me/Library/Cookies',
    ])).toBe(false)
  })
})
