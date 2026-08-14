export type CookieSameSite = 'unspecified' | 'no_restriction' | 'lax' | 'strict'

export type ValidatedCookie = {
  url: string
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite: CookieSameSite
  expirationDate: number | undefined
}

const CHROMIUM_EPOCH_OFFSET = 11644473600n

export function chromiumSameSite(raw: number): CookieSameSite {
  switch (raw) {
    case 1:
      return 'no_restriction'
    case 2:
      return 'lax'
    case 3:
      return 'strict'
    default:
      return 'unspecified'
  }
}

export function deriveUrl(domain: string, secure: boolean): string | null {
  const cleanDomain = domain.startsWith('.') ? domain.slice(1) : domain
  if (!cleanDomain || cleanDomain.includes(' ')) return null
  const protocol = secure ? 'https' : 'http'
  try {
    return new URL(`${protocol}://${cleanDomain}/`).toString()
  } catch {
    return null
  }
}

export function chromiumTimestampToUnix(chromiumTs: bigint | number | string): number {
  if (!chromiumTs || chromiumTs === 0n || chromiumTs === 0 || chromiumTs === '0') return 0
  try {
    const ts =
      typeof chromiumTs === 'bigint'
        ? chromiumTs
        : BigInt(typeof chromiumTs === 'number' ? Math.round(chromiumTs) : chromiumTs)
    if (ts === 0n) return 0
    return Math.max(Number(ts / 1000000n - CHROMIUM_EPOCH_OFFSET), 0)
  } catch {
    return 0
  }
}

const INTEGRITY_COOKIE_NAMES = new Set([
  'SIDCC',
  '__Secure-1PSIDCC',
  '__Secure-3PSIDCC',
  '__Secure-STRP',
  'AEC',
])

export function isIntegrityCookie(name: string, domain: string): boolean {
  if (!INTEGRITY_COOKIE_NAMES.has(name)) return false
  const d = domain.startsWith('.') ? domain.slice(1) : domain
  return d === 'google.com' || d.endsWith('.google.com')
}

export function isExpiredUnix(expirationDate: number | undefined, nowSeconds: number): boolean {
  return typeof expirationDate === 'number' && expirationDate > 0 && expirationDate < nowSeconds
}
