import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importCookiesFromBrowserArgs, listRendererCookieSources } from '../rpc'
import { createFileCookieImportStateStore } from '../state'
import type { CookieImportRuntime } from '../import-cookies'

describe('cookie import RPC boundary', () => {
  it('returns renderer-safe sources and rejects traversal/invalid families', async () => {
    const home = mkdtempSync(join(tmpdir(), 'kata-cookie-rpc-'))
    try {
      const chromeRoot = join(home, 'Library', 'Application Support', 'Google', 'Chrome')
      mkdirSync(join(chromeRoot, 'Default', 'Network'), { recursive: true })
      writeFileSync(join(chromeRoot, 'Default', 'Network', 'Cookies'), '')
      writeFileSync(
        join(chromeRoot, 'Local State'),
        JSON.stringify({ profile: { info_cache: { Default: { name: 'Person 1' } } } }),
      )
      const sources = listRendererCookieSources({ platform: 'darwin', home })
      expect(JSON.stringify(sources)).not.toContain(chromeRoot)
      expect(sources[0]?.profiles[0]?.name).toBe('Person 1')

      const runtime: CookieImportRuntime = {
        getUserDataPath: () => join(home, 'userData'),
        getSession: () => ({
          cookies: {
            set: async () => {},
            get: async () => [],
            remove: async () => {},
            flushStore: async () => {},
          },
          clearStorageData: async () => {},
        }),
        store: createFileCookieImportStateStore(join(home, 'userData')),
      }

      expect(
        await importCookiesFromBrowserArgs(
          { browserFamily: 'firefox' },
          runtime,
          { platform: 'darwin', home },
        ),
      ).toEqual({ ok: false, code: 'chrome-not-found' })
      expect(
        await importCookiesFromBrowserArgs(
          { browserFamily: 'chrome', browserProfile: '../etc' },
          runtime,
          { platform: 'darwin', home },
        ),
      ).toEqual({ ok: false, code: 'invalid-profile' })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
