import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireRuntimeLock } from './lock.ts'
import { ComputerAlreadyRunning } from './errors.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempLock(): string {
  const root = mkdtempSync(join(tmpdir(), 'kata-runtime-lock-'))
  roots.push(root)
  return join(root, '.runtime.lock')
}

describe('acquireRuntimeLock', () => {
  it('rejects a second acquire in the same process', () => {
    const path = tempLock()
    const handle = acquireRuntimeLock(path)
    try {
      acquireRuntimeLock(path)
      throw new Error('expected ComputerAlreadyRunning')
    } catch (error) {
      expect(error).toBeInstanceOf(ComputerAlreadyRunning)
    }
    handle.release()
  })

  it('replaces a lock whose pid is dead', () => {
    const path = tempLock()
    writeFileSync(path, `${JSON.stringify({ pid: 2_147_483_647, startedAt: Date.now() })}\n`)
    const handle = acquireRuntimeLock(path)
    expect(handle.pid).toBe(process.pid)
    handle.release()
  })

  it('lets only one of two processes keep the lock', async () => {
    const path = tempLock()
    const child = join(import.meta.dir, 'lock-contend-child.ts')
    const first = Bun.spawn(['bun', child, path], { stdout: 'pipe', stderr: 'pipe' })
    const second = Bun.spawn(['bun', child, path], { stdout: 'pipe', stderr: 'pipe' })
    const codes = [await first.exited, await second.exited].sort()
    expect(codes).toEqual([0, 2])
  })
})
