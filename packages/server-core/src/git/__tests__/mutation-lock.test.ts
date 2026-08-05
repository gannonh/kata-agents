import { describe, test, expect } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MutationLock } from '../mutation-lock'
import { cleanup, makeTmpDir } from './test-helpers'

describe('MutationLock', () => {
  test('serializes operations for the same common directory', async () => {
    const lock = new MutationLock()
    const order: string[] = []
    const op = (id: string, ms: number) =>
      lock.withLock('/repo/.git', async () => {
        order.push(`start-${id}`)
        await new Promise((r) => setTimeout(r, ms))
        order.push(`end-${id}`)
      })
    await Promise.all([op('a', 30), op('b', 5), op('c', 5)])
    // Each op fully completes before the next starts.
    expect(order).toEqual(['start-a', 'end-a', 'start-b', 'end-b', 'start-c', 'end-c'])
  })

  test('runs operations for different common directories concurrently', async () => {
    const lock = new MutationLock()
    const order: string[] = []
    const op = (dir: string, id: string, ms: number) =>
      lock.withLock(dir, async () => {
        order.push(`start-${id}`)
        await new Promise((r) => setTimeout(r, ms))
        order.push(`end-${id}`)
      })
    await Promise.all([op('/repo1/.git', 'a', 20), op('/repo2/.git', 'b', 5)])
    // b (different dir) starts before a finishes.
    expect(order.indexOf('start-b')).toBeLessThan(order.indexOf('end-a'))
  })

  test('a failing operation does not poison the queue', async () => {
    const lock = new MutationLock()
    await expect(
      lock.withLock('/repo/.git', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    const result = await lock.withLock('/repo/.git', async () => 'ok')
    expect(result).toBe('ok')
  })

  test('serializes with a separate process without placing locks in the repository', async () => {
    const root = makeTmpDir('kata-lock-test-')
    const lockRoot = resolve(root, 'server-locks')
    const signal = resolve(root, 'child-started')
    const commonDir = '/repo/cross-process/.git'
    const modulePath = resolve(import.meta.dir, '../mutation-lock.ts')
    const script = `
      import { writeFileSync } from 'node:fs'
      import { MutationLock } from ${JSON.stringify(modulePath)}
      const lock = new MutationLock(${JSON.stringify(lockRoot)}, { timeoutMs: 5000, retryDelayMs: 5 })
      await lock.withLock(${JSON.stringify(commonDir)}, async () => {
        writeFileSync(${JSON.stringify(signal)}, 'started')
        await new Promise((resolve) => setTimeout(resolve, 180))
      })
    `
    const child = spawn(process.execPath, ['-e', script], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    let childOutput = ''
    child.stdout.on('data', (chunk) => { childOutput += String(chunk) })
    child.stderr.on('data', (chunk) => { childOutput += String(chunk) })
    try {
      for (let attempt = 0; attempt < 100 && !existsSync(signal); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(readFileSync(signal, 'utf8')).toBe('started')
      const startedAt = Date.now()
      const lock = new MutationLock(lockRoot, { timeoutMs: 5000, retryDelayMs: 5 })
      try {
        await lock.withLock(commonDir, async () => undefined)
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}\n${childOutput}`)
      }
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100)
      // The child has released the lock once the parent acquires it. Terminate
      // it explicitly so a Bun child with inherited test handles cannot keep
      // the test process alive after the assertion.
      if (!child.killed) child.kill('SIGTERM')
      expect(existsSync(resolve(lockRoot, 'git'))).toBe(false)
      expect(existsSync(resolve('/repo/cross-process', '.kata-lock'))).toBe(false)
    } finally {
      if (!child.killed) child.kill('SIGKILL')
      cleanup(root)
    }
  })
})
