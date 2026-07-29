/**
 * Managed-worktree registry.
 *
 * Persists managed-worktree records atomically under the owning workspace's
 * Kata config data. Keeps an in-memory cache so synchronous derivations
 * (e.g. shared-owner counts for the composer identity badge) are cheap.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import type { ManagedWorktreeRecord, ManagedWorktreeState } from '@kata-sh/shared/protocol'

/** First 16 lowercase hex chars of SHA-256 over the normalized common-dir path. */
export function computeRepoKey(normalizedGitCommonDir: string): string {
  return createHash('sha256').update(normalizedGitCommonDir).digest('hex').slice(0, 16)
}

/** Eight lowercase hex chars from a cryptographically secure random source. */
export function generateToken(): string {
  return randomBytes(4).toString('hex')
}

interface RegistryFile {
  version: 1
  records: ManagedWorktreeRecord[]
}

export class WorktreeRegistry {
  private readonly registryPath: string
  private cache: Map<string, ManagedWorktreeRecord> = new Map()
  private loaded = false

  constructor(registryPath: string) {
    this.registryPath = registryPath
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.load()
  }

  load(): void {
    this.cache = new Map()
    try {
      if (existsSync(this.registryPath)) {
        const raw = readFileSync(this.registryPath, 'utf8')
        const parsed = JSON.parse(raw) as RegistryFile
        for (const rec of parsed.records ?? []) {
          this.cache.set(rec.managedWorktreeId, rec)
        }
      }
    } catch {
      // Corrupt registry: start empty rather than crash. Startup reconciliation
      // repairs derivable state.
      this.cache = new Map()
    }
    this.loaded = true
  }

  private persist(): void {
    const dir = dirname(this.registryPath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const data: RegistryFile = { version: 1, records: Array.from(this.cache.values()) }
    const tmp = `${this.registryPath}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, this.registryPath)
  }

  list(): ManagedWorktreeRecord[] {
    this.ensureLoaded()
    return Array.from(this.cache.values())
  }

  get(id: string): ManagedWorktreeRecord | undefined {
    this.ensureLoaded()
    return this.cache.get(id)
  }

  /** Synchronous owner count from cache (>= 0). */
  getOwnerCount(id: string): number {
    this.ensureLoaded()
    return this.cache.get(id)?.ownerSessionIds.length ?? 0
  }

  upsert(record: ManagedWorktreeRecord): void {
    this.ensureLoaded()
    this.cache.set(record.managedWorktreeId, record)
    this.persist()
  }

  setState(id: string, state: ManagedWorktreeState): void {
    this.ensureLoaded()
    const rec = this.cache.get(id)
    if (!rec) return
    rec.state = state
    this.persist()
  }

  addOwner(id: string, sessionId: string): void {
    this.ensureLoaded()
    const rec = this.cache.get(id)
    if (!rec) return
    if (!rec.ownerSessionIds.includes(sessionId)) {
      rec.ownerSessionIds.push(sessionId)
      this.persist()
    }
  }

  removeOwner(id: string, sessionId: string): void {
    this.ensureLoaded()
    const rec = this.cache.get(id)
    if (!rec) return
    const idx = rec.ownerSessionIds.indexOf(sessionId)
    if (idx >= 0) {
      rec.ownerSessionIds.splice(idx, 1)
      this.persist()
    }
  }

  remove(id: string): void {
    this.ensureLoaded()
    if (this.cache.delete(id)) this.persist()
  }

  /** Find a record by its checkout path (normalized). */
  findByCheckoutPath(checkoutPath: string): ManagedWorktreeRecord | undefined {
    this.ensureLoaded()
    for (const rec of this.cache.values()) {
      if (rec.checkoutPath === checkoutPath) return rec
    }
    return undefined
  }

  /**
   * Reconcile registry records against persisted session ownership. Removes
   * owner references for sessions that no longer exist and marks records with
   * a missing checkout path as `missing`. Never deletes records or checkouts.
   */
  reconcile(params: { knownSessionIds: Set<string> }): void {
    this.ensureLoaded()
    let dirty = false
    for (const rec of this.cache.values()) {
      const before = rec.ownerSessionIds.length
      rec.ownerSessionIds = rec.ownerSessionIds.filter((s) => params.knownSessionIds.has(s))
      if (rec.ownerSessionIds.length !== before) dirty = true
      if (rec.state === 'ready' && !existsSync(rec.checkoutPath)) {
        rec.state = 'missing'
        dirty = true
      }
    }
    if (dirty) this.persist()
  }
}

/** Best-effort removal of a directory tree. */
export function removeDir(path: string): boolean {
  try {
    if (existsSync(path)) rmSync(path, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

export { join as joinPath }
