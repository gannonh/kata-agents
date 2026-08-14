import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyPendingCookieImport, DEFAULT_BROWSER_PARTITION } from '../apply-pending'
import { createFileCookieImportStateStore, getLastImport, recordLastImport, setPendingCookieImport } from '../state'

describe('cookie import state', () => {
  it('records last import metadata without cookie values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kata-cookie-state-'))
    try {
      const store = createFileCookieImportStateStore(dir)
      recordLastImport(store, {
        profileId: 'default',
        source: { family: 'chrome', label: 'Google Chrome', profileName: 'Person 1' },
        importedAt: 1,
        summary: { totalCookies: 2, importedCookies: 2, skippedCookies: 0, domains: ['example.com'] },
      })
      const last = getLastImport(store, 'default')
      expect(last?.source.profileName).toBe('Person 1')
      expect(JSON.stringify(last)).not.toMatch(/sid=|cookie-value/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('replays a pending staged cookies database onto the Kata partition', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kata-cookie-pending-'))
    try {
      const staged = join(dir, 'staged-Cookies')
      writeFileSync(staged, 'staged-db')
      const store = createFileCookieImportStateStore(dir)
      setPendingCookieImport(store, DEFAULT_BROWSER_PARTITION, staged)
      applyPendingCookieImport({ userDataPath: dir, store })
      const live = join(dir, 'Partitions', 'browser-pane', 'Network', 'Cookies')
      expect(readFileSync(live, 'utf-8')).toBe('staged-db')
      expect(store.load().pendingCookieImports).toEqual({})
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('drops unknown partitions instead of writing outside the allowlist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kata-cookie-pending-bad-'))
    try {
      mkdirSync(dir, { recursive: true })
      const staged = join(dir, 'staged-Cookies')
      writeFileSync(staged, 'staged-db')
      const store = createFileCookieImportStateStore(dir)
      setPendingCookieImport(store, 'persist:evil', staged)
      applyPendingCookieImport({ userDataPath: dir, store })
      expect(store.load().pendingCookieImports).toEqual({})
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
