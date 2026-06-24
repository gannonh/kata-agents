/**
 * Server spawner — start a headless Kata Agent server as a child process.
 *
 * Spawns `bun run <serverEntry>`, reads stdout for the `KATA_SERVER_URL=`
 * and `KATA_SERVER_TOKEN=` lines, and returns a handle to stop the server.
 *
 * Runtime-agnostic: uses only Node APIs (child_process / fs / url) so the
 * published CLI bundle works under both Bun and plain Node.js. Note: spawning
 * the server still shells out to `bun` (the server process itself runs under
 * Bun); the CLI client that imports this only needs Node to run the commands
 * that target an existing server.
 */

import { resolve, join, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpawnedServer {
  url: string
  token: string
  stop: () => Promise<void>
}

export interface SpawnServerOptions {
  /** Path to the server entry file. Auto-detected from monorepo root if omitted. */
  serverEntry?: string
  /** Extra env vars to pass to the server process. */
  env?: Record<string, string>
  /** How long to wait for the server to print its URL (ms). Default: 30000. */
  startupTimeout?: number
  /** Suppress server stderr output (useful for validation where only test output matters). */
  quiet?: boolean
}

// ---------------------------------------------------------------------------
// Auto-detect server entry
// ---------------------------------------------------------------------------

function findServerEntry(): string {
  // Walk up from this file's directory to find the monorepo root.
  // Expected layout: apps/cli/src/server-spawner.ts → root/packages/server/src/index.ts
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, 'packages', 'server', 'src', 'index.ts')
    if (existsSync(candidate)) return candidate
    dir = resolve(dir, '..')
  }
  throw new Error(
    'Could not auto-detect server entry. ' +
    'Pass --server-entry or ensure the monorepo layout includes packages/server/src/index.ts',
  )
}

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

export async function spawnServer(opts?: SpawnServerOptions): Promise<SpawnedServer> {
  const serverEntry = opts?.serverEntry ?? findServerEntry()
  const startupTimeout = opts?.startupTimeout ?? 30_000
  const token = crypto.randomUUID()

  // Strip CLAUDECODE to avoid the Claude Agent SDK's nesting guard rejecting
  // subprocess launches when the CLI is invoked from within a Claude Code session.
  const { CLAUDECODE: _, ...parentEnv } = process.env
  const proc: ChildProcessByStdio<null, Readable, Readable> = spawn('bun', ['run', serverEntry], {
    env: {
      ...parentEnv,
      ...opts?.env,
      KATA_SERVER_TOKEN: token,
      KATA_RPC_PORT: '0',
      KATA_RPC_HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  // Pipe server stderr to our stderr so --debug logs are visible (unless quiet)
  if (!opts?.quiet) {
    ;(async () => {
      try {
        for await (const chunk of proc.stderr) {
          process.stderr.write(chunk)
        }
      } catch {
        // Server exited — normal
      }
    })()
  }

  // Read stdout line by line looking for KATA_SERVER_URL=
  return new Promise<SpawnedServer>((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error(`Server did not start within ${startupTimeout}ms`))
    }, startupTimeout)

    let url = ''
    let buffer = ''

    const processLines = () => {
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? '' // keep incomplete last line in buffer
      for (const line of lines) {
        if (line.startsWith('KATA_SERVER_URL=')) {
          url = line.slice('KATA_SERVER_URL='.length).trim()
        }
        if (line.startsWith('KATA_SERVER_TOKEN=')) {
          // Server echoes the token — we already have it but this confirms ready
        }
        // Once we have the URL, the server is ready
        if (url) {
          clearTimeout(timer)
          resolve({
            url,
            token,
            stop: async () => {
              if (proc.exitCode !== null || proc.killed) return
              proc.kill('SIGTERM')
              await Promise.race([
                new Promise<void>((r) => proc.once('exit', () => r())),
                new Promise<void>((r) => setTimeout(r, 5_000)),
              ])
              if (proc.exitCode === null) proc.kill('SIGKILL')
            },
          })
          return
        }
      }
    }

    ;(async () => {
      const decoder = new TextDecoder()
      try {
        for await (const chunk of proc.stdout) {
          buffer += decoder.decode(chunk, { stream: true })
          processLines()
          if (url) return
        }
      } catch {
        // Stream closed
      }
      // If we get here without resolving, the process exited before printing the URL
      clearTimeout(timer)
      if (!url) {
        reject(new Error('Server process exited before printing KATA_SERVER_URL'))
      }
    })()
  })
}
