/**
 * Headless server smoke test.
 *
 * Spawns the standalone server as a subprocess and validates:
 * - WebSocket handshake succeeds with valid token
 * - WebSocket handshake fails with invalid token
 * - /health endpoint returns 200
 * - Clean shutdown on SIGTERM
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import type { Subprocess } from 'bun'
import WebSocket from 'ws'
import { RPC_CHANNELS } from '@kata-sh/shared/protocol'

const SERVER_ENTRY = join(import.meta.dir, '..', 'index.ts')
const STARTUP_TIMEOUT = 15_000
const TEST_TIMEOUT = 30_000

interface SpawnedServer {
  url: string
  token: string
  healthUrl: string | null
  proc: Subprocess
  configDir: string
  stdout: () => string
  stop: () => Promise<void>
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close()
        reject(new Error('no port'))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

async function spawnTestServer(
  extraEnv?: Record<string, string>,
  options?: { provideToken?: boolean; configDir?: string; keepConfigDir?: boolean },
): Promise<SpawnedServer> {
  const token = crypto.randomUUID() + crypto.randomUUID() // 72 chars, well above 16 minimum
  const configDir = options?.configDir ?? mkdtempSync(join(tmpdir(), 'kata-server-smoke-'))
  const {
    CLAUDECODE: _,
    KATA_SERVER_TOKEN: _serverToken,
    KATA_CONFIG_DIR: _configDir,
    KATA_DATA_ROOT: _dataRoot,
    KATA_IS_PACKAGED: _packaged,
    ...parentEnv
  } = process.env
  const provideToken = options?.provideToken ?? true
  const keepConfigDir = options?.keepConfigDir === true

  const proc = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
    env: {
      ...parentEnv,
      ...extraEnv,
      ...(provideToken ? { KATA_SERVER_TOKEN: token } : {}),
      KATA_CONFIG_DIR: configDir,
      KATA_RPC_PORT: extraEnv?.KATA_RPC_PORT ?? '0',
      KATA_RPC_HOST: extraEnv?.KATA_RPC_HOST ?? '127.0.0.1',
      KATA_HEALTH_PORT: extraEnv?.KATA_HEALTH_PORT ?? '0',
      KATA_SKIP_BROWSER: extraEnv?.KATA_SKIP_BROWSER ?? '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  return new Promise<SpawnedServer>((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill()
      if (!keepConfigDir) rmSync(configDir, { recursive: true, force: true })
      reject(new Error(`Server did not start within ${STARTUP_TIMEOUT}ms`))
    }, STARTUP_TIMEOUT)

    let url = ''
    let printedToken = provideToken ? token : ''
    let healthUrl: string | null = null
    let buffer = ''
    let stdoutText = ''
    const needsHealth = Number.parseInt(extraEnv?.KATA_HEALTH_PORT ?? '0', 10) > 0

    const processLines = () => {
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.startsWith('KATA_SERVER_URL=')) {
          url = line.slice('KATA_SERVER_URL='.length).trim()
        }
        if (line.startsWith('KATA_SERVER_TOKEN=')) {
          printedToken = line.slice('KATA_SERVER_TOKEN='.length).trim()
        }
        if (line.startsWith('KATA_HEALTH_URL=')) {
          healthUrl = line.slice('KATA_HEALTH_URL='.length).trim()
        }
        if (url && printedToken && (!needsHealth || healthUrl)) {
          clearTimeout(timer)
          resolve({
            url,
            token: printedToken,
            healthUrl,
            proc,
            configDir,
            stdout: () => stdoutText,
            stop: async () => {
              proc.kill('SIGTERM')
              await proc.exited
              if (!keepConfigDir) rmSync(configDir, { recursive: true, force: true })
            },
          })
          return
        }
      }
    }

    ;(async () => {
      const reader = proc.stdout!.getReader()
      const decoder = new TextDecoder()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const chunk = decoder.decode(value, { stream: true })
          stdoutText += chunk
          buffer += chunk
          processLines()
        }
      } catch {
        // Stream closed
      }
      clearTimeout(timer)
      if (!url) {
        if (!keepConfigDir) rmSync(configDir, { recursive: true, force: true })
        reject(new Error('Server exited before printing KATA_SERVER_URL'))
      }
    })()
  })
}

function connectWs(url: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.on('open', () => {
      // Send handshake
      ws.send(JSON.stringify({
        id: crypto.randomUUID(),
        type: 'handshake',
        protocolVersion: '1.0',
        token,
      }))
    })
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'handshake_ack') {
        resolve(ws)
      } else if (msg.type === 'error') {
        reject(new Error(`Handshake error: ${msg.error?.message}`))
        ws.close()
      }
    })
    ws.on('error', reject)
    ws.on('close', (code, reason) => {
      reject(new Error(`WS closed: ${code} ${reason}`))
    })
  })
}

function rpc(ws: WebSocket, channel: string, args: unknown[] = []): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID()
    const onMessage = (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString()) as { id?: string; result?: unknown; error?: { message?: string } }
      if (msg.id !== id) return
      ws.off('message', onMessage)
      if (msg.error) reject(new Error(msg.error.message ?? 'rpc error'))
      else resolve(msg.result)
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, type: 'request', channel, args }))
  })
}

describe('headless server smoke test', () => {
  let server: SpawnedServer | null = null

  afterEach(async () => {
    if (server) {
      await server.stop().catch(() => {})
      server = null
    }
  })

  it('accepts valid token handshake', async () => {
    server = await spawnTestServer()
    await Bun.sleep(200)
    expect(server.stdout()).not.toContain('KATA_SERVER_TOKEN=')
    expect(server.stdout()).not.toContain('KATA_WEBUI_AUTH_URL=')
    const ws = await connectWs(server.url, server.token)
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  }, TEST_TIMEOUT)

  it('rejects invalid token', async () => {
    server = await spawnTestServer()
    await expect(
      connectWs(server.url, 'wrong-token-that-is-long-enough'),
    ).rejects.toThrow()
  }, TEST_TIMEOUT)

  it('generates and prints a token when KATA_SERVER_TOKEN is not set', async () => {
    server = await spawnTestServer(undefined, { provideToken: false })
    expect(server.token).toMatch(/^[0-9a-f]{48}$/)
    expect(server.stdout()).toContain(`KATA_SERVER_TOKEN=${server.token}`)

    const ws = await connectWs(server.url, server.token)
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  }, TEST_TIMEOUT)

  it('rejects short token at startup', async () => {
    const token = 'short'
    const configDir = mkdtempSync(join(tmpdir(), 'kata-server-smoke-'))
    const { CLAUDECODE: _, KATA_CONFIG_DIR: _configDir, ...parentEnv } = process.env
    const proc = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
      env: {
        ...parentEnv,
        KATA_CONFIG_DIR: configDir,
        KATA_SERVER_TOKEN: token,
        KATA_RPC_PORT: '0',
        KATA_RPC_HOST: '127.0.0.1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const exitCode = await proc.exited
    rmSync(configDir, { recursive: true, force: true })
    expect(exitCode).not.toBe(0)
  }, TEST_TIMEOUT)

  it('shuts down cleanly on SIGTERM', async () => {
    server = await spawnTestServer()
    const ws = await connectWs(server.url, server.token)

    // Server should be running
    expect(ws.readyState).toBe(WebSocket.OPEN)

    // Send SIGTERM
    server.proc.kill('SIGTERM')
    const exitCode = await server.proc.exited
    expect(exitCode).toBe(0)

    // Mark as stopped so afterEach doesn't double-kill
    server = null
  }, TEST_TIMEOUT)

  it('returns computer identity on a remote-eligible channel', async () => {
    server = await spawnTestServer()
    const ws = await connectWs(server.url, server.token)
    const identity = await rpc(ws, RPC_CHANNELS.server.GET_COMPUTER_IDENTITY) as {
      kind: string
      computerId: string
      dataRootVersion: number
    }
    expect(identity.kind).toBe('self-hosted-headless')
    expect(identity.computerId.length).toBeGreaterThan(0)
    expect(identity.dataRootVersion).toBe(1)
    ws.close()
  }, TEST_TIMEOUT)

  it('serves /health 200 when the browser runtime is skipped', async () => {
    const port = await freePort()
    server = await spawnTestServer({ KATA_HEALTH_PORT: String(port) })
    expect(server.healthUrl).toBe(`http://127.0.0.1:${port}/health`)
    const response = await fetch(server.healthUrl!)
    expect(response.status).toBe(200)
    const body = await response.json() as { status: string; checks: Array<{ name: string; status: string }> }
    expect(body.status).toBe('degraded')
    expect(body.checks.some((check) => check.name === 'computer_browser' && check.status === 'fail')).toBe(true)
    expect(body.checks.some((check) => check.name === 'computer_storage' && check.status === 'pass')).toBe(true)
  }, TEST_TIMEOUT)

  it('fails closed when packaged without KATA_DATA_ROOT', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'kata-server-smoke-'))
    const {
      CLAUDECODE: _,
      KATA_SERVER_TOKEN: _serverToken,
      KATA_CONFIG_DIR: _configDir,
      KATA_DATA_ROOT: _dataRoot,
      KATA_IS_PACKAGED: _packaged,
      ...parentEnv
    } = process.env
    const proc = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
      env: {
        ...parentEnv,
        KATA_IS_PACKAGED: 'true',
        KATA_SERVER_TOKEN: 'token-with-enough-entropy-0123456789',
        KATA_RPC_PORT: '0',
        KATA_RPC_HOST: '127.0.0.1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exitCode = await proc.exited
    rmSync(configDir, { recursive: true, force: true })
    expect(exitCode).not.toBe(0)
  }, TEST_TIMEOUT)

  it('fails closed when packaged with --allow-insecure-bind', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'kata-server-smoke-'))
    const {
      CLAUDECODE: _,
      KATA_SERVER_TOKEN: _serverToken,
      KATA_CONFIG_DIR: _configDir,
      KATA_DATA_ROOT: _dataRoot,
      KATA_IS_PACKAGED: _packaged,
      ...parentEnv
    } = process.env
    const proc = Bun.spawn(['bun', 'run', SERVER_ENTRY, '--allow-insecure-bind'], {
      env: {
        ...parentEnv,
        KATA_IS_PACKAGED: 'true',
        KATA_DATA_ROOT: configDir,
        KATA_SERVER_TOKEN: 'token-with-enough-entropy-0123456789',
        KATA_RPC_PORT: '0',
        KATA_RPC_HOST: '127.0.0.1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exitCode = await proc.exited
    rmSync(configDir, { recursive: true, force: true })
    expect(exitCode).not.toBe(0)
  }, TEST_TIMEOUT)

  it('fails closed when packaged without a token', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'kata-server-smoke-'))
    const {
      CLAUDECODE: _,
      KATA_SERVER_TOKEN: _serverToken,
      KATA_CONFIG_DIR: _configDir,
      KATA_DATA_ROOT: _dataRoot,
      KATA_IS_PACKAGED: _packaged,
      ...parentEnv
    } = process.env
    const proc = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
      env: {
        ...parentEnv,
        KATA_IS_PACKAGED: 'true',
        KATA_DATA_ROOT: configDir,
        KATA_RPC_PORT: '0',
        KATA_RPC_HOST: '127.0.0.1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exitCode = await proc.exited
    rmSync(configDir, { recursive: true, force: true })
    expect(exitCode).not.toBe(0)
  }, TEST_TIMEOUT)

  it('fails closed when binding a public address without TLS', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'kata-server-smoke-'))
    const {
      CLAUDECODE: _,
      KATA_SERVER_TOKEN: _serverToken,
      KATA_CONFIG_DIR: _configDir,
      ...parentEnv
    } = process.env
    const proc = Bun.spawn(['bun', 'run', SERVER_ENTRY], {
      env: {
        ...parentEnv,
        KATA_CONFIG_DIR: configDir,
        KATA_SERVER_TOKEN: 'token-with-enough-entropy-0123456789',
        KATA_RPC_PORT: '0',
        KATA_RPC_HOST: '0.0.0.0',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exitCode = await proc.exited
    rmSync(configDir, { recursive: true, force: true })
    expect(exitCode).not.toBe(0)
  }, TEST_TIMEOUT)

  it('reopens the same computer id and files after SIGTERM', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'kata-server-smoke-'))
    mkdirSync(join(configDir, 'workspaces'), { recursive: true })
    writeFileSync(join(configDir, 'workspaces', 'bot-a.txt'), 'from-bot-a')
    server = await spawnTestServer(undefined, { configDir, keepConfigDir: true })
    const ws = await connectWs(server.url, server.token)
    const first = await rpc(ws, RPC_CHANNELS.server.GET_COMPUTER_IDENTITY) as { computerId: string }
    ws.close()
    server.proc.kill('SIGTERM')
    expect(await server.proc.exited).toBe(0)
    server = null

    server = await spawnTestServer(undefined, { configDir, keepConfigDir: false })
    const ws2 = await connectWs(server.url, server.token)
    const second = await rpc(ws2, RPC_CHANNELS.server.GET_COMPUTER_IDENTITY) as { computerId: string }
    expect(second.computerId).toBe(first.computerId)
    expect(readFileSync(join(configDir, 'workspaces', 'bot-a.txt'), 'utf8')).toBe('from-bot-a')
    ws2.close()
  }, 45_000)
})
