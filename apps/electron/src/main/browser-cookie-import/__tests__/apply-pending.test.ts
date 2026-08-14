import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyPendingCookieImport } from '../apply-pending'
import { createFileCookieImportStateStore } from '../state'

describe('applyPendingCookieImport', () => {
  it('replays staged cookies onto the known persist:browser-pane partition only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kata-cookie-pending-'))
    try {
      const store = createFileCookieImportStateStore(dir)
      const stagedKnown = join(dir, 'staged-known')
      const stagedUnknown = join(dir, 'staged-unknown')
      writeFileSync(stagedKnown, 'known-cookies')
      writeFileSync(stagedUnknown, 'unknown-cookies')
      store.save({
        lastImport: null,
        pendingCookieImports: {
          'persist:browser-pane': stagedKnown,
          'persist:other': stagedUnknown,
        },
      })

      applyPendingCookieImport({ userDataPath: dir, store })

      const live = join(dir, 'Partitions', 'browser-pane', 'Network', 'Cookies')
      expect(readFileSync(live, 'utf-8')).toBe('known-cookies')
      expect(store.load().pendingCookieImports).toEqual({})
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
