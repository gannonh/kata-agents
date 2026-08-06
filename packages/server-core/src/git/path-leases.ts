/**
 * Canonical checkout-path lease manager.
 *
 * Every live session leases its checkout path. Lifecycle operations treat a
 * lease held by a session outside the transaction's owner set as a foreign
 * writer: capture/removal refuse while such a lease exists, and sessions that
 * are not yet reflected in registry owners (a session bound but not persisted)
 * still hold a lease, so they protect their checkout from the first instant.
 *
 * Leases are marker files under server-owned lock storage, so a second server
 * process observes them the same way the registry lock is shared. Markers are
 * created and removed by exact content, never recursively.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { processIsAlive } from './mutation-lock'

interface LeaseMarker {
  sessionId: string
  path: string
  pid: number
  token: string
  acquiredAt: number
}

function pathKey(path: string): string {
  return createHash('sha256').update(resolvePath(path)).digest('hex').slice(0, 32)
}

function markerName(path: string, token: string): string {
  return `${pathKey(path)}.${token}.lease.json`
}

export class PathLeaseManager {
  private readonly lockRoot: string
  private readonly inProcess = new Map<string, { path: string; marker: string }>()

  constructor(lockRoot: string) {
    this.lockRoot = resolvePath(lockRoot)
    mkdirSync(this.lockRoot, { recursive: true })
  }

  private markerPath(marker: string): string {
    return join(this.lockRoot, marker)
  }

  private writeMarker(marker: LeaseMarker): string {
    const name = markerName(marker.path, marker.token)
    const path = this.markerPath(name)
    const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
    writeFileSync(tmp, JSON.stringify(marker), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    try {
      // Atomic replace so a concurrent reader never sees a partial marker.
      renameSync(tmp, path)
    } catch (error) {
      try {
        rmSync(tmp, { force: true })
      } catch {
        /* preserve the original error */
      }
      throw error
    }
    return name
  }

  /** Bind `sessionId` to `path`, replacing any prior lease of that session. */
  lease(sessionId: string, path: string): void {
    if (!sessionId || !path) throw new Error('Session ID and path are required for a lease.')
    const previous = this.inProcess.get(sessionId)
    if (previous) {
      this.removeMarker(previous.marker)
      this.inProcess.delete(sessionId)
    }
    const marker = this.writeMarker({
      sessionId,
      path: resolvePath(path),
      pid: process.pid,
      token: randomBytes(8).toString('hex'),
      acquiredAt: Date.now(),
    })
    this.inProcess.set(sessionId, { path: resolvePath(path), marker })
  }

  private removeMarker(marker: string): void {
    try {
      const path = this.markerPath(marker)
      if (!existsSync(path)) return
      const observed = this.readMarker(path)
      if (observed?.marker !== marker) return
      rmSync(path, { force: true })
    } catch {
      // Best-effort: a stale marker can be pruned by the next lifecycle sweep.
    }
  }

  private readMarker(path: string): { marker: string; lease: LeaseMarker } | null {
    try {
      const raw = readFileSync(path, 'utf8')
      const parsed = JSON.parse(raw) as Partial<LeaseMarker>
      if (
        typeof parsed.sessionId !== 'string' ||
        typeof parsed.path !== 'string' ||
        !Number.isInteger(parsed.pid) ||
        typeof parsed.token !== 'string' ||
        !Number.isFinite(parsed.acquiredAt)
      ) {
        return null
      }
      return {
        marker: markerName(parsed.path, parsed.token),
        lease: parsed as LeaseMarker,
      }
    } catch {
      return null
    }
  }

  private readMarkers(): Array<{ marker: string; lease: LeaseMarker }> {
    let names: string[]
    try {
      names = readdirSync(this.lockRoot)
    } catch {
      return []
    }
    const markers: Array<{ marker: string; lease: LeaseMarker }> = []
    for (const name of names) {
      if (!name.endsWith('.lease.json') || name.includes('.tmp-')) continue
      const observed = this.readMarker(join(this.lockRoot, name))
      if (observed) markers.push(observed)
    }
    return markers
  }

  /** Session IDs currently leasing the canonical path (cross-process). */
  leasedBy(path: string): string[] {
    const key = pathKey(path)
    return this.readMarkers()
      .filter(({ marker, lease }) => marker.startsWith(`${key}.`) && resolvePath(lease.path) === resolvePath(path))
      .map(({ lease }) => lease.sessionId)
  }

  /** True when a session outside `exclude` holds a lease on the path. */
  hasForeignLease(path: string, exclude: Set<string>): boolean {
    return this.leasedBy(path).some((sessionId) => !exclude.has(sessionId))
  }

  /** Paths currently leased by a session (canonical). */
  leasesForSession(sessionId: string): string[] {
    return this.readMarkers()
      .filter(({ lease }) => lease.sessionId === sessionId)
      .map(({ lease }) => lease.path)
  }

  /** All leases: sessionId → canonical paths. */
  allLeases(): Map<string, string[]> {
    const grouped = new Map<string, string[]>()
    for (const { lease } of this.readMarkers()) {
      const paths = grouped.get(lease.sessionId) ?? []
      paths.push(lease.path)
      grouped.set(lease.sessionId, paths)
    }
    return grouped
  }

  /** Release one path lease held by a session (exact marker only). */
  release(sessionId: string, path: string): void {
    const canonical = resolvePath(path)
    const owned = this.inProcess.get(sessionId)
    if (owned && resolvePath(owned.path) === canonical) {
      this.removeMarker(owned.marker)
      this.inProcess.delete(sessionId)
      return
    }
    // A lease from another process for this session is removed by exact marker
    // content, never by path alone.
    for (const { marker, lease } of this.readMarkers()) {
      if (lease.sessionId === sessionId && resolvePath(lease.path) === canonical) {
        this.removeMarker(marker)
      }
    }
  }

  /** Release every lease held by a session (session teardown). */
  releaseSession(sessionId: string): void {
    const owned = this.inProcess.get(sessionId)
    if (owned) {
      this.removeMarker(owned.marker)
      this.inProcess.delete(sessionId)
    }
    for (const { marker, lease } of this.readMarkers()) {
      if (lease.sessionId === sessionId) this.removeMarker(marker)
    }
  }

  /** Remove markers whose owning process is gone (stale-lease recovery). */
  pruneStale(): number {
    let removed = 0
    for (const { marker, lease } of this.readMarkers()) {
      const alive = processIsAlive(lease.pid)
      if (alive === false) {
        this.removeMarker(marker)
        removed += 1
      }
    }
    return removed
  }
}

/** Shared lease-root path factory for the server. */
export function defaultLeaseRoot(configDir: string): string {
  return join(configDir, 'locks', 'path-leases')
}
