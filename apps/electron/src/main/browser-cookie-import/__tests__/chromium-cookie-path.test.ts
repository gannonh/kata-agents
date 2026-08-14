import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveChromiumCookiesPath } from '../chromium-cookie-path'

describe('resolveChromiumCookiesPath', () => {
  it('prefers Network/Cookies over the legacy profile-root Cookies file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kata-cookie-path-'))
    try {
      mkdirSync(join(dir, 'Network'), { recursive: true })
      writeFileSync(join(dir, 'Network', 'Cookies'), '')
      writeFileSync(join(dir, 'Cookies'), '')
      expect(resolveChromiumCookiesPath(dir)).toBe(join(dir, 'Network', 'Cookies'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falls back to the legacy Cookies file and returns null when neither exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kata-cookie-path-legacy-'))
    try {
      writeFileSync(join(dir, 'Cookies'), '')
      expect(resolveChromiumCookiesPath(dir)).toBe(join(dir, 'Cookies'))
      expect(resolveChromiumCookiesPath(join(dir, 'missing'))).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
