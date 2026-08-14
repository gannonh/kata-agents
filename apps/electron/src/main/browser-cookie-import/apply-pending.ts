import { copyFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveChromiumCookiesPath } from './chromium-cookie-path'
import { createFileCookieImportStateStore, type CookieImportStateStore } from './state'
import type { CookieImportLog } from './log'

export const DEFAULT_BROWSER_PARTITION = 'persist:browser-pane'

export function partitionCookiesDir(userDataPath: string, partition: string): string {
  return join(userDataPath, 'Partitions', partition.replace('persist:', ''))
}

export function applyPendingCookieImport(options: {
  userDataPath: string
  store?: CookieImportStateStore
  knownPartitions?: readonly string[]
  log?: CookieImportLog
}): void {
  const store = options.store ?? createFileCookieImportStateStore(options.userDataPath)
  const knownPartitions = new Set(options.knownPartitions ?? [DEFAULT_BROWSER_PARTITION])
  const current = store.load()
  const remaining = { ...current.pendingCookieImports }

  for (const [partition, stagedPath] of Object.entries(current.pendingCookieImports)) {
    if (!knownPartitions.has(partition) || !existsSync(stagedPath)) {
      delete remaining[partition]
      continue
    }
    const profileDir = partitionCookiesDir(options.userDataPath, partition)
    const liveCookiesPath = resolveChromiumCookiesPath(profileDir) ?? join(profileDir, 'Network', 'Cookies')
    try {
      mkdirSync(dirname(liveCookiesPath), { recursive: true })
      copyFileSync(stagedPath, liveCookiesPath)
      let sidecarCopyFailed = false
      for (const suffix of ['-wal', '-shm'] as const) {
        try {
          unlinkSync(liveCookiesPath + suffix)
        } catch {
          /* may not exist */
        }
        const stagingSidecar = stagedPath + suffix
        if (!existsSync(stagingSidecar)) continue
        try {
          copyFileSync(stagingSidecar, liveCookiesPath + suffix)
        } catch {
          sidecarCopyFailed = true
        }
      }
      if (sidecarCopyFailed) continue
      for (const ext of ['', '-wal', '-shm'] as const) {
        try {
          unlinkSync(`${stagedPath}${ext}`)
        } catch {
          /* best-effort */
        }
      }
      delete remaining[partition]
    } catch (error) {
      options.log?.('pending cookie replay failed', { partition, code: (error as NodeJS.ErrnoException).code })
    }
  }

  store.save({ ...current, pendingCookieImports: remaining })
}
