import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { BrowserCookieImportState } from '@kata-sh/shared/protocol'
import { DEFAULT_KATA_BROWSER_PROFILE_ID } from '@kata-sh/shared/protocol'

export type CookieImportPersistedState = {
  lastImport: BrowserCookieImportState | null
  pendingCookieImports: Record<string, string>
}

const EMPTY_STATE: CookieImportPersistedState = {
  lastImport: null,
  pendingCookieImports: {},
}

export type CookieImportStateStore = {
  load: () => CookieImportPersistedState
  save: (state: CookieImportPersistedState) => void
}

export function cookieImportStatePath(userDataPath: string): string {
  return join(userDataPath, 'browser-cookie-import.json')
}

export function createFileCookieImportStateStore(userDataPath: string): CookieImportStateStore {
  const path = cookieImportStatePath(userDataPath)
  return {
    load() {
      try {
        if (!existsSync(path)) return { ...EMPTY_STATE, pendingCookieImports: {} }
        const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<CookieImportPersistedState>
        return {
          lastImport: parsed.lastImport ?? null,
          pendingCookieImports:
            parsed.pendingCookieImports && typeof parsed.pendingCookieImports === 'object'
              ? { ...parsed.pendingCookieImports }
              : {},
        }
      } catch {
        return { lastImport: null, pendingCookieImports: {} }
      }
    },
    save(state) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify(state, null, 2))
    },
  }
}

export function recordLastImport(store: CookieImportStateStore, lastImport: BrowserCookieImportState): void {
  const current = store.load()
  store.save({ ...current, lastImport })
}

export function getLastImport(
  store: CookieImportStateStore,
  profileId = DEFAULT_KATA_BROWSER_PROFILE_ID,
): BrowserCookieImportState | null {
  const lastImport = store.load().lastImport
  if (!lastImport || lastImport.profileId !== profileId) return null
  return lastImport
}

export function setPendingCookieImport(store: CookieImportStateStore, partition: string, stagingPath: string): void {
  const current = store.load()
  store.save({
    ...current,
    pendingCookieImports: { ...current.pendingCookieImports, [partition]: stagingPath },
  })
}

export function clearPendingCookieImport(store: CookieImportStateStore, partition: string): void {
  const current = store.load()
  if (!(partition in current.pendingCookieImports)) return
  const pendingCookieImports = { ...current.pendingCookieImports }
  delete pendingCookieImports[partition]
  store.save({ ...current, pendingCookieImports })
}
