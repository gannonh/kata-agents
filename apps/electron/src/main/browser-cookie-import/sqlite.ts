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

type BunSqliteModule = {
  Database: new (
    filename: string,
    options?: { readonly?: boolean; safeIntegers?: boolean },
  ) => CookieSqliteDatabase
}

type NodeSqliteModule = {
  DatabaseSync: new (
    filename: string,
    options?: { readOnly?: boolean; readBigInts?: boolean },
  ) => CookieSqliteDatabase
}

function loadSqliteBinding(moduleId: 'bun:sqlite' | 'node:sqlite'): BunSqliteModule | NodeSqliteModule {
  // Use the ambient CJS `require` (bun tests and esbuild main.cjs). Do not use
  // createRequire(import.meta.url): esbuild CJS compiles that to
  // createRequire(undefined) and crashes Electron before any window opens.
  if (typeof require !== 'function') {
    throw new Error(`Cannot load ${moduleId}: no CJS require in this runtime`)
  }
  return require(moduleId) as BunSqliteModule | NodeSqliteModule
}

/**
 * Open a Chromium cookies SQLite database.
 * Electron/Node uses `node:sqlite`; bun tests use `bun:sqlite`.
 */
export const openCookieDatabase: OpenCookieDatabase = (path, options = {}) => {
  const moduleId = typeof process.versions.bun === 'string' ? 'bun:sqlite' : 'node:sqlite'
  if (moduleId === 'bun:sqlite') {
    const { Database } = loadSqliteBinding(moduleId) as BunSqliteModule
    return new Database(path, {
      readonly: options.readOnly ?? false,
      safeIntegers: options.readBigInts ?? false,
    })
  }
  const { DatabaseSync } = loadSqliteBinding(moduleId) as NodeSqliteModule
  return new DatabaseSync(path, {
    readOnly: options.readOnly ?? false,
    readBigInts: options.readBigInts ?? false,
  })
}
