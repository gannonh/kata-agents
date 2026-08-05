import { describe, test, expect } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CrossProcessFileLock, MutationLock } from '../mutation-lock'
import { cleanup, makeTmpDir } from './test-helpers'

/** A pid that is guaranteed to be dead (a just-exited child cannot be reused). */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
  if (!child.pid) throw new Error('unable to obtain a dead pid for the stale-owner marker')
  return child.pid
}

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

  test('recovers a dead owner without recursively deleting a replacement lock', () => {
    const root = makeTmpDir('kata-stale-lock-test-')
    const lockPath = resolve(root, 'server-locks', 'common.lock')
    mkdirSync(lockPath, { recursive: true })
    const staleMarker = resolve(lockPath, 'owner-dead-token.json')
    writeFileSync(
      staleMarker,
      JSON.stringify({ token: 'dead-token', pid: deadPid(), acquiredAt: 1 }),
    )
    const old = new Date(1)
    utimesSync(lockPath, old, old)

    const lock = new CrossProcessFileLock(lockPath, { staleAfterMs: 0, timeoutMs: 1000 })
    expect(lock.runSync(() => 'acquired')).toBe('acquired')
    expect(existsSync(lockPath)).toBe(false)
    cleanup(root)
  })

  test('does not stale-reap an active successor after dead-owner handoff', async () => {
    const root = makeTmpDir('kata-successor-lock-test-')
    const lockPath = resolve(root, 'server-locks', 'common.lock')
    mkdirSync(lockPath, { recursive: true })
    const staleMarker = resolve(lockPath, 'owner-dead-token.json')
    writeFileSync(
      staleMarker,
      JSON.stringify({ token: 'dead-token', pid: deadPid(), acquiredAt: 1 }),
    )
    const old = new Date(1)
    utimesSync(lockPath, old, old)
    const started = resolve(root, 'successor-started')
    const finished = resolve(root, 'successor-finished')
    const modulePath = resolve(import.meta.dir, '../mutation-lock.ts')
    const script = `
      import { writeFileSync } from 'node:fs'
      import { CrossProcessFileLock } from ${JSON.stringify(modulePath)}
      const lock = new CrossProcessFileLock(${JSON.stringify(lockPath)}, { staleAfterMs: 0, timeoutMs: 5000, retryDelayMs: 5 })
      await lock.run(async () => {
        writeFileSync(${JSON.stringify(started)}, 'started')
        await new Promise((resolve) => setTimeout(resolve, 180))
        writeFileSync(${JSON.stringify(finished)}, 'finished')
      })
    `
    const child = spawn(process.execPath, ['-e', script], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    try {
      for (let attempt = 0; attempt < 100 && !existsSync(started); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      expect(readFileSync(started, 'utf8')).toBe('started')
      const parent = new CrossProcessFileLock(lockPath, { staleAfterMs: 0, timeoutMs: 5000, retryDelayMs: 5 })
      parent.runSync(() => undefined)
      expect(readFileSync(finished, 'utf8')).toBe('finished')
    } finally {
      if (!child.killed) child.kill('SIGKILL')
      cleanup(root)
    }
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
      // Positive proof that the cross-process lock lives under the server-owned
      // lock root (never inside the repository) while the child holds it.
      const digestLockPath = lock.getLockPath(commonDir)
      expect(existsSync(digestLockPath)).toBe(true)
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
      // After release the digest lock is removed and no stray `git` directory
      // or repository-adjacent lock was ever created.
      expect(existsSync(digestLockPath)).toBe(false)
      expect(existsSync(resolve(lockRoot, 'git'))).toBe(false)
      expect(existsSync(resolve('/repo/cross-process', '.kata-lock'))).toBe(false)
    } finally {
      if (!child.killed) child.kill('SIGKILL')
      cleanup(root)
    }
  })
})
