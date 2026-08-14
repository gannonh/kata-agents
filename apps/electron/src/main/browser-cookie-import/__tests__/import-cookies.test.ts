import { describe, expect, it, mock } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importCookiesFromDetectedBrowser, type CookieImportRuntime } from '../import-cookies'
import { createFileCookieImportStateStore } from '../state'
import { createChromiumCookieTestDatabase, encryptMacChromiumCookie } from '../test-database'
import { deriveMacLinuxKey } from '../decrypt'
import { createCookieImportLogger, logContainsSecret } from '../log'
import type { DetectedBrowser } from '../detect'

function chromeBrowser(cookiesPath: string): DetectedBrowser {
  return {
    family: 'chrome',
    label: 'Google Chrome',
    cookiesPath,
    keychainService: 'Chrome Safe Storage',
    keychainAccount: 'Chrome',
    profiles: [{ name: 'Person 1', directory: 'Default' }],
    selectedProfile: 'Default',
  }
}

function makeRuntime(userDataPath: string, logs: string[] = []): CookieImportRuntime & {
  cookiesSet: ReturnType<typeof mock>
  clearStorageData: ReturnType<typeof mock>
} {
  const cookiesSet = mock(async () => {})
  const clearStorageData = mock(async () => {})
  return {
    cookiesSet,
    clearStorageData,
    getUserDataPath: () => userDataPath,
    getSession: () => ({
      cookies: {
        set: cookiesSet,
        remove: mock(async () => {}),
        flushStore: mock(async () => {}),
      },
      clearStorageData,
      setUserAgent: mock(() => {}),
    }),
    log: createCookieImportLogger((line) => logs.push(line)),
    store: createFileCookieImportStateStore(userDataPath),
  }
}

describe('importCookiesFromDetectedBrowser', () => {
  it('imports decrypted Chrome cookies into the Kata session and records a bounded summary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kata-cookie-import-'))
    const logs: string[] = []
    try {
      const sourcePath = join(dir, 'Chrome', 'Default', 'Network', 'Cookies')
      const targetPath = join(dir, 'userData', 'Partitions', 'browser-pane', 'Network', 'Cookies')
      const password = 'test-password'
      createChromiumCookieTestDatabase(sourcePath, [
        { name: 'sid', value: '', encryptedValue: encryptMacChromiumCookie('encrypted-session', password) },
        { name: 'plain', value: 'visible-value' },
        { name: 'SIDCC', value: 'integrity', hostKey: '.google.com' },
      ]).close()
      createChromiumCookieTestDatabase(targetPath, [{ name: 'old', value: 'stale' }]).close()

      const runtime = makeRuntime(join(dir, 'userData'), logs)
      runtime.getEncryptionKey = () => ({ key: deriveMacLinuxKey(password), mode: 'aes-128-cbc' })

      const result = await importCookiesFromDetectedBrowser(chromeBrowser(sourcePath), {
        ...runtime,
        partition: 'persist:browser-pane',
        profileId: 'default',
      })

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.summary.importedCookies).toBe(2)
      expect(result.summary.domains).toContain('example.com')
      expect(result.source.profileName).toBe('Person 1')
      expect(runtime.clearStorageData).toHaveBeenCalled()
      expect(runtime.cookiesSet).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'sid', value: 'encrypted-session' }),
      )
      expect(runtime.cookiesSet.mock.calls.some((call) => call[0].name === 'SIDCC')).toBe(false)
      expect(logContainsSecret(logs.join('\n'), ['encrypted-session', 'visible-value'])).toBe(false)
      expect(JSON.stringify(result)).not.toContain('encrypted-session')
      expect(JSON.stringify(result)).not.toContain(sourcePath)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports keychain denial and leaves no staging leftovers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kata-cookie-keychain-'))
    try {
      const sourcePath = join(dir, 'Chrome', 'Default', 'Network', 'Cookies')
      const targetPath = join(dir, 'userData', 'Partitions', 'browser-pane', 'Network', 'Cookies')
      createChromiumCookieTestDatabase(sourcePath, [
        { name: 'sid', value: '', encryptedValue: Buffer.from('v10-encrypted') },
      ]).close()
      createChromiumCookieTestDatabase(targetPath, []).close()
      const runtime = makeRuntime(join(dir, 'userData'))
      runtime.getEncryptionKey = () => null

      const result = await importCookiesFromDetectedBrowser(chromeBrowser(sourcePath), runtime)
      expect(result).toEqual({ ok: false, code: 'keychain-denied' })
      expect(readdirSync(join(dir, 'userData', 'cookie-import-staging'))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports missing, empty, and malformed cookie databases without crashing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kata-cookie-errors-'))
    try {
      const missing = chromeBrowser(join(dir, 'missing', 'Cookies'))
      const runtime = makeRuntime(join(dir, 'userData'))
      mkdirSync(join(dir, 'userData', 'Partitions', 'browser-pane', 'Network'), { recursive: true })
      writeFileSync(join(dir, 'userData', 'Partitions', 'browser-pane', 'Network', 'Cookies'), '')
      expect(await importCookiesFromDetectedBrowser(missing, runtime)).toEqual({
        ok: false,
        code: 'cookies-missing',
      })

      const emptyPath = join(dir, 'empty', 'Network', 'Cookies')
      createChromiumCookieTestDatabase(emptyPath, []).close()
      writeFileSync(join(dir, 'userData', 'Partitions', 'browser-pane', 'Network', 'Cookies'), 'x')
      createChromiumCookieTestDatabase(
        join(dir, 'userData', 'Partitions', 'browser-pane', 'Network', 'Cookies'),
        [],
      ).close()
      expect(await importCookiesFromDetectedBrowser(chromeBrowser(emptyPath), runtime)).toEqual({
        ok: false,
        code: 'empty-import',
      })

      const malformedPath = join(dir, 'malformed', 'Network', 'Cookies')
      mkdirSync(join(dir, 'malformed', 'Network'), { recursive: true })
      writeFileSync(malformedPath, 'not a sqlite database')
      expect(await importCookiesFromDetectedBrowser(chromeBrowser(malformedPath), runtime)).toEqual({
        ok: false,
        code: 'malformed-records',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports cookies-locked when the Chrome database cannot be snapshotted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kata-cookie-locked-'))
    try {
      const sourcePath = join(dir, 'Chrome', 'Default', 'Network', 'Cookies')
      mkdirSync(sourcePath, { recursive: true })
      const targetPath = join(dir, 'userData', 'Partitions', 'browser-pane', 'Network', 'Cookies')
      createChromiumCookieTestDatabase(targetPath, []).close()
      const runtime = makeRuntime(join(dir, 'userData'))
      expect(await importCookiesFromDetectedBrowser(chromeBrowser(sourcePath), runtime)).toEqual({
        ok: false,
        code: 'cookies-locked',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports unsupported-encryption when every encrypted cookie fails to decrypt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kata-cookie-enc-'))
    try {
      const sourcePath = join(dir, 'Chrome', 'Default', 'Network', 'Cookies')
      const targetPath = join(dir, 'userData', 'Partitions', 'browser-pane', 'Network', 'Cookies')
      createChromiumCookieTestDatabase(sourcePath, [
        { name: 'sid', value: '', encryptedValue: encryptMacChromiumCookie('secret', 'real-password') },
      ]).close()
      createChromiumCookieTestDatabase(targetPath, []).close()
      const runtime = makeRuntime(join(dir, 'userData'))
      runtime.getEncryptionKey = () => ({ key: deriveMacLinuxKey('wrong-password'), mode: 'aes-128-cbc' })
      expect(await importCookiesFromDetectedBrowser(chromeBrowser(sourcePath), runtime)).toEqual({
        ok: false,
        code: 'unsupported-encryption',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports unsupported-platform before attempting encrypted import off darwin/linux/win32', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kata-cookie-plat-'))
    try {
      const sourcePath = join(dir, 'Chrome', 'Default', 'Network', 'Cookies')
      const targetPath = join(dir, 'userData', 'Partitions', 'browser-pane', 'Network', 'Cookies')
      createChromiumCookieTestDatabase(sourcePath, [
        { name: 'sid', value: '', encryptedValue: encryptMacChromiumCookie('secret', 'test-password') },
      ]).close()
      createChromiumCookieTestDatabase(targetPath, []).close()
      const runtime = makeRuntime(join(dir, 'userData'))
      runtime.getEncryptionKey = () => ({ key: deriveMacLinuxKey('test-password'), mode: 'aes-128-cbc' })
      expect(
        await importCookiesFromDetectedBrowser(chromeBrowser(sourcePath), {
          ...runtime,
          platform: 'freebsd',
        }),
      ).toEqual({ ok: false, code: 'unsupported-platform' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports session-unavailable when the Kata partition cookies file cannot be created', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kata-cookie-session-'))
    try {
      const sourcePath = join(dir, 'Chrome', 'Default', 'Network', 'Cookies')
      createChromiumCookieTestDatabase(sourcePath, [{ name: 'sid', value: 'source-value' }]).close()
      const runtime = makeRuntime(join(dir, 'userData'))
      expect(await importCookiesFromDetectedBrowser(chromeBrowser(sourcePath), runtime)).toEqual({
        ok: false,
        code: 'session-unavailable',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('counts only cookies that landed in the session and fails when none land without a restart fallback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kata-cookie-write-fail-'))
    try {
      const sourcePath = join(dir, 'Chrome', 'Default', 'Network', 'Cookies')
      const targetPath = join(dir, 'userData', 'Partitions', 'browser-pane', 'Network', 'Cookies')
      createChromiumCookieTestDatabase(sourcePath, [
        { name: 'sid', value: 'one' },
        { name: 'aid', value: 'two' },
      ]).close()
      mkdirSync(join(targetPath, '..'), { recursive: true })
      writeFileSync(targetPath, 'not a sqlite database')
      const runtime = makeRuntime(join(dir, 'userData'))
      runtime.cookiesSet.mockImplementation(async () => {
        throw new Error('session write failed')
      })
      expect(await importCookiesFromDetectedBrowser(chromeBrowser(sourcePath), runtime)).toEqual({
        ok: false,
        code: 'session-unavailable',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('records importedCookies from successful session writes and keeps a restart warning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kata-cookie-partial-'))
    try {
      const sourcePath = join(dir, 'Chrome', 'Default', 'Network', 'Cookies')
      const targetPath = join(dir, 'userData', 'Partitions', 'browser-pane', 'Network', 'Cookies')
      createChromiumCookieTestDatabase(sourcePath, [
        { name: 'sid', value: 'one' },
        { name: 'aid', value: 'two' },
      ]).close()
      mkdirSync(join(targetPath, '..'), { recursive: true })
      writeFileSync(targetPath, 'not a sqlite database')
      const runtime = makeRuntime(join(dir, 'userData'))
      runtime.cookiesSet.mockImplementation(async (details: { name: string }) => {
        if (details.name === 'aid') throw new Error('session write failed')
      })
      const result = await importCookiesFromDetectedBrowser(chromeBrowser(sourcePath), runtime)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.summary.importedCookies).toBe(1)
      expect(result.summary.warning).toEqual({
        code: 'restart-fallback-unavailable',
        loadedCookies: 1,
        failedCookies: 1,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('treats a missing Linux keyring with total decrypt failure as keychain-denied', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kata-cookie-linux-key-'))
    try {
      const sourcePath = join(dir, 'Chrome', 'Default', 'Network', 'Cookies')
      const targetPath = join(dir, 'userData', 'Partitions', 'browser-pane', 'Network', 'Cookies')
      createChromiumCookieTestDatabase(sourcePath, [
        { name: 'sid', value: '', encryptedValue: encryptMacChromiumCookie('secret', 'real-password') },
      ]).close()
      createChromiumCookieTestDatabase(targetPath, []).close()
      const runtime = makeRuntime(join(dir, 'userData'))
      runtime.getEncryptionKey = () => ({
        key: deriveMacLinuxKey('peanuts', 1),
        mode: 'aes-128-cbc',
        keyringDenied: true,
      })
      expect(await importCookiesFromDetectedBrowser(chromeBrowser(sourcePath), {
        ...runtime,
        platform: 'linux',
      })).toEqual({ ok: false, code: 'keychain-denied' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still loads cookies in memory when staging the target database fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kata-cookie-staging-'))
    try {
      const sourcePath = join(dir, 'Chrome', 'Default', 'Network', 'Cookies')
      const targetPath = join(dir, 'userData', 'Partitions', 'browser-pane', 'Network', 'Cookies')
      createChromiumCookieTestDatabase(sourcePath, [{ name: 'sid', value: 'source-value' }]).close()
      mkdirSync(join(targetPath, '..'), { recursive: true })
      writeFileSync(targetPath, 'not a sqlite database')
      const runtime = makeRuntime(join(dir, 'userData'))

      const result = await importCookiesFromDetectedBrowser(chromeBrowser(sourcePath), runtime)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.summary.importedCookies).toBe(1)
      expect(runtime.cookiesSet).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'sid', value: 'source-value' }),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
