import { describe, expect, it } from 'bun:test'
import { chromiumSameSite, deriveUrl, isExpiredUnix, isIntegrityCookie } from '../validate'

describe('cookie validation helpers', () => {
  it('derives cookie URLs and Chromium SameSite values', () => {
    expect(deriveUrl('.github.com', true)).toBe('https://github.com/')
    expect(deriveUrl('example.com', false)).toBe('http://example.com/')
    expect(deriveUrl('bad domain', true)).toBeNull()
    expect(chromiumSameSite(1)).toBe('no_restriction')
    expect(chromiumSameSite(2)).toBe('lax')
    expect(chromiumSameSite(3)).toBe('strict')
    expect(chromiumSameSite(0)).toBe('unspecified')
  })

  it('skips Google integrity cookies and expired timestamps', () => {
    expect(isIntegrityCookie('SIDCC', '.google.com')).toBe(true)
    expect(isIntegrityCookie('session', '.google.com')).toBe(false)
    expect(isExpiredUnix(1_000, 2_000)).toBe(true)
    expect(isExpiredUnix(3_000, 2_000)).toBe(false)
    expect(isExpiredUnix(undefined, 2_000)).toBe(false)
  })
})
