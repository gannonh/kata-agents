/**
 * Cross-process mutation locks.
 *
 * Linked worktrees share one Git common directory, so concurrent Kata-issued
 * mutations can race on shared Git metadata.  A process-local promise chain is
 * not enough when two server processes own the same filesystem, therefore the
 * tail of every chain also takes an OS-visible mkdir lock.  Lock directories
 * are kept under server/config storage (never in the repository itself).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { CONFIG_DIR } from '@kata-sh/shared/config/paths'

export interface CrossProcessLockOptions {
  /** Maximum time to wait before reporting a lock timeout. */
  timeoutMs?: number
  /** Delay between attempts to acquire an already-held lock. */
  retryDelayMs?: number
  /** Age after which an owner that cannot be inspected is recoverable. */
  staleAfterMs?: number
}

interface LockOwner {
  token: string
  pid: number
  acquiredAt: number
}

interface ObservedOwner {
  owner?: LockOwner
  path: string
  /** Marker content + filesystem identity observed for exact deletion. */
  fingerprint: string
}

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_RETRY_DELAY_MS = 10
const DEFAULT_STALE_AFTER_MS = 30_000

function sleepSync(ms: number): void {
  // Public registry methods are synchronous. Atomics.wait provides a bounded
  // sleep without a busy loop while another process owns the lock.
  const signal = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(signal, 0, 0, ms)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function processIsAlive(pid: number): boolean | null {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    // EPERM means the process exists but this process cannot signal it.
    if (code === 'EPERM') return true
    return null
  }
}

/**
 * A small mkdir-based lock. `mkdir` is atomic across processes and filesystems
 * supported by Node. The owner token prevents a stale-lock reaper from
 * deleting a newer owner's lock when the old owner finally returns.
 */
export class CrossProcessFileLock {
  readonly lockPath: string
  private readonly options: Required<CrossProcessLockOptions>

  constructor(lockPath: string, options: CrossProcessLockOptions = {}) {
    this.lockPath = lockPath
    this.options = {
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      retryDelayMs: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
      staleAfterMs: options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
    }
  }

  private ownerPath(token: string, root = this.lockPath): string {
    return join(root, `owner-${token}.json`)
  }

  private claimPath(token: string): string {
    return `${this.lockPath}.claim-${token}`
  }

  private parseOwnerFile(path: string, expectedName?: string): ObservedOwner | null {
    let raw: string
    let fingerprint: string
    try {
      raw = readFileSync(path, 'utf8')
      const stat = statSync(path)
      fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${createHash('sha256').update(raw).digest('hex')}`
    } catch {
      return null
    }
    try {
      const parsed = JSON.parse(raw) as Partial<LockOwner>
      if (
        typeof parsed.token !== 'string' ||
        !parsed.token ||
        !Number.isInteger(parsed.pid) ||
        !Number.isFinite(parsed.acquiredAt) ||
        (expectedName !== undefined && expectedName !== `owner-${parsed.token}.json`)
      ) {
        // Current owners are written completely in a private claim directory
        // before publication. A malformed visible marker is therefore safely
        // recoverable only by exact-marker deletion after it becomes stale.
        return { path, fingerprint }
      }
      return {
        path,
        fingerprint,
        owner: {
          token: parsed.token,
          pid: parsed.pid as number,
          acquiredAt: parsed.acquiredAt as number,
        },
      }
    } catch {
      return { path, fingerprint }
    }
  }

  /** Read the exact owner marker and its path for CAS-like stale removal. */
  private readOwner(): ObservedOwner | null {
    let names: string[]
    try {
      names = readdirSync(this.lockPath)
    } catch {
      return null
    }
    const ownerNames = names.filter(
      (name) => name.startsWith('owner-') && name.endsWith('.json'),
    )
    // A lock may be observed between mkdir and owner marker creation. The
    // atomic claim protocol never publishes such a directory; ownerless
    // directories are consequently not stale-reaped.
    if (ownerNames.length === 1) {
      return this.parseOwnerFile(join(this.lockPath, ownerNames[0]!), ownerNames[0])
    }
    if (ownerNames.length !== 0 || names.length !== 1 || names[0] !== 'owner.json') {
      return null
    }
    // Support lock directories created by the previous fixed owner.json
    // marker while they drain. The stale remover still uses non-recursive,
    // exact-marker deletion below, so it cannot remove a replacement lock.
    return this.parseOwnerFile(join(this.lockPath, 'owner.json'))
  }

  private isStale(observed: ObservedOwner | null): boolean {
    if (!observed) return false
    if (observed.owner) {
      const alive = processIsAlive(observed.owner.pid)
      if (alive === false) return true
      if (alive === true) return false
    }
    try {
      const age = Date.now() - statSync(this.lockPath).mtimeMs
      return age >= this.options.staleAfterMs
    } catch {
      // A lock that disappears while inspected is not held anymore.
      return true
    }
  }

  /**
   * Attempt stale recovery without recursively deleting the lock directory.
   * We re-read the owner immediately before unlinking the exact observed marker
   * and then require rmdir to prove the directory is empty. A waiter that won
   * the race cannot be deleted: it cannot acquire until this directory is
   * removed, and rmdir fails rather than removing a newly-created marker.
   */
  private tryBreakStale(): void {
    if (!existsSync(this.lockPath)) return
    const observed = this.readOwner()
    // The atomic claim protocol never exposes an ownerless lock directory. Do
    // not reap one: an in-flight claimant must never be allowed to continue
    // against a successor that acquired the same path.
    if (!observed || !this.isStale(observed)) return
    try {
      const confirmed = this.readOwner()
      if (
        !confirmed ||
        confirmed.path !== observed.path ||
        confirmed.fingerprint !== observed.fingerprint ||
        confirmed.owner?.token !== observed.owner?.token ||
        confirmed.owner?.acquiredAt !== observed.owner?.acquiredAt
      ) return
      unlinkSync(confirmed.path)
      // Non-recursive removal is the final ownership check. If a replacement
      // marker appeared, the directory is non-empty and remains protected.
      rmdirSync(this.lockPath)
    } catch {
      // The owner or another waiter may have won the race. The next attempt
      // will inspect the current lock again.
    }
  }

  private claimSync(owner: LockOwner): boolean {
    const claimPath = this.claimPath(owner.token)
    let claimed = false
    try {
      mkdirSync(claimPath)
      claimed = true
      writeFileSync(this.ownerPath(owner.token, claimPath), JSON.stringify(owner), {
        encoding: 'utf8',
        flag: 'wx',
      })
      renameSync(claimPath, this.lockPath)
      claimed = false
      return true
    } catch (error) {
      if (claimed) rmSync(claimPath, { recursive: true, force: true })
      if ((error as NodeJS.ErrnoException).code === 'EEXIST' || (error as NodeJS.ErrnoException).code === 'ENOTEMPTY') {
        return false
      }
      throw error
    }
  }

  private async claim(owner: LockOwner): Promise<boolean> {
    const claimPath = this.claimPath(owner.token)
    let claimed = false
    try {
      await mkdirAsync(claimPath, false)
      claimed = true
      writeFileSync(this.ownerPath(owner.token, claimPath), JSON.stringify(owner), {
        encoding: 'utf8',
        flag: 'wx',
      })
      renameSync(claimPath, this.lockPath)
      claimed = false
      return true
    } catch (error) {
      if (claimed) rmSync(claimPath, { recursive: true, force: true })
      if ((error as NodeJS.ErrnoException).code === 'EEXIST' || (error as NodeJS.ErrnoException).code === 'ENOTEMPTY') {
        return false
      }
      throw error
    }
  }

  private acquireInternalSync(): LockOwner {
    const started = Date.now()
    const owner: LockOwner = {
      token: randomBytes(16).toString('hex'),
      pid: process.pid,
      acquiredAt: Date.now(),
    }
    mkdirSync(dirname(this.lockPath), { recursive: true })

    for (;;) {
      try {
        if (this.claimSync(owner)) return owner
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      this.tryBreakStale()
      if (Date.now() - started >= this.options.timeoutMs) {
        throw new Error(`Timed out acquiring cross-process lock: ${this.lockPath}`)
      }
      sleepSync(this.options.retryDelayMs)
    }
  }

  private async acquireInternal(): Promise<LockOwner> {
    const started = Date.now()
    const owner: LockOwner = {
      token: randomBytes(16).toString('hex'),
      pid: process.pid,
      acquiredAt: Date.now(),
    }
    await mkdirAsync(dirname(this.lockPath), true)

    for (;;) {
      try {
        if (await this.claim(owner)) return owner
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      this.tryBreakStale()
      if (Date.now() - started >= this.options.timeoutMs) {
        throw new Error(`Timed out acquiring cross-process lock: ${this.lockPath}`)
      }
      await sleep(this.options.retryDelayMs)
    }
  }

  private release(owner: LockOwner): void {
    try {
      const observed = this.readOwner()
      if (!observed || observed.owner?.token !== owner.token) return
      const confirmed = this.readOwner()
      if (
        !confirmed ||
        confirmed.path !== observed.path ||
        confirmed.owner?.token !== observed.owner?.token ||
        confirmed.owner?.acquiredAt !== observed.owner?.acquiredAt
      ) return
      // Remove only this exact marker, then require the directory to be empty.
      // This prevents a delayed release from recursively deleting a successor
      // that acquired the lock after a stale-owner recovery.
      unlinkSync(confirmed.path)
      rmdirSync(this.lockPath)
    } catch {
      // Release is best-effort. A stale lock can be recovered by the next
      // waiter, and never turns a successful mutation into a false failure.
    }
  }

  runSync<T>(fn: () => T): T {
    const owner = this.acquireInternalSync()
    try {
      return fn()
    } finally {
      this.release(owner)
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const owner = await this.acquireInternal()
    try {
      return await fn()
    } finally {
      this.release(owner)
    }
  }
}

/**
 * Mutation lock keyed by Git common directory. Calls for the same common
 * directory serialize in call order both within this process and across
 * server processes. Different common directories use different files and can
 * proceed concurrently.
 */
export class MutationLock {
  private readonly lockDirectory: string
  private readonly lockOptions: CrossProcessLockOptions
  private chains = new Map<string, Promise<unknown>>()

  constructor(
    lockDirectory = join(CONFIG_DIR, 'locks', 'git'),
    options: CrossProcessLockOptions = {},
  ) {
    this.lockDirectory = resolvePath(lockDirectory)
    this.lockOptions = options
  }

  /** Stable lock path used by a common-directory key. */
  getLockPath(gitCommonDir: string): string {
    const key = resolvePath(gitCommonDir)
    const digest = createHash('sha256').update(key).digest('hex').slice(0, 32)
    return join(this.lockDirectory, `${digest}.lock`)
  }

  async withLock<T>(gitCommonDir: string, fn: () => Promise<T>): Promise<T> {
    const key = resolvePath(gitCommonDir)
    const prev = this.chains.get(key) ?? Promise.resolve()
    const run = prev.then(
      () => new CrossProcessFileLock(this.getLockPath(key), this.lockOptions).run(fn),
      () => new CrossProcessFileLock(this.getLockPath(key), this.lockOptions).run(fn),
    )
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    this.chains.set(key, tail)
    try {
      return await run
    } finally {
      if (this.chains.get(key) === tail) this.chains.delete(key)
    }
  }
}

async function mkdirAsync(path: string, recursive: boolean): Promise<void> {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(path, { recursive })
}
