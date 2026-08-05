import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { randomBytes } from 'node:crypto'
import type {
  ManagedWorktreeRecordVersioned,
  ServerCapabilityDto,
  WorktreeSettingsSnapshot,
  WorktreeSettingsUpdateInput,
} from '@kata-sh/shared/protocol'
import { isWorktreeV2Enabled } from '@kata-sh/shared/feature-flags'
import { CONFIG_DIR } from '@kata-sh/shared/config/paths'
import { CrossProcessFileLock } from './mutation-lock'
import type { WorktreeRegistry } from './worktree-registry'

const SETTINGS_SCHEMA_VERSION = 1
const DEFAULT_SETTINGS_FILE = 'settings.json'

export type WorktreeSettingsErrorCode =
  | 'WORKTREE_SETTINGS_INVALID'
  | 'WORKTREE_SETTINGS_PROTECTED_PATH'
  | 'WORKTREE_SETTINGS_REPOSITORY_OVERLAP'
  | 'WORKTREE_SETTINGS_CHECKOUT_OVERLAP'
  | 'WORKTREE_SETTINGS_UNWRITABLE'
  | 'WORKTREE_SETTINGS_CORRUPT'
  | 'WORKTREE_SETTINGS_CONFLICT'
  | 'WORKTREE_SETTINGS_WRITE_FAILED'
  | 'WORKTREE_SETTINGS_LOCK_FAILED'

export class WorktreeSettingsError extends Error {
  readonly code: WorktreeSettingsErrorCode
  readonly settingsPath: string
  readonly cause?: unknown

  constructor(
    code: WorktreeSettingsErrorCode,
    message: string,
    settingsPath: string,
    cause?: unknown,
  ) {
    super(message)
    this.name = 'WorktreeSettingsError'
    this.code = code
    this.settingsPath = settingsPath
    this.cause = cause
  }
}

export interface WorktreeSettingsServiceOptions {
  /** Stable identity exposed to clients by the owning server. */
  serverId?: string
  /** Default root used when no settings file exists. */
  defaultRoot?: string
  /** Fixed server-local settings file. */
  settingsPath: string
  /** Fixed registry authority used for overlap validation. */
  registry: WorktreeRegistry
  /** Additional protected paths, such as future snapshot storage. */
  protectedPaths?: string[]
}

interface StoredWorktreeSettings {
  schemaVersion: 1
  version: number
  materializationRoot: string
}

function pathContains(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function pathOverlaps(left: string, right: string): boolean {
  return pathContains(left, right) || pathContains(right, left)
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return join(homedir(), path.slice(2))
  }
  return path
}

/** Resolve a path while retaining a canonical realpath for existing parents. */
function canonicalPath(path: string): string {
  let candidate = resolvePath(path)
  const suffix: string[] = []
  while (!existsSync(candidate)) {
    const parent = dirname(candidate)
    if (parent === candidate) break
    suffix.unshift(basename(candidate))
    candidate = parent
  }
  let base: string
  try {
    base = realpathSync(candidate)
  } catch {
    base = candidate
  }
  return resolvePath(base, ...suffix)
}

function writeAtomically(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, contents, 'utf8')
    try {
      fsyncSync(fd)
    } catch {
      // Some supported filesystems do not expose fsync for temporary files.
    }
    closeSync(fd)
    fd = undefined
    renameSync(temporary, path)
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* preserve the original error */
      }
    }
    try {
      rmSync(temporary, { force: true })
    } catch {
      /* preserve the original error */
    }
    throw error
  }
}

function freezeSnapshot(snapshot: WorktreeSettingsSnapshot): WorktreeSettingsSnapshot {
  return Object.freeze({ ...snapshot })
}

export class WorktreeSettingsService {
  private readonly serverId: string
  private readonly defaultRoot: string
  private readonly settingsPath: string
  /** Fixed registry authority used for overlap validation. */
  readonly registry: WorktreeRegistry
  private readonly protectedPaths: string[]
  private readonly lock: CrossProcessFileLock

  constructor(options: WorktreeSettingsServiceOptions) {
    const serverId = options.serverId ?? 'local'
    if (!serverId.trim()) {
      throw new WorktreeSettingsError(
        'WORKTREE_SETTINGS_INVALID',
        'Server ID must be non-empty.',
        resolvePath(options.settingsPath),
      )
    }
    this.serverId = serverId
    this.settingsPath = resolvePath(options.settingsPath)
    this.defaultRoot = canonicalPath(options.defaultRoot ?? join(CONFIG_DIR, 'worktrees'))
    this.registry = options.registry
    this.protectedPaths = [
      CONFIG_DIR,
      join(CONFIG_DIR, 'snapshots'),
      this.settingsPath,
      this.registry.getRegistryPath(),
      ...options.protectedPaths ?? [],
    ].map((path) => canonicalPath(path))
    this.lock = new CrossProcessFileLock(`${this.settingsPath}.lock`)
  }

  getSettingsPath(): string {
    return this.settingsPath
  }

  getDefaultRoot(): string {
    return this.defaultRoot
  }

  /** Public for renderer-independent tests and path validation callers. */
  expandPath(path: string): string {
    return canonicalPath(expandHome(path))
  }

  getCapability(serverId = this.serverId): ServerCapabilityDto {
    return Object.freeze({
      serverId,
      worktreeV2: isWorktreeV2Enabled(),
    })
  }

  /** Capture a fresh immutable root/version snapshot from the authoritative file. */
  getSnapshot(serverId = this.serverId): WorktreeSettingsSnapshot {
    try {
      let snapshot!: WorktreeSettingsSnapshot
      this.lock.runSync(() => {
        const stored = this.readStoredSettings()
        this.ensureRootUsable(stored.materializationRoot, stored.materializationRoot === this.defaultRoot)
        snapshot = freezeSnapshot({
          schemaVersion: SETTINGS_SCHEMA_VERSION,
          serverId,
          version: stored.version,
          materializationRoot: stored.materializationRoot,
          capturedAt: Date.now(),
        })
      })
      return snapshot
    } catch (error) {
      throw this.wrapLockError(error)
    }
  }

  /** Alias used by root-provider consumers that prefer a snapshot verb. */
  snapshot(serverId = this.serverId): WorktreeSettingsSnapshot {
    return this.getSnapshot(serverId)
  }

  /**
   * Revalidate a captured policy immediately before a new checkout is
   * materialized. The selected source repository is never allowed inside or
   * around the materialization root, even if it was created after the last
   * settings save.
   */
  validateForCreation(snapshot: WorktreeSettingsSnapshot, repositoryRoot: string): void {
    const root = canonicalPath(snapshot.materializationRoot)
    if (
      snapshot.schemaVersion !== SETTINGS_SCHEMA_VERSION ||
      !Number.isInteger(snapshot.version) ||
      snapshot.version < 0 ||
      root !== snapshot.materializationRoot ||
      !isAbsolute(snapshot.materializationRoot)
    ) {
      throw new WorktreeSettingsError(
        'WORKTREE_SETTINGS_CONFLICT',
        'The captured managed-worktree settings snapshot is invalid or stale.',
        this.settingsPath,
      )
    }
    this.ensureRootUsable(root, root === this.defaultRoot)
    if (pathOverlaps(root, canonicalPath(repositoryRoot))) {
      throw new WorktreeSettingsError(
        'WORKTREE_SETTINGS_REPOSITORY_OVERLAP',
        `Managed-worktree root overlaps the selected repository: ${repositoryRoot}`,
        this.settingsPath,
      )
    }
  }

  /** Persist a validated root update and return the next immutable snapshot. */
  update(input: WorktreeSettingsUpdateInput, serverId = this.serverId): WorktreeSettingsSnapshot {
    try {
      let snapshot!: WorktreeSettingsSnapshot
      this.lock.runSync(() => {
        const current = this.readStoredSettings()
        const requested = this.validateRequestedRoot(input.materializationRoot, current.materializationRoot)
        if (requested === current.materializationRoot) {
          snapshot = freezeSnapshot({
            schemaVersion: SETTINGS_SCHEMA_VERSION,
            serverId,
            version: current.version,
            materializationRoot: current.materializationRoot,
            capturedAt: Date.now(),
          })
          return
        }

        // The fixed default root is intentionally allowed to contain the
        // existing registry/checkouts; resetting to it must remain possible.
        if (requested !== this.defaultRoot) this.validateAgainstRegistry(requested)
        this.ensureRootUsable(requested, requested === this.defaultRoot)
        const next: StoredWorktreeSettings = {
          schemaVersion: SETTINGS_SCHEMA_VERSION,
          version: current.version + 1,
          materializationRoot: requested,
        }
        try {
          writeAtomically(this.settingsPath, JSON.stringify(next, null, 2) + '\n')
        } catch (error) {
          throw new WorktreeSettingsError(
            'WORKTREE_SETTINGS_WRITE_FAILED',
            'Unable to persist the managed-worktree root setting.',
            this.settingsPath,
            error,
          )
        }
        snapshot = freezeSnapshot({
          schemaVersion: SETTINGS_SCHEMA_VERSION,
          serverId,
          version: next.version,
          materializationRoot: next.materializationRoot,
          capturedAt: Date.now(),
        })
      })
      return snapshot
    } catch (error) {
      throw this.wrapLockError(error)
    }
  }

  private readStoredSettings(): StoredWorktreeSettings {
    if (!existsSync(this.settingsPath)) {
      this.ensureRootUsable(this.defaultRoot, true)
      return {
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        version: 0,
        materializationRoot: this.defaultRoot,
      }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.settingsPath, 'utf8'))
    } catch (error) {
      throw new WorktreeSettingsError(
        'WORKTREE_SETTINGS_CORRUPT',
        'Managed-worktree root settings are unreadable or invalid JSON.',
        this.settingsPath,
        error,
      )
    }
    if (!this.isStoredSettings(parsed)) {
      throw new WorktreeSettingsError(
        'WORKTREE_SETTINGS_CORRUPT',
        'Managed-worktree root settings have an invalid schema.',
        this.settingsPath,
      )
    }
    const root = canonicalPath(parsed.materializationRoot)
    if (root !== parsed.materializationRoot || !isAbsolute(parsed.materializationRoot)) {
      throw new WorktreeSettingsError(
        'WORKTREE_SETTINGS_CORRUPT',
        'Managed-worktree root settings must contain a canonical absolute root.',
        this.settingsPath,
      )
    }
    return {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      version: parsed.version,
      materializationRoot: root,
    }
  }

  private isStoredSettings(value: unknown): value is StoredWorktreeSettings {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const candidate = value as Record<string, unknown>
    return (
      candidate.schemaVersion === SETTINGS_SCHEMA_VERSION &&
      Number.isInteger(candidate.version) &&
      (candidate.version as number) >= 0 &&
      typeof candidate.materializationRoot === 'string' &&
      candidate.materializationRoot.length > 0
    )
  }

  private validateRequestedRoot(input: string, currentRoot: string): string {
    if (typeof input !== 'string' || input.trim().length === 0) {
      throw new WorktreeSettingsError(
        'WORKTREE_SETTINGS_INVALID',
        'Managed-worktree root must be a non-empty path.',
        this.settingsPath,
      )
    }
    if (input.includes('\0')) {
      throw new WorktreeSettingsError(
        'WORKTREE_SETTINGS_INVALID',
        'Managed-worktree root contains an invalid NUL character.',
        this.settingsPath,
      )
    }
    const expanded = expandHome(input.trim())
    if (!isAbsolute(expanded)) {
      throw new WorktreeSettingsError(
        'WORKTREE_SETTINGS_INVALID',
        'Managed-worktree root must be an absolute path or begin with ~/.',
        this.settingsPath,
      )
    }
    const canonical = canonicalPath(expanded)
    if (canonical === currentRoot) return currentRoot

    // The default root is intentionally inside Kata config storage and is the
    // only protected root permitted by policy.
    if (canonical !== this.defaultRoot) {
      for (const protectedPath of this.protectedPaths) {
        if (pathOverlaps(canonical, protectedPath)) {
          throw new WorktreeSettingsError(
            'WORKTREE_SETTINGS_PROTECTED_PATH',
            `Managed-worktree root overlaps protected server storage: ${canonical}`,
            this.settingsPath,
          )
        }
      }
    }
    return canonical
  }

  private validateAgainstRegistry(candidateRoot: string): void {
    let records: ManagedWorktreeRecordVersioned[]
    try {
      records = this.registry.list()
    } catch (error) {
      throw new WorktreeSettingsError(
        'WORKTREE_SETTINGS_CONFLICT',
        'Unable to validate the root against the authoritative worktree registry.',
        this.settingsPath,
        error,
      )
    }
    for (const record of records) {
      if (pathOverlaps(candidateRoot, canonicalPath(record.repositoryRoot))) {
        throw new WorktreeSettingsError(
          'WORKTREE_SETTINGS_REPOSITORY_OVERLAP',
          `Managed-worktree root overlaps a registered repository: ${record.repositoryRoot}`,
          this.settingsPath,
        )
      }
      if (pathOverlaps(candidateRoot, canonicalPath(record.checkoutPath))) {
        throw new WorktreeSettingsError(
          'WORKTREE_SETTINGS_CHECKOUT_OVERLAP',
          `Managed-worktree root overlaps a registered checkout: ${record.checkoutPath}`,
          this.settingsPath,
        )
      }
    }
  }

  private ensureRootUsable(root: string, allowProtected = false): void {
    const canonical = canonicalPath(root)
    if (!allowProtected && canonical !== this.defaultRoot) {
      for (const protectedPath of this.protectedPaths) {
        if (pathOverlaps(canonical, protectedPath)) {
          throw new WorktreeSettingsError(
            'WORKTREE_SETTINGS_PROTECTED_PATH',
            `Managed-worktree root overlaps protected server storage: ${canonical}`,
            this.settingsPath,
          )
        }
      }
    }
    try {
      mkdirSync(root, { recursive: true })
      const actual = realpathSync(root)
      const probe = join(actual, `.kata-worktree-write-${process.pid}-${randomBytes(6).toString('hex')}`)
      const fd = openSync(probe, 'wx', 0o600)
      try {
        writeFileSync(fd, 'ok', 'utf8')
        try {
          fsyncSync(fd)
        } catch {
          /* best effort */
        }
      } finally {
        closeSync(fd)
        rmSync(probe, { force: true })
      }
      // A symlinked root is valid only when its canonical destination passed
      // all overlap checks above.
      void statSync(actual)
    } catch (error) {
      throw new WorktreeSettingsError(
        'WORKTREE_SETTINGS_UNWRITABLE',
        `Managed-worktree root is not writable or cannot be created: ${root}`,
        this.settingsPath,
        error,
      )
    }
  }

  private wrapLockError(error: unknown): WorktreeSettingsError {
    if (error instanceof WorktreeSettingsError) return error
    return new WorktreeSettingsError(
      'WORKTREE_SETTINGS_LOCK_FAILED',
      'Unable to acquire the managed-worktree settings lock.',
      this.settingsPath,
      error,
    )
  }
}

export const DEFAULT_WORKTREE_SETTINGS_FILE = DEFAULT_SETTINGS_FILE
