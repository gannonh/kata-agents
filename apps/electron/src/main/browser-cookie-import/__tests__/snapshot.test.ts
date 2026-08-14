import { describe, expect, it } from 'bun:test'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChromiumCookieSnapshot } from '../chromium-cookie-snapshot'
import { createChromiumCookieTestDatabase } from '../test-database'
import { openCookieDatabase } from '../sqlite'

describe('Chromium cookie snapshot', () => {
  it('copies a live WAL cookies database without mutating the source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kata-cookie-snap-'))
    try {
      const sourcePath = join(dir, 'Chrome', 'Default', 'Network', 'Cookies')
      const sourceDb = createChromiumCookieTestDatabase(
        sourcePath,
        [{ name: 'sid', value: 'live-value' }],
        { journalMode: 'wal' },
      )
      expect(readFileSync(`${sourcePath}-wal`).length).toBeGreaterThan(0)
      const sourceBefore = ['', '-wal'].map((suffix) => readFileSync(sourcePath + suffix))

      const snapshot = createChromiumCookieSnapshot(sourcePath, { tempRoot: dir })
      const snapDb = openCookieDatabase(snapshot.databasePath, { readOnly: true })
      const rows = snapDb.prepare('SELECT name, value FROM cookies').all()
      snapDb.close()
      snapshot.cleanup()

      expect(rows).toEqual([{ name: 'sid', value: 'live-value' }])
      expect(['', '-wal'].map((suffix) => readFileSync(sourcePath + suffix))).toEqual(sourceBefore)
      sourceDb.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('throws when the source cookies database keeps changing during snapshot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kata-cookie-snap-busy-'))
    try {
      const sourcePath = join(dir, 'Chrome', 'Default', 'Network', 'Cookies')
      createChromiumCookieTestDatabase(sourcePath, [{ name: 'sid', value: 'live-value' }]).close()
      expect(() =>
        createChromiumCookieSnapshot(sourcePath, {
          tempRoot: dir,
          copyFile: (source, destination) => {
            copyFileSync(source, destination)
            writeFileSync(source, `${readFileSync(source).toString('binary')}-mutated`)
          },
        }),
      ).toThrow(/changed while creating a snapshot/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
