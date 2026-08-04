/**
 * Web UI session authentication.
 *
 * Cookie-based JWT session auth for the browser-served web UI.
 * - Login: verify password → issue signed JWT → set HttpOnly cookie
 * - Validation: check cookie on every HTTP request + WebSocket upgrade
 * - Rate limiting: per-IP brute-force protection on /api/auth
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'

// ---------------------------------------------------------------------------
// JWT helpers (via jose library)
// ---------------------------------------------------------------------------

const JWT_EXPIRY_SECONDS = 86_400 // 24 hours

export interface JwtPayload {
  sub: string
  iat: number
  exp: number
}

export async function signJwt(payload: JwtPayload, secret: string): Promise<string> {
  const key = new TextEncoder().encode(secret)
  return new SignJWT({ sub: payload.sub } as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(payload.iat)
    .setExpirationTime(payload.exp)
    .sign(key)
}

export async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
  try {
    const key = new TextEncoder().encode(secret)
    const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] })
    return {
      sub: payload.sub as string,
      iat: payload.iat as number,
      exp: payload.exp as number,
    }
  } catch {
    return null
  }
}

export async function createSessionToken(secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return signJwt({ sub: 'webui', iat: now, exp: now + JWT_EXPIRY_SECONDS }, secret)
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

const SESSION_COOKIE_NAME = 'craft_session'

export function buildSessionCookie(jwt: string, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${jwt}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${JWT_EXPIRY_SECONDS}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function buildLogoutCookie(secure = false): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    'Max-Age=0',
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function extractSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null
  for (const pair of cookieHeader.split(';')) {
    const [name, ...rest] = pair.trim().split('=')
    if (name === SESSION_COOKIE_NAME) return rest.join('=')
  }
  return null
}

// ---------------------------------------------------------------------------
// Password verification
// ---------------------------------------------------------------------------

function scryptAsync(
  plaintext: string,
  salt: Buffer,
  keyLength: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      plaintext,
      salt,
      keyLength,
      {
        N: 16_384,
        r: 8,
        p: 1,
        maxmem: 32 * 1024 * 1024,
      },
      (error, derivedKey) => {
        if (error) reject(error)
        else resolve(derivedKey)
      },
    )
  })
}

const NODE_SCRYPT_PREFIX = 'scrypt'
const NODE_SCRYPT_KEY_BYTES = 64

interface BunPasswordApi {
  hash(plaintext: string, options: { algorithm: 'argon2id' }): Promise<string>
  verify(input: string, hash: string): Promise<boolean>
}

function getBunPasswordApi(): BunPasswordApi | undefined {
  return (
    globalThis as typeof globalThis & {
      Bun?: { password?: BunPasswordApi }
    }
  ).Bun?.password
}

async function hashWithNode(plaintext: string): Promise<string> {
  const salt = randomBytes(16)
  const derivedKey = await scryptAsync(plaintext, salt, NODE_SCRYPT_KEY_BYTES)
  return `${NODE_SCRYPT_PREFIX}$${salt.toString('base64url')}$${derivedKey.toString('base64url')}`
}

async function verifyWithNode(input: string, encodedHash: string): Promise<boolean> {
  const [, encodedSalt, encodedKey] = encodedHash.split('$')
  if (!encodedSalt || !encodedKey) return false

  const salt = Buffer.from(encodedSalt, 'base64url')
  const expectedKey = Buffer.from(encodedKey, 'base64url')
  const actualKey = await scryptAsync(input, salt, expectedKey.length)
  return actualKey.length === expectedKey.length && timingSafeEqual(actualKey, expectedKey)
}

/**
 * Hash the login password at startup. Must be called before any auth requests.
 * The returned hash is kept by the caller — the raw password is not retained.
 * Bun uses its native Argon2id implementation. Node uses an in-memory scrypt
 * hash for the Node-based WebUI E2E harness.
 */
export async function initPasswordHash(plaintext: string): Promise<string> {
  const bunPassword = getBunPasswordApi()
  return bunPassword
    ? await bunPassword.hash(plaintext, { algorithm: 'argon2id' })
    : await hashWithNode(plaintext)
}

/**
 * Verify a user-supplied password against a pre-hashed password.
 * Both runtime paths use constant-time verification.
 */
export async function verifyPassword(input: string, hashedPassword: string): Promise<boolean> {
  if (hashedPassword.startsWith(`${NODE_SCRYPT_PREFIX}$`)) {
    return verifyWithNode(input, hashedPassword)
  }
  const bunPassword = getBunPasswordApi()
  return bunPassword ? bunPassword.verify(input, hashedPassword) : false
}

// ---------------------------------------------------------------------------
// Rate limiter (per-IP + global, sliding window)
// ---------------------------------------------------------------------------

interface RateLimitEntry {
  attempts: number
  windowStart: number
}

export class RateLimiter {
  private entries = new Map<string, RateLimitEntry>()
  private readonly maxAttempts: number
  private readonly windowMs: number
  /** Global counter — blocks all IPs after too many total failures (defeats IP spoofing). */
  private readonly maxGlobalAttempts: number
  private globalAttempts = 0
  private globalWindowStart = Date.now()

  constructor(maxAttempts = 5, windowMs = 60_000, maxGlobalAttempts = 20) {
    this.maxAttempts = maxAttempts
    this.windowMs = windowMs
    this.maxGlobalAttempts = maxGlobalAttempts
  }

  /** Returns true if the request should be allowed, false if rate-limited. */
  check(ip: string): boolean {
    const now = Date.now()

    // Reset global window if expired
    if (now - this.globalWindowStart > this.windowMs) {
      this.globalAttempts = 0
      this.globalWindowStart = now
    }

    // Global rate limit — blocks everyone if too many total attempts
    this.globalAttempts++
    if (this.globalAttempts > this.maxGlobalAttempts) return false

    // Per-IP rate limit
    const entry = this.entries.get(ip)

    if (!entry || now - entry.windowStart > this.windowMs) {
      this.entries.set(ip, { attempts: 1, windowStart: now })
      return true
    }

    entry.attempts++
    if (entry.attempts > this.maxAttempts) return false
    return true
  }

  /** Periodic cleanup of stale entries (call on a timer). */
  cleanup(): void {
    const now = Date.now()
    for (const [ip, entry] of this.entries) {
      if (now - entry.windowStart > this.windowMs * 2) {
        this.entries.delete(ip)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Session validator (used by both HTTP and WebSocket)
// ---------------------------------------------------------------------------

export async function validateSession(
  cookieHeader: string | null,
  secret: string,
): Promise<JwtPayload | null> {
  const token = extractSessionCookie(cookieHeader)
  if (!token) return null
  return verifyJwt(token, secret)
}
