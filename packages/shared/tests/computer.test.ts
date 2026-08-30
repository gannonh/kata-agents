import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import {
  ComputerConfigError,
  aggregateHealth,
  filterCapabilitiesForComputer,
  openDataRootLayout,
  parseComputerConfig,
} from '../src/computer/index.ts'

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'kata-computer-'))
  tempRoots.push(root)
  return root
}

function strongToken(): string {
  return 'token-with-enough-entropy-0123456789'
}

describe('parseComputerConfig', () => {
  it('uses KATA_DATA_ROOT in unpackaged mode', () => {
    const dataRoot = tempRoot()
    const config = parseComputerConfig({
      KATA_DATA_ROOT: dataRoot,
      KATA_SERVER_TOKEN: strongToken(),
    }, { packaged: false })
    expect(config.dataRoot).toBe(dataRoot)
    expect(config.kind).toBe('local-client')
    expect(config.packaged).toBe(false)
  })

  it('fails closed when packaged mode has no data root', () => {
    try {
      parseComputerConfig({
        KATA_IS_PACKAGED: 'true',
        KATA_SERVER_TOKEN: strongToken(),
      }, { packaged: true })
      throw new Error('expected parse to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(ComputerConfigError)
      expect((error as ComputerConfigError).code).toBe('missing-data-root')
    }
  })

  it('prefers KATA_SERVER_TOKEN_FILE over KATA_SERVER_TOKEN', () => {
    const root = tempRoot()
    const tokenFile = join(root, 'token')
    writeFileSync(tokenFile, `  ${strongToken()}-from-file  \n`)
    const config = parseComputerConfig({
      KATA_DATA_ROOT: root,
      KATA_SERVER_TOKEN: strongToken(),
      KATA_SERVER_TOKEN_FILE: tokenFile,
    }, { packaged: false })
    expect(config.rpc.token).toBe(`${strongToken()}-from-file`)
  })

  it('fails closed when only one TLS path is set', () => {
    try {
      parseComputerConfig({
        KATA_DATA_ROOT: tempRoot(),
        KATA_SERVER_TOKEN: strongToken(),
        KATA_RPC_TLS_CERT: '/certs/cert.pem',
      }, { packaged: false })
      throw new Error('expected parse to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(ComputerConfigError)
      expect((error as ComputerConfigError).code).toBe('tls-incomplete')
    }
  })

  it('fails closed for a public bind without TLS', () => {
    try {
      parseComputerConfig({
        KATA_DATA_ROOT: tempRoot(),
        KATA_SERVER_TOKEN: strongToken(),
        KATA_RPC_HOST: '0.0.0.0',
      }, { packaged: false, argv: [] })
      throw new Error('expected parse to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(ComputerConfigError)
      expect((error as ComputerConfigError).code).toBe('insecure-public-bind')
    }
  })

  it('falls back to KATA_CONFIG_DIR then the default home path', () => {
    const configDir = tempRoot()
    const fromConfigDir = parseComputerConfig({
      KATA_CONFIG_DIR: configDir,
      KATA_SERVER_TOKEN: strongToken(),
    }, { packaged: false })
    expect(fromConfigDir.dataRoot).toBe(configDir)

    const fromHome = parseComputerConfig({
      KATA_SERVER_TOKEN: strongToken(),
    }, { packaged: false })
    expect(fromHome.dataRoot).toBe(join(homedir(), '.kata-agents'))
  })
})

describe('openDataRootLayout', () => {
  it('creates a v1 manifest on an empty data root', () => {
    const root = tempRoot()
    const opened = openDataRootLayout(root)
    expect(opened.tag).toBe('opened')
    if (opened.tag !== 'opened') return
    expect(opened.created).toBe(true)
    expect(opened.computerId.length).toBeGreaterThan(0)
    const again = openDataRootLayout(root)
    expect(again.tag).toBe('opened')
    if (again.tag !== 'opened') return
    expect(again.created).toBe(false)
    expect(again.computerId).toBe(opened.computerId)
    expect(again.layout.workspacesDir).toBe(join(again.layout.root, 'workspaces'))
    expect(again.layout.credentialsPath).toBe(join(again.layout.root, 'credentials.enc'))
    expect(again.layout.worktreesDir).toBe(join(again.layout.root, 'worktrees'))
  })

  it('returns corrupt for a broken manifest instead of switching roots', () => {
    const root = tempRoot()
    mkdirSync(join(root, 'computer'), { recursive: true })
    writeFileSync(join(root, 'computer', 'manifest.json'), '{not-json')
    const result = openDataRootLayout(root)
    expect(result.tag).toBe('corrupt')
    if (result.tag !== 'corrupt') return
    expect(result.path).toContain('manifest.json')
  })

  it('returns incompatible for an unsupported layout version', () => {
    const root = tempRoot()
    mkdirSync(join(root, 'computer'), { recursive: true })
    writeFileSync(join(root, 'computer', 'manifest.json'), JSON.stringify({
      layoutVersion: 99,
      computerId: 'cmp_old',
    }))
    const result = openDataRootLayout(root)
    expect(result.tag).toBe('incompatible')
    if (result.tag !== 'incompatible') return
    expect(result.found).toBe(99)
  })
})

describe('aggregateHealth', () => {
  it('treats a browser-only failure as degraded', () => {
    expect(aggregateHealth({
      process: { tag: 'ready' },
      storage: { tag: 'ready' },
      browser: { tag: 'failed', reason: 'chromium down' },
      checkedAt: '2026-08-30T00:00:00.000Z',
    })).toBe('degraded')
  })

  it('treats storage failure as unhealthy', () => {
    expect(aggregateHealth({
      process: { tag: 'ready' },
      storage: { tag: 'failed', reason: 'corrupt' },
      browser: { tag: 'ready' },
      checkedAt: '2026-08-30T00:00:00.000Z',
    })).toBe('unhealthy')
  })
})

describe('filterCapabilitiesForComputer', () => {
  it('drops client:browser:invoke for a self-hosted computer', () => {
    expect(filterCapabilitiesForComputer('self-hosted-headless', [
      'client:browser:invoke',
      'other',
    ])).toEqual(['other'])
  })

  it('keeps client:browser:invoke for a local client computer', () => {
    expect(filterCapabilitiesForComputer('local-client', [
      'client:browser:invoke',
    ])).toEqual(['client:browser:invoke'])
  })
})
