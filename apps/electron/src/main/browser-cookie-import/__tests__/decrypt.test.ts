import { describe, expect, it } from 'bun:test'
import { deriveMacLinuxKey, decryptCookieValueRaw, getEncryptionKey } from '../decrypt'
import { encryptMacChromiumCookie } from '../test-database'

describe('Chromium cookie decryption', () => {
  it('decrypts macOS AES-128-CBC v10 cookies from a fixture password', () => {
    const password = 'test-password'
    const encrypted = encryptMacChromiumCookie('secret-session', password)
    const decrypted = decryptCookieValueRaw(encrypted, {
      key: deriveMacLinuxKey(password),
      mode: 'aes-128-cbc',
    })
    expect(decrypted?.toString('latin1')).toBe('secret-session')
  })

  it('returns null for unsupported prefixes and wrong keys', () => {
    const encrypted = encryptMacChromiumCookie('secret-session', 'test-password')
    expect(decryptCookieValueRaw(Buffer.from('xxxx'), {
      key: deriveMacLinuxKey('test-password'),
      mode: 'aes-128-cbc',
    })).toBeNull()
    expect(decryptCookieValueRaw(encrypted, {
      key: deriveMacLinuxKey('wrong-password'),
      mode: 'aes-128-cbc',
    })).toBeNull()
  })

  it('marks a missing Linux keyring password as keyringDenied while keeping the peanuts fallback', () => {
    const result = getEncryptionKey(
      'Chrome Safe Storage',
      'Chrome',
      undefined,
      { getLinuxPassword: () => null },
      'linux',
    )
    expect(result?.keyringDenied).toBe(true)
    expect(result?.mode).toBe('aes-128-cbc')
    expect(result?.key.equals(deriveMacLinuxKey('peanuts', 1))).toBe(true)
  })
})
