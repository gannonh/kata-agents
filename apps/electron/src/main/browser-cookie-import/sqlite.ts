import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export type OpenCookieDatabaseOptions = {
  readOnly?: boolean
  readBigInts?: boolean
}

export type CookieSqliteStatement = {
  all: (...params: unknown[]) => Record<string, unknown>[]
  run: (...params: unknown[]) => void
}

export type CookieSqliteDatabase = {
  prepare: (sql: string) => CookieSqliteStatement
  exec: (sql: string) => void
  close: () => void
}

export type OpenCookieDatabase = (
  path: string,
  options?: OpenCookieDatabaseOptions,
) => CookieSqliteDatabase

/**
 * Open a Chromium cookies SQLite database.
 * Electron/Node uses `node:sqlite`; bun tests use `bun:sqlite`.
 */
export const openCookieDatabase: OpenCookieDatabase = (path, options = {}) => {
  const moduleId = typeof process.versions.bun === 'string' ? 'bun:sqlite' : 'node:sqlite'
  if (moduleId === 'bun:sqlite') {
    const { Database } = require(moduleId) as {
      Database: new (filename: string, options?: { readonly?: boolean; safeIntegers?: boolean }) => CookieSqliteDatabase
    }
    return new Database(path, {
      readonly: options.readOnly ?? false,
      safeIntegers: options.readBigInts ?? false,
    })
  }
  const { DatabaseSync } = require(moduleId) as {
    DatabaseSync: new (filename: string, options?: { readOnly?: boolean; readBigInts?: boolean }) => CookieSqliteDatabase
  }
  return new DatabaseSync(path, {
    readOnly: options.readOnly ?? false,
    readBigInts: options.readBigInts ?? false,
  })
}
