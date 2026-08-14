import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCookieDatabase } from '../sqlite'

describe('openCookieDatabase', () => {
  it('opens a sqlite database through the bun/node builtin', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kata-cookie-sqlite-'))
    const path = join(dir, 'Cookies')
    try {
      const db = openCookieDatabase(path)
      db.exec('CREATE TABLE cookies (name TEXT NOT NULL)')
      db.prepare('INSERT INTO cookies (name) VALUES (?)').run('sid')
      const rows = db.prepare('SELECT name FROM cookies').all()
      expect(rows).toEqual([{ name: 'sid' }])
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
