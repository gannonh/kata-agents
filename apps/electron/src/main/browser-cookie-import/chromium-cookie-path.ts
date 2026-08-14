import { existsSync } from 'node:fs'
import { join } from 'node:path'

export type PathExists = (path: string) => boolean

/**
 * Chromium 96+ stores cookies under Network/; older profiles keep Cookies
 * at the profile root. Every reader and replay writer must agree.
 */
export function resolveChromiumCookiesPath(
  profileDir: string,
  exists: PathExists = existsSync,
): string | null {
  const networkPath = join(profileDir, 'Network', 'Cookies')
  if (exists(networkPath)) return networkPath
  const legacyPath = join(profileDir, 'Cookies')
  return exists(legacyPath) ? legacyPath : null
}
