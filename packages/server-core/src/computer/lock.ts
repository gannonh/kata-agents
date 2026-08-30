import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { uptime as osUptime } from 'node:os'
import { ComputerAlreadyRunning } from './errors.ts'

const heldLocks = new Set<string>()
const MAX_ACQUIRE_ATTEMPTS = 16

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

function isExclusiveCreateConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === 'EEXIST'
}

function isStaleLock(lock: LockPayload): boolean {
  if (lock.pid === process.pid) return true
  if (!isProcessAlive(lock.pid)) return true
  return isLockFromPreviousBoot(lock.startedAt)
}

function readLockFile(path: string): LockPayload | null {
  try {
    if (!existsSync(path)) return null
    return parseLock(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function makeHandle(path: string): RuntimeLockHandle {
  let released = false
  return {
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
}

export function acquireRuntimeLock(lockPath: string): RuntimeLockHandle {
  const path = resolve(lockPath)
  if (heldLocks.has(path)) throw new ComputerAlreadyRunning(process.pid, path)

  const payload: LockPayload = { pid: process.pid, startedAt: Date.now() }
  const serialized = `${JSON.stringify(payload)}\n`

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    try {
      writeFileSync(path, serialized, { flag: 'wx' })
      heldLocks.add(path)
      return makeHandle(path)
    } catch (error) {
      if (!isExclusiveCreateConflict(error)) throw error
    }

    const lock = readLockFile(path)
    if (!lock || isStaleLock(lock)) {
      try {
        unlinkSync(path)
      } catch {}
      continue
    }
    throw new ComputerAlreadyRunning(lock.pid, path)
  }

  throw new ComputerAlreadyRunning(process.pid, path)
}
