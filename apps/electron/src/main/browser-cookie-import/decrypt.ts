import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DetectedBrowser } from './detect'
import { CHROMIUM_BROWSERS, browserRootPath } from './detect'

const PBKDF2_ITERATIONS = 1003
const PBKDF2_KEY_LENGTH = 16
const PBKDF2_SALT = 'saltysalt'
const CHROMIUM_COOKIE_HMAC_LEN = 32

export type EncryptionKeyResult = {
  key: Buffer
  mode: 'aes-128-cbc' | 'aes-256-gcm'
  fallbackKey?: Buffer
  keyringDenied?: boolean
}

export type CookieImportKeychain = {
  getMacPassword?: (service: string, account: string) => string | null
  getLinuxPassword?: (service: string, account: string) => string | null
}

function hasHmacPrefix(buf: Buffer): boolean {
  if (buf.length <= CHROMIUM_COOKIE_HMAC_LEN) return false
  let nonPrintable = 0
  for (let i = 0; i < CHROMIUM_COOKIE_HMAC_LEN; i++) {
    if (buf[i] < 0x20 || buf[i] > 0x7e) nonPrintable++
  }
  return nonPrintable >= 8
}

function stripHmac(buf: Buffer): Buffer {
  return hasHmacPrefix(buf) ? buf.subarray(CHROMIUM_COOKIE_HMAC_LEN) : buf
}

function defaultMacPassword(service: string, account: string): string | null {
  try {
    return execFileSync(
      'security',
      ['find-generic-password', '-s', service, '-a', account, '-w'],
      { encoding: 'utf-8', timeout: 30_000 },
    ).trim()
  } catch {
    return null
  }
}

function defaultLinuxPassword(service: string, account: string): string | null {
  try {
    return execFileSync(
      'secret-tool',
      ['lookup', 'service', service, 'account', account],
      { encoding: 'utf-8', timeout: 5_000 },
    ).trim()
  } catch {
    try {
      const app = account.toLowerCase().replaceAll(' ', '')
      return execFileSync('secret-tool', ['lookup', 'application', app], {
        encoding: 'utf-8',
        timeout: 5_000,
      }).trim()
    } catch {
      return null
    }
  }
}

export function deriveMacLinuxKey(password: string, iterations = PBKDF2_ITERATIONS): Buffer {
  return pbkdf2Sync(password, PBKDF2_SALT, iterations, PBKDF2_KEY_LENGTH, 'sha1')
}

function getWindowsEncryptionKey(browser: DetectedBrowser): EncryptionKeyResult | null {
  const browserDef = CHROMIUM_BROWSERS.find((item) => item.family === browser.family)
  if (!browserDef) return null
  const root = browserRootPath(browserDef)
  if (!root) return null
  const localStatePath = join(root, 'Local State')
  if (!existsSync(localStatePath)) return null

  try {
    const localState = JSON.parse(readFileSync(localStatePath, 'utf-8')) as {
      os_crypt?: { encrypted_key?: unknown }
    }
    const encryptedKeyB64 = localState?.os_crypt?.encrypted_key
    if (typeof encryptedKeyB64 !== 'string') return null
    const encryptedKey = Buffer.from(encryptedKeyB64, 'base64')
    const dpapiPrefix = Buffer.from('DPAPI', 'utf-8')
    if (!encryptedKey.subarray(0, dpapiPrefix.length).equals(dpapiPrefix)) return null

    const dpapiData = encryptedKey.subarray(dpapiPrefix.length).toString('base64')
    const script = [
      'try { Add-Type -AssemblyName System.Security.Cryptography.ProtectedData -ErrorAction Stop }',
      'catch { try { Add-Type -AssemblyName System.Security -ErrorAction Stop } catch {} };',
      '$in=[Convert]::FromBase64String([Console]::In.ReadLine());',
      '$out=[System.Security.Cryptography.ProtectedData]::Unprotect($in,$null,',
      '[System.Security.Cryptography.DataProtectionScope]::CurrentUser);',
      '[Convert]::ToBase64String($out)',
    ].join('')

    const result = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf-8', timeout: 10_000, input: dpapiData },
    ).trim()
    return { key: Buffer.from(result, 'base64'), mode: 'aes-256-gcm' }
  } catch {
    return null
  }
}

export function getEncryptionKey(
  keychainService: string,
  keychainAccount: string,
  browser?: DetectedBrowser,
  keychain: CookieImportKeychain = {},
  platform: NodeJS.Platform = process.platform,
): EncryptionKeyResult | null {
  if (platform === 'darwin') {
    const getPassword = keychain.getMacPassword ?? defaultMacPassword
    const raw = getPassword(keychainService, keychainAccount)
    if (!raw) return null
    return { key: deriveMacLinuxKey(raw), mode: 'aes-128-cbc' }
  }
  if (platform === 'linux') {
    const v10Key = deriveMacLinuxKey('peanuts', 1)
    const getPassword = keychain.getLinuxPassword ?? defaultLinuxPassword
    const keyringPassword = getPassword(keychainService, keychainAccount)
    if (!keyringPassword) {
      return { key: v10Key, mode: 'aes-128-cbc', keyringDenied: true }
    }
    return {
      key: deriveMacLinuxKey(keyringPassword, 1),
      mode: 'aes-128-cbc',
      fallbackKey: v10Key,
    }
  }
  if (platform === 'win32' && browser) {
    return getWindowsEncryptionKey(browser)
  }
  return null
}

function decryptAes256Gcm(payload: Buffer, key: Buffer): Buffer | null {
  if (payload.length < 12 + 16) return null
  const nonce = payload.subarray(0, 12)
  const authTag = payload.subarray(-16)
  const ciphertext = payload.subarray(12, -16)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAuthTag(authTag)
    return stripHmac(Buffer.concat([decipher.update(ciphertext), decipher.final()]))
  } catch {
    return null
  }
}

export function decryptCookieValueRaw(
  encryptedBuffer: Buffer,
  keyResult: EncryptionKeyResult,
): Buffer | null {
  if (!encryptedBuffer || encryptedBuffer.length === 0) return null
  const version = encryptedBuffer.subarray(0, 3).toString('utf-8')
  if (!/^v\d\d$/.test(version)) return null

  if (keyResult.mode === 'aes-256-gcm') {
    return decryptAes256Gcm(encryptedBuffer.subarray(3), keyResult.key)
  }

  const ciphertext = encryptedBuffer.subarray(3)
  if (!ciphertext.length) return Buffer.alloc(0)

  const keysToTry =
    version === 'v10' && keyResult.fallbackKey
      ? [keyResult.fallbackKey, keyResult.key]
      : [keyResult.key, ...(keyResult.fallbackKey ? [keyResult.fallbackKey] : [])]

  for (const key of keysToTry) {
    try {
      const iv = Buffer.alloc(16, ' ')
      const decipher = createDecipheriv('aes-128-cbc', key, iv)
      decipher.setAutoPadding(true)
      return stripHmac(Buffer.concat([decipher.update(ciphertext), decipher.final()]))
    } catch {
      continue
    }
  }
  return null
}
