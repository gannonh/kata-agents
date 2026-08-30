import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { uptime as osUptime } from 'node:os'
import { ComputerAlreadyRunning } from './errors.ts'

const heldLocks = new Set<string>()

export interface RuntimeLockHandle {
  path: string
  pid: number
  release(): void
}

interface LockPayload {
  pid: number
  startedAt: number
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function parseLock(raw: string): LockPayload | null {
  const trimmed = raw.trim()
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    const pid = typeof parsed.pid === 'number' ? parsed.pid : NaN
    const startedAt = typeof parsed.startedAt === 'number' ? parsed.startedAt : 0
    if (!Number.isNaN(pid)) return { pid, startedAt }
  } catch {
    const pid = Number.parseInt(trimmed, 10)
    if (!Number.isNaN(pid)) return { pid, startedAt: 0 }
  }
  return null
}

function isLockFromPreviousBoot(startedAt: number): boolean {
  if (startedAt <= 0) return false
  const bootTime = Date.now() - osUptime() * 1000
  return startedAt < bootTime
}

export function acquireRuntimeLock(lockPath: string): RuntimeLockHandle {
  const path = resolve(lockPath)
  if (heldLocks.has(path)) throw new ComputerAlreadyRunning(process.pid, path)

  if (existsSync(path)) {
    const lock = parseLock(readFileSync(path, 'utf8'))
    if (lock) {
      if (lock.pid === process.pid) {
        // PID reuse after a container restart. This process does not hold the lock.
      } else if (isProcessAlive(lock.pid) && !isLockFromPreviousBoot(lock.startedAt)) {
        throw new ComputerAlreadyRunning(lock.pid, path)
      }
    }
  }

  const payload: LockPayload = { pid: process.pid, startedAt: Date.now() }
  writeFileSync(path, `${JSON.stringify(payload)}\n`, 'utf8')
  heldLocks.add(path)

  let released = false
  const handle: RuntimeLockHandle = {
    path,
    pid: process.pid,
    release() {
      if (released) return
      released = true
      heldLocks.delete(path)
      try {
        if (!existsSync(path)) return
        const current = parseLock(readFileSync(path, 'utf8'))
        if (current && current.pid === process.pid) unlinkSync(path)
      } catch {}
    },
  }
  return handle
}
