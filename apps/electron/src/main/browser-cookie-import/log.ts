const COOKIE_IMPORT_ERROR_SUMMARY_MAX_CHARS = 180
const COOKIE_IMPORT_ERROR_SCAN_MAX_CHARS = 512

const SECRET_EXTRA_KEYS = new Set([
  'value',
  'cookiesPath',
  'key',
  'password',
  'encryptedValue',
  'encrypted_value',
  'keychainService',
  'keychainAccount',
])

export function summarizeCookieImportError(err: unknown): string {
  const raw = err instanceof Error && err.message ? err.message : String(err)
  let summary = ''
  let previousWasWhitespace = false
  const scanLimit = Math.min(raw.length, COOKIE_IMPORT_ERROR_SCAN_MAX_CHARS)
  for (let index = 0; index < scanLimit; index += 1) {
    const code = raw.charCodeAt(index)
    if (code === 32 || (code >= 9 && code <= 13)) {
      if (summary.length > 0 && !previousWasWhitespace) summary += ' '
      previousWasWhitespace = true
      continue
    }
    summary += raw.charAt(index)
    if (summary.length >= COOKIE_IMPORT_ERROR_SUMMARY_MAX_CHARS) {
      return summary.slice(0, COOKIE_IMPORT_ERROR_SUMMARY_MAX_CHARS)
    }
    previousWasWhitespace = false
  }
  return summary
}

export type CookieImportLog = (message: string, extra?: Record<string, unknown>) => void

export function createCookieImportLogger(write: (line: string) => void): CookieImportLog {
  return (message, extra) => {
    if (!extra) {
      write(`[cookie-import] ${message}`)
      return
    }
    const safe: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(extra)) {
      if (SECRET_EXTRA_KEYS.has(key)) continue
      safe[key] = value
    }
    write(`[cookie-import] ${message} ${JSON.stringify(safe)}`)
  }
}

export function logContainsSecret(haystack: string, secrets: readonly string[]): boolean {
  return secrets.some((secret) => secret.length > 0 && haystack.includes(secret))
}
