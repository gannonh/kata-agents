/**
 * Fixed-path managed-worktree registry.
 *
 * The registry is an authority owned by the server config directory, not a
 * cache that can be repaired by throwing data away.  Reads validate the
 * complete wrapper and record shape, V1 is upgraded to V2 in place, and every
 * read-modify-write is protected by a cross-process lock.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  openSync,
  closeSync,
  fsyncSync,
} from 'node:fs'
import { dirname, join, relative, resolve as resolvePath, isAbsolute } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import type {
  ManagedWorktreeRecord,
  ManagedWorktreeRecordV2,
  ManagedWorktreeRecordVersioned,
  ManagedWorktreeSnapshotMeta,
  ManagedWorktreeState,
  WorktreeCleanupResult,
} from '@kata-sh/shared/protocol'
import { CrossProcessFileLock, type CrossProcessLockOptions } from './mutation-lock'

/** First 16 lowercase hex chars of SHA-256 over the normalized common-dir path. */
export function computeRepoKey(normalizedGitCommonDir: string): string {
  return createHash('sha256').update(normalizedGitCommonDir).digest('hex').slice(0, 16)
}

/** Eight lowercase hex chars from a cryptographically secure random source. */
export function generateToken(): string {
  return randomBytes(4).toString('hex')
}

export const WORKTREE_REGISTRY_VERSION = 2 as const

export type WorktreeRegistryErrorCode =
  | 'REGISTRY_READ_FAILED'
  | 'REGISTRY_SOURCE_MISSING'
  | 'REGISTRY_CORRUPT'
  | 'REGISTRY_UNSUPPORTED_SCHEMA'
  | 'REGISTRY_INVALID_RECORD'
  | 'REGISTRY_CONFLICT'
  | 'REGISTRY_LOCK_FAILED'
  | 'REGISTRY_WRITE_FAILED'

/** Typed, fail-closed registry failure. */
export class WorktreeRegistryError extends Error {
  readonly code: WorktreeRegistryErrorCode
  readonly registryPath: string
  readonly cause?: unknown

  constructor(
    code: WorktreeRegistryErrorCode,
    message: string,
    registryPath: string,
    cause?: unknown,
  ) {
    super(message)
    this.name = 'WorktreeRegistryError'
    this.code = code
    this.registryPath = registryPath
    this.cause = cause
  }
}

interface RegistryFileV1 {
  version: 1
  records: ManagedWorktreeRecordVersioned[]
}

interface RegistryFileV2 {
  version: 2
  records: ManagedWorktreeRecordV2[]
}

type RegistryFile = RegistryFileV1 | RegistryFileV2

interface RegistryMarker {
  schemaVersion: 1
  status: 'prepared' | 'complete'
  sourceVersion: 1
  sourceHash: string
  backupHash: string
  registryHash: string
  completedAt?: number
}

export interface WorktreeRegistryUpgradeEvidence {
  status: 'prepared' | 'complete'
  sourceVersion: 1
  sourceHash: string
  backupHash: string
  registryHash: string
  backupPath: string
  markerPath: string
  completedAt?: number
}

/** Stable sidecar names used for upgrade recovery and tests. */
export function getWorktreeRegistryEvidencePaths(registryPath: string): {
  lockPath: string
  backupPath: string
  markerPath: string
} {
  const fixed = resolvePath(registryPath)
  return {
    lockPath: `${fixed}.lock`,
    backupPath: `${fixed}.backup`,
    markerPath: `${fixed}.upgrade.json`,
  }
}

/** Alias with a shorter name for callers that need to inspect evidence. */
export const worktreeRegistryEvidencePaths = getWorktreeRegistryEvidencePaths

/** Optional deterministic race hooks used by filesystem/concurrency tests. */
export interface WorktreeRegistryHooks {
  beforePersist?: () => void
  beforeReplace?: () => void
  /** Fired after the pre-publish CAS check and immediately before the atomic replace. */
  beforePublish?: () => void
}

const VALID_STATES = new Set<ManagedWorktreeState>([
  'preparing',
  'ready',
  'missing',
  'removing',
  'blocked',
  'snapshotting',
  'snapshotted',
  'restoring',
  'cleanup-failed',
  'restore-failed',
  'unowned',
])
const HEX16 = /^[0-9a-f]{16}$/
const HEX8 = /^[0-9a-f]{8}$/

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function statFingerprint(path: string): string {
  const stat = statSync(path)
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function cloneRecord(record: ManagedWorktreeRecordV2): ManagedWorktreeRecordV2 {
  return {
    ...record,
    ownerSessionIds: [...record.ownerSessionIds],
  }
}

function cloneRecords(records: Iterable<ManagedWorktreeRecordV2>): ManagedWorktreeRecordV2[] {
  return Array.from(records, cloneRecord)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(
  value: unknown,
  field: string,
  registryPath: string,
  options: { absolute?: boolean } = {},
): string {
  if (typeof value !== 'string' || value.length === 0 || (options.absolute && !isAbsolute(value))) {
    throw new WorktreeRegistryError(
      'REGISTRY_INVALID_RECORD',
      `Registry field ${field} must be a non-empty${options.absolute ? ' absolute' : ''} string.`,
      registryPath,
    )
  }
  return value
}

function requireFiniteNumber(value: unknown, field: string, registryPath: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new WorktreeRegistryError(
      'REGISTRY_INVALID_RECORD',
      `Registry field ${field} must be a finite number.`,
      registryPath,
    )
  }
  return value
}

function validateBranch(branch: unknown, registryPath: string): string {
  // V1 records historically accepted any Git branch name. Keep that valid
  // registry behavior; V1-created managed records use kata-agent/<suffix>, and
  // the upgrade derives their display name from that prefix.
  return requireString(branch, 'expectedBranch', registryPath)
}

function validateOwners(value: unknown, registryPath: string): string[] {
  if (!Array.isArray(value) || value.some((owner) => typeof owner !== 'string' || owner.length === 0)) {
    throw new WorktreeRegistryError(
      'REGISTRY_INVALID_RECORD',
      'Registry ownerSessionIds must be an array of non-empty strings.',
      registryPath,
    )
  }
  const owners = value as string[]
  if (new Set(owners).size !== owners.length) {
    throw new WorktreeRegistryError(
      'REGISTRY_INVALID_RECORD',
      'Registry ownerSessionIds must not contain duplicates.',
      registryPath,
    )
  }
  return [...owners]
}

function validateBaseRef(value: unknown, registryPath: string): string | null {
  if (value !== null && (typeof value !== 'string' || value.length === 0)) {
    throw new WorktreeRegistryError(
      'REGISTRY_INVALID_RECORD',
      'Registry baseRef must be a non-empty string or null.',
      registryPath,
    )
  }
  return value as string | null
}

function validateCommonRecord(value: unknown, registryPath: string): ManagedWorktreeRecord {
  if (!isObject(value)) {
    throw new WorktreeRegistryError('REGISTRY_INVALID_RECORD', 'Registry record must be an object.', registryPath)
  }
  const state = value.state
  if (typeof state !== 'string' || !VALID_STATES.has(state as ManagedWorktreeState)) {
    throw new WorktreeRegistryError('REGISTRY_INVALID_RECORD', 'Registry record has an invalid state.', registryPath)
  }
  const record: ManagedWorktreeRecord = {
    managedWorktreeId: requireString(value.managedWorktreeId, 'managedWorktreeId', registryPath),
    repositoryRoot: requireString(value.repositoryRoot, 'repositoryRoot', registryPath, { absolute: true }),
    gitCommonDir: requireString(value.gitCommonDir, 'gitCommonDir', registryPath, { absolute: true }),
    checkoutPath: requireString(value.checkoutPath, 'checkoutPath', registryPath, { absolute: true }),
    baseRef: validateBaseRef(value.baseRef, registryPath),
    expectedBranch: validateBranch(value.expectedBranch, registryPath),
    createdAt: requireFiniteNumber(value.createdAt, 'createdAt', registryPath),
    ownerSessionIds: validateOwners(value.ownerSessionIds, registryPath),
    state: state as ManagedWorktreeState,
  }
  if ('workspaceId' in value && value.workspaceId !== undefined) {
    record.workspaceId = requireString(value.workspaceId, 'workspaceId', registryPath)
  }
  if ('schemaVersion' in value && value.schemaVersion !== undefined && value.schemaVersion !== 1) {
    throw new WorktreeRegistryError(
      'REGISTRY_UNSUPPORTED_SCHEMA',
      'A version-1 registry record must have schemaVersion 1 when present.',
      registryPath,
    )
  }
  return record
}

function isHexOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40,64}$/.test(value)
}

function validateSnapshotMeta(value: unknown, registryPath: string): ManagedWorktreeSnapshotMeta {
  if (!isObject(value)) {
    throw new WorktreeRegistryError('REGISTRY_INVALID_RECORD', 'Registry snapshot metadata must be an object.', registryPath)
  }
  const snapshotId = requireString(value.snapshotId, 'snapshot.snapshotId', registryPath)
  const schemaVersion = value.schemaVersion
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new WorktreeRegistryError('REGISTRY_INVALID_RECORD', 'Registry snapshot schemaVersion must be a positive integer.', registryPath)
  }
  const hiddenRef = requireString(value.hiddenRef, 'snapshot.hiddenRef', registryPath)
  if (hiddenRef !== `refs/kata/worktree-snapshots/${snapshotId}`) {
    throw new WorktreeRegistryError('REGISTRY_INVALID_RECORD', 'Registry snapshot hiddenRef must match its snapshot ID.', registryPath)
  }
  const headOid = value.headOid
  if (!isHexOid(headOid)) {
    throw new WorktreeRegistryError('REGISTRY_INVALID_RECORD', 'Registry snapshot headOid must be a hex object ID.', registryPath)
  }
  const manifestHash = value.manifestHash
  if (!isSha256(manifestHash)) {
    throw new WorktreeRegistryError('REGISTRY_INVALID_RECORD', 'Registry snapshot manifestHash must be a SHA-256 hex digest.', registryPath)
  }
  const fileCount = value.fileCount
  if (typeof fileCount !== 'number' || !Number.isInteger(fileCount) || fileCount < 0) {
    throw new WorktreeRegistryError('REGISTRY_INVALID_RECORD', 'Registry snapshot fileCount must be a non-negative integer.', registryPath)
  }
  const totalBytes = value.totalBytes
  if (typeof totalBytes !== 'number' || !Number.isFinite(totalBytes) || totalBytes < 0) {
    throw new WorktreeRegistryError('REGISTRY_INVALID_RECORD', 'Registry snapshot totalBytes must be a non-negative number.', registryPath)
  }
  return {
    snapshotId,
    schemaVersion,
    hiddenRef,
    headOid,
    branch: requireString(value.branch, 'snapshot.branch', registryPath),
    manifestHash,
    payloadPath: requireString(value.payloadPath, 'snapshot.payloadPath', registryPath, { absolute: true }),
    createdAt: requireFiniteNumber(value.createdAt, 'snapshot.createdAt', registryPath),
    fileCount,
    totalBytes,
    fingerprint: requireString(value.fingerprint, 'snapshot.fingerprint', registryPath),
    policyVersion: requireFiniteNumber(value.policyVersion, 'snapshot.policyVersion', registryPath),
    previewFingerprint: requireString(value.previewFingerprint, 'snapshot.previewFingerprint', registryPath),
  }
}

const CLEANUP_OUTCOMES = new Set(['succeeded', 'blocked', 'failed', 'skipped'])

function validateCleanupResult(value: unknown, registryPath: string): WorktreeCleanupResult {
  if (!isObject(value)) {
    throw new WorktreeRegistryError('REGISTRY_INVALID_RECORD', 'Registry cleanup result must be an object.', registryPath)
  }
  const outcome = value.outcome
  if (typeof outcome !== 'string' || !CLEANUP_OUTCOMES.has(outcome)) {
    throw new WorktreeRegistryError('REGISTRY_INVALID_RECORD', 'Registry cleanup result has an invalid outcome.', registryPath)
  }
  const result: WorktreeCleanupResult = {
    at: requireFiniteNumber(value.at, 'cleanup.at', registryPath),
    outcome: outcome as WorktreeCleanupResult['outcome'],
    policyVersion: requireFiniteNumber(value.policyVersion, 'cleanup.policyVersion', registryPath),
  }
  if (value.removedWorktreeId !== undefined) {
    result.removedWorktreeId = requireString(value.removedWorktreeId, 'cleanup.removedWorktreeId', registryPath)
  }
  if (value.reason !== undefined) {
    result.reason = requireString(value.reason, 'cleanup.reason', registryPath)
  }
  return result
}

function validateV2Record(value: unknown, registryPath: string): ManagedWorktreeRecordV2 {
  if (!isObject(value)) {
    throw new WorktreeRegistryError('REGISTRY_INVALID_RECORD', 'Registry record must be an object.', registryPath)
  }
  if (value.schemaVersion !== 2) {
    throw new WorktreeRegistryError(
      'REGISTRY_UNSUPPORTED_SCHEMA',
      'A version-2 registry wrapper requires version-2 records.',
      registryPath,
    )
  }
  const base = validateCommonRecord({ ...value, schemaVersion: undefined }, registryPath)
  const record: ManagedWorktreeRecordV2 = {
    ...base,
    schemaVersion: 2,
    workspaceId: requireString(value.workspaceId, 'workspaceId', registryPath),
    displayName: requireString(value.displayName, 'displayName', registryPath),
    materializationRoot: requireString(value.materializationRoot, 'materializationRoot', registryPath, {
      absolute: true,
    }),
    lastUsedAt: requireFiniteNumber(value.lastUsedAt, 'lastUsedAt', registryPath),
  }
  if (value.snapshot !== undefined) {
    record.snapshot = validateSnapshotMeta(value.snapshot, registryPath)
  }
  if (value.policyVersion !== undefined) {
    const policyVersion = value.policyVersion
    if (typeof policyVersion !== 'number' || !Number.isInteger(policyVersion) || policyVersion < 0) {
      throw new WorktreeRegistryError('REGISTRY_INVALID_RECORD', 'Registry policyVersion must be a non-negative integer.', registryPath)
    }
    record.policyVersion = policyVersion
  }
  if (value.archivedOwnerSessionIds !== undefined) {
    record.archivedOwnerSessionIds = validateOwners(value.archivedOwnerSessionIds, registryPath)
  }
  if (value.lastCleanupResult !== undefined) {
    record.lastCleanupResult = validateCleanupResult(value.lastCleanupResult, registryPath)
  }
  if (value.lastError !== undefined) {
    record.lastError = requireString(value.lastError, 'lastError', registryPath)
  }
  if (value.stateChangedAt !== undefined) {
    record.stateChangedAt = requireFiniteNumber(value.stateChangedAt, 'stateChangedAt', registryPath)
  }
  return record
}

function parseRegistry(raw: string, registryPath: string): RegistryFile {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new WorktreeRegistryError(
      'REGISTRY_CORRUPT',
      'The managed-worktree registry is not valid JSON.',
      registryPath,
      error,
    )
  }
  if (!isObject(value) || (value.version !== 1 && value.version !== 2)) {
    throw new WorktreeRegistryError(
      'REGISTRY_UNSUPPORTED_SCHEMA',
      'The managed-worktree registry wrapper version is unsupported.',
      registryPath,
    )
  }
  if (!Array.isArray(value.records)) {
    throw new WorktreeRegistryError(
      'REGISTRY_INVALID_RECORD',
      'The managed-worktree registry records field must be an array.',
      registryPath,
    )
  }

  const records = value.version === 1
    ? value.records.map((record) => (
        isObject(record) && record.schemaVersion === 2
          ? validateV2Record(record, registryPath)
          : validateCommonRecord(record, registryPath)
      ))
    : value.records.map((record) => validateV2Record(record, registryPath))
  const ids = new Set<string>()
  for (const record of records) {
    if (ids.has(record.managedWorktreeId)) {
      throw new WorktreeRegistryError(
        'REGISTRY_INVALID_RECORD',
        `The managed-worktree registry contains duplicate ID ${record.managedWorktreeId}.`,
        registryPath,
      )
    }
    ids.add(record.managedWorktreeId)
  }

  return value.version === 1
    ? { version: 1, records: records as ManagedWorktreeRecordVersioned[] }
    : { version: 2, records: records as ManagedWorktreeRecordV2[] }
}

function encodeRegistry(records: Iterable<ManagedWorktreeRecordV2>): string {
  return JSON.stringify({ version: WORKTREE_REGISTRY_VERSION, records: cloneRecords(records) }, null, 2) + '\n'
}

function splitPathSegments(path: string): string[] {
  return resolvePath(path).split(/[\\/]+/).filter(Boolean)
}

function looksLikeLegacyLayout(parts: string[]): boolean {
  return parts.length >= 3 && HEX16.test(parts[parts.length - 2]!) && HEX8.test(parts[parts.length - 1]!)
}

/**
 * Derive the V1 root and workspace from the recorded checkout layout.  The
 * normal V1 layout is `<registry-dir>/<workspace>/<repo-key>/<token>`; the
 * suffix-based fallback also handles a registry moved next to an existing
 * default-root checkout without rewriting that checkout path.
 */
function deriveLegacyLayout(
  record: ManagedWorktreeRecord,
  registryPath: string,
): { workspaceId: string; materializationRoot: string } {
  const checkout = resolvePath(record.checkoutPath)
  const defaultRoot = resolvePath(dirname(registryPath))
  const relativeToDefault = relative(defaultRoot, checkout)
  const relativeParts = relativeToDefault === '' ? [] : relativeToDefault.split(/[\\/]+/).filter(Boolean)

  let workspaceId = record.workspaceId
  let materializationRoot = defaultRoot
  if (!workspaceId && relativeParts.length >= 3 && looksLikeLegacyLayout(relativeParts)) {
    workspaceId = relativeParts[0]
  }

  if (workspaceId) {
    const checkoutParts = splitPathSegments(checkout)
    // Workspace IDs are logical path segments, not filesystem paths. Resolving
    // a relative ID against cwd would prepend the process directory and make
    // custom-root legacy layouts fall back to the fixed registry directory.
    const wsParts = workspaceId.split(/[\\/]+/).filter(Boolean)
    const suffix = [...wsParts, checkoutParts.at(-2) ?? '', checkoutParts.at(-1) ?? '']
    const suffixMatches = suffix.length <= checkoutParts.length && suffix.every(
      (part, index) => checkoutParts[checkoutParts.length - suffix.length + index] === part,
    )
    if (suffixMatches && looksLikeLegacyLayout(checkoutParts)) {
      let candidateRoot = checkout
      for (let index = 0; index < suffix.length; index += 1) {
        candidateRoot = dirname(candidateRoot)
      }
      materializationRoot = resolvePath(candidateRoot)
    } else if (relativeParts.length >= 3 && relativeParts[0] === workspaceId && looksLikeLegacyLayout(relativeParts)) {
      materializationRoot = defaultRoot
    }
  }

  if (!workspaceId || workspaceId.length === 0) {
    // `workspaceId` was optional in the original V1 record. A hand-authored
    // or very old record may not retain the standard materialization layout;
    // keep it recoverable under the fixed default root rather than dropping a
    // valid V1 record during migration.
    workspaceId = 'legacy'
  }
  return { workspaceId, materializationRoot }
}

function upgradeRecord(record: ManagedWorktreeRecord, registryPath: string): ManagedWorktreeRecordV2 {
  const { workspaceId, materializationRoot } = deriveLegacyLayout(record, registryPath)
  return {
    ...record,
    schemaVersion: 2,
    workspaceId,
    displayName: record.expectedBranch.startsWith('kata-agent/')
      ? record.expectedBranch.slice('kata-agent/'.length)
      : record.expectedBranch,
    materializationRoot,
    lastUsedAt: record.createdAt,
    ownerSessionIds: [...record.ownerSessionIds],
  }
}

function wrapError(
  error: unknown,
  code: WorktreeRegistryErrorCode,
  message: string,
  registryPath: string,
): WorktreeRegistryError {
  if (error instanceof WorktreeRegistryError) return error
  return new WorktreeRegistryError(code, message, registryPath, error)
}

const AT_FDCWD = -100
const RENAME_EXCHANGE = 2
const RENAME_SWAP = 2

function cstr(value: string): Buffer {
  return Buffer.from(`${value}\0`)
}

function tryExchangePaths(left: string, right: string): boolean {
  try {
    if (process.platform === 'linux') {
      const { dlopen, FFIType, suffix, ptr } = require('bun:ffi') as typeof import('bun:ffi')
      const lib = dlopen(`libc.${suffix}`, {
        renameat2: {
          args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring, FFIType.u64],
          returns: FFIType.i32,
        },
      })
      const leftBuf = cstr(left)
      const rightBuf = cstr(right)
      return lib.symbols.renameat2(AT_FDCWD, ptr(leftBuf), AT_FDCWD, ptr(rightBuf), BigInt(RENAME_EXCHANGE)) === 0
    }
    if (process.platform === 'darwin') {
      const { dlopen, FFIType, suffix, ptr } = require('bun:ffi') as typeof import('bun:ffi')
      const lib = dlopen(`libc.${suffix}`, {
        renamex_np: {
          args: [FFIType.cstring, FFIType.cstring, FFIType.u32],
          returns: FFIType.i32,
        },
      })
      const leftBuf = cstr(left)
      const rightBuf = cstr(right)
      return lib.symbols.renamex_np(ptr(leftBuf), ptr(rightBuf), RENAME_SWAP) === 0
    }
  } catch {
    return false
  }
  return false
}

function writeBytesAtomically(
  path: string,
  bytes: string | Buffer,
  beforeRename?: () => void,
  expected?: { exists: boolean; hash: string },
): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`
  const claimPath = `${path}.publish.json`
  const writerToken = randomBytes(8).toString('hex')
  try {
    const fd = openSync(tmp, 'wx', 0o600)
    try {
      writeFileSync(fd, bytes)
      try {
        fsyncSync(fd)
      } catch {
        // Some filesystems do not expose fsync for temporary files; rename is
        // still atomic and the source remains untouched.
      }
    } finally {
      closeSync(fd)
    }
    writeFileSync(claimPath, JSON.stringify({
      status: 'prepared',
      expectedSourceHash: expected?.hash ?? null,
      expectedExists: expected?.exists ?? null,
      targetHash: sha256(bytes),
      writerToken,
    }))
    beforeRename?.()
    if (expected?.exists) {
      if (!tryExchangePaths(tmp, path)) {
        const latest = existsSync(path) ? sha256(readFileSync(path)) : null
        if (latest !== expected.hash) {
          throw new WorktreeRegistryError(
            'REGISTRY_CONFLICT',
            'The registry source changed during mutation; source bytes were preserved.',
            path,
          )
        }
        renameSync(tmp, path)
      } else {
        const swappedAside = existsSync(tmp) ? sha256(readFileSync(tmp)) : null
        if (swappedAside !== expected.hash) {
          tryExchangePaths(tmp, path)
          throw new WorktreeRegistryError(
            'REGISTRY_CONFLICT',
            'The registry source changed during mutation; source bytes were preserved.',
            path,
          )
        }
        rmSync(tmp, { force: true })
      }
    } else if (expected) {
      if (existsSync(path)) {
        throw new WorktreeRegistryError(
          'REGISTRY_CONFLICT',
          'The registry source changed before the mutation could be committed.',
          path,
        )
      }
      renameSync(tmp, path)
    } else {
      renameSync(tmp, path)
    }
    rmSync(claimPath, { force: true })
  } catch (error) {
    try {
      // After a successful exchange, tmp may hold the previous registry.
      // Delete it only when it still contains the unpublished payload.
      const unpublished = existsSync(tmp) && sha256(readFileSync(tmp)) === sha256(bytes)
      if (unpublished) rmSync(tmp, { force: true })
    } catch {
      /* preserve tmp if we cannot prove it is unpublished payload */
    }
    try {
      rmSync(claimPath, { force: true })
    } catch {
      /* preserve the original error */
    }
    throw error
  }
}

export type WorktreeOwnerBindResult =
  | { status: 'added' }
  | { status: 'already-owned' }
  | { status: 'missing' }
  | { status: 'not-ready'; state: ManagedWorktreeState }

/**
 * Read/commit surface inside {@link WorktreeRegistry.runExclusive}. Mutations
 * are applied to the in-memory record map; only `commit()` persists them.
 */
export interface WorktreeRegistryTransaction {
  get(id: string): ManagedWorktreeRecordV2 | undefined
  list(): ManagedWorktreeRecordV2[]
  /** Atomically persist the current in-memory records under the held lock. */
  commit(): void
}

export type WorktreeRemovalBeginResult =
  | { status: 'started' }
  | { status: 'missing' }
  | { status: 'not-owner' }
  | { status: 'other-owner' }
  | { status: 'not-ready'; state: ManagedWorktreeState }

export class WorktreeRegistry {
  private readonly registryPath: string
  private readonly evidencePaths: ReturnType<typeof getWorktreeRegistryEvidencePaths>
  private readonly lock: CrossProcessFileLock
  private readonly hooks: WorktreeRegistryHooks
  private cache = new Map<string, ManagedWorktreeRecordV2>()
  private sourceState: 'unknown' | 'absent' | 'present' = 'unknown'

  constructor(
    registryPath: string,
    lockOptions?: CrossProcessLockOptions,
    hooks: WorktreeRegistryHooks = {},
  ) {
    this.registryPath = resolvePath(registryPath)
    this.evidencePaths = getWorktreeRegistryEvidencePaths(this.registryPath)
    this.lock = new CrossProcessFileLock(this.evidencePaths.lockPath, lockOptions)
    this.hooks = hooks
  }

  getRegistryPath(): string {
    return this.registryPath
  }

  getEvidencePaths(): ReturnType<typeof getWorktreeRegistryEvidencePaths> {
    return { ...this.evidencePaths }
  }

  /** Return the last persisted upgrade marker, if one exists and is valid. */
  getUpgradeEvidence(): WorktreeRegistryUpgradeEvidence | null {
    let marker: Partial<RegistryMarker>
    try {
      marker = JSON.parse(readFileSync(this.evidencePaths.markerPath, 'utf8')) as Partial<RegistryMarker>
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new WorktreeRegistryError(
        'REGISTRY_CORRUPT',
        'Managed-worktree registry upgrade evidence is unreadable or invalid JSON.',
        this.registryPath,
        error,
      )
    }
    if (
      marker.schemaVersion !== 1 ||
      (marker.status !== 'prepared' && marker.status !== 'complete') ||
      marker.sourceVersion !== 1 ||
      !isSha256(marker.sourceHash) ||
      !isSha256(marker.backupHash) ||
      !isSha256(marker.registryHash) ||
      (marker.completedAt !== undefined && !Number.isFinite(marker.completedAt))
    ) {
      throw new WorktreeRegistryError(
        'REGISTRY_CORRUPT',
        'Managed-worktree registry upgrade evidence has an invalid shape.',
        this.registryPath,
      )
    }
    return {
      status: marker.status,
      sourceVersion: 1,
      sourceHash: marker.sourceHash,
      backupHash: marker.backupHash,
      registryHash: marker.registryHash,
      backupPath: this.evidencePaths.backupPath,
      markerPath: this.evidencePaths.markerPath,
      completedAt: marker.completedAt,
    }
  }

  /** Stable alias for callers/tests that inspect migration evidence. */
  getEvidence(): WorktreeRegistryUpgradeEvidence | null {
    return this.getUpgradeEvidence()
  }

  private readSource(): {
    exists: boolean
    raw: string
    bytes: Buffer
    hash: string
    identity: string | null
  } {
    try {
      const bytes = readFileSync(this.registryPath)
      return {
        exists: true,
        raw: bytes.toString('utf8'),
        bytes,
        hash: sha256(bytes),
        identity: statFingerprint(this.registryPath),
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          exists: false,
          raw: '',
          bytes: Buffer.alloc(0),
          hash: sha256(Buffer.alloc(0)),
          identity: null,
        }
      }
      throw wrapError(
        error,
        'REGISTRY_READ_FAILED',
        'Unable to read the managed-worktree registry.',
        this.registryPath,
      )
    }
  }

  private recoverMissingSourceLocked(): void {
    if (this.sourceState === 'present') {
      throw new WorktreeRegistryError(
        'REGISTRY_SOURCE_MISSING',
        'The managed-worktree registry disappeared after it was loaded; refusing to use stale cache data.',
        this.registryPath,
      )
    }
    const backupExists = existsSync(this.evidencePaths.backupPath)
    const evidence = this.getUpgradeEvidence()
    if (!backupExists && !evidence) return
    if (!backupExists) {
      throw new WorktreeRegistryError(
        'REGISTRY_SOURCE_MISSING',
        'The registry is missing while upgrade evidence has no recoverable source backup.',
        this.registryPath,
      )
    }
    let backupBytes: Buffer
    try {
      backupBytes = readFileSync(this.evidencePaths.backupPath)
    } catch (error) {
      throw wrapError(
        error,
        'REGISTRY_READ_FAILED',
        'The recoverable managed-worktree registry backup cannot be read.',
        this.registryPath,
      )
    }
    const backupHash = sha256(backupBytes)
    const backup = backupBytes.toString('utf8')
    if (evidence && (evidence.backupHash !== backupHash || evidence.sourceHash !== backupHash)) {
      throw new WorktreeRegistryError(
        'REGISTRY_CONFLICT',
        'The recoverable registry backup conflicts with its recorded source hash.',
        this.registryPath,
      )
    }
    // Validate before restoring so an arbitrary sidecar cannot turn into a
    // newly-authoritative empty or malformed registry. A completed marker also
    // binds the backup-derived V2 bytes: if later V2 mutations advanced the
    // marker, restoring this older V1 backup would silently lose records.
    const parsedBackup = parseRegistry(backup, this.registryPath)
    if (evidence?.status === 'complete') {
      if (parsedBackup.version !== 1) {
        throw new WorktreeRegistryError(
          'REGISTRY_CONFLICT',
          'Completed registry upgrade evidence does not reference a V1 source backup.',
          this.registryPath,
        )
      }
      if (parsedBackup.records.some((record) => record.schemaVersion === 2)) {
        throw new WorktreeRegistryError(
          'REGISTRY_CONFLICT',
          'Completed registry upgrade evidence does not reference a pure V1 source backup.',
          this.registryPath,
        )
      }
      const backupUpgradeHash = sha256(
        encodeRegistry((parsedBackup.records as ManagedWorktreeRecord[]).map(
          (record) => upgradeRecord(record, this.registryPath),
        )),
      )
      if (backupUpgradeHash !== evidence.registryHash) {
        throw new WorktreeRegistryError(
          'REGISTRY_CONFLICT',
          'The registry backup-derived upgrade conflicts with the last completed registry hash.',
          this.registryPath,
        )
      }
    }
    try {
      writeBytesAtomically(this.registryPath, backupBytes)
    } catch (error) {
      throw wrapError(
        error,
        'REGISTRY_WRITE_FAILED',
        'Unable to restore the managed-worktree registry from its source backup.',
        this.registryPath,
      )
    }
  }

  private writeMarker(marker: RegistryMarker): void {
    try {
      writeBytesAtomically(this.evidencePaths.markerPath, JSON.stringify(marker, null, 2) + '\n')
    } catch (error) {
      throw wrapError(
        error,
        'REGISTRY_WRITE_FAILED',
        'Unable to persist managed-worktree registry completion evidence.',
        this.registryPath,
      )
    }
  }

  private prepareBackup(sourceRaw: string | Buffer, sourceHash: string): string {
    const backupHash = sha256(sourceRaw)
    if (backupHash !== sourceHash) {
      throw new WorktreeRegistryError(
        'REGISTRY_CONFLICT',
        'The registry source changed while preparing its recoverable backup.',
        this.registryPath,
      )
    }
    try {
      writeBytesAtomically(this.evidencePaths.backupPath, sourceRaw)
      const written = readFileSync(this.evidencePaths.backupPath)
      if (sha256(written) !== sourceHash) {
        throw new WorktreeRegistryError(
          'REGISTRY_CONFLICT',
          'The registry backup hash does not match the source bytes.',
          this.registryPath,
        )
      }
      return sourceHash
    } catch (error) {
      if (error instanceof WorktreeRegistryError) throw error
      throw wrapError(
        error,
        'REGISTRY_WRITE_FAILED',
        'Unable to preserve a recoverable registry source backup.',
        this.registryPath,
      )
    }
  }

  private upgradeLocked(
    source: { raw: string; bytes: Buffer; hash: string; identity: string | null },
    parsed: RegistryFile,
  ): ManagedWorktreeRecordV2[] {
    const priorEvidence = this.getUpgradeEvidence()
    let priorBackupBytes: Buffer | null = null
    if (priorEvidence) {
      if (!existsSync(this.evidencePaths.backupPath)) {
        throw new WorktreeRegistryError(
          'REGISTRY_SOURCE_MISSING',
          'Managed-worktree registry upgrade evidence has no recoverable source backup.',
          this.registryPath,
        )
      }
      let backupHash: string
      try {
        priorBackupBytes = readFileSync(this.evidencePaths.backupPath)
        backupHash = sha256(priorBackupBytes)
      } catch (error) {
        throw wrapError(
          error,
          'REGISTRY_READ_FAILED',
          'Managed-worktree registry upgrade backup cannot be read.',
          this.registryPath,
        )
      }
      if (
        backupHash !== priorEvidence.backupHash ||
        backupHash !== priorEvidence.sourceHash
      ) {
        throw new WorktreeRegistryError(
          'REGISTRY_CONFLICT',
          'Managed-worktree registry upgrade backup hash conflicts with its source evidence.',
          this.registryPath,
        )
      }
    }
    if (parsed.version !== 1) {
      if (priorEvidence?.status === 'complete' && priorEvidence.registryHash !== source.hash) {
        throw new WorktreeRegistryError(
          'REGISTRY_CONFLICT',
          'Completed registry upgrade evidence does not match the current V2 source.',
          this.registryPath,
        )
      }
      // A process may have crashed after atomically replacing the registry but
      // before publishing completion evidence. Finish the marker without
      // rewriting valid V2 registry bytes.
      if (priorEvidence?.status === 'prepared') {
        if (priorEvidence.registryHash !== source.hash) {
          throw new WorktreeRegistryError(
            'REGISTRY_CONFLICT',
            'Prepared registry upgrade evidence does not match the current source.',
            this.registryPath,
          )
        }
        this.writeMarker({
          schemaVersion: 1,
          status: 'complete',
          sourceVersion: 1,
          sourceHash: priorEvidence.sourceHash,
          backupHash: priorEvidence.backupHash,
          registryHash: source.hash,
          completedAt: priorEvidence.completedAt ?? Date.now(),
        })
      }
      return cloneRecords(parsed.records)
    }

    // A pre-V2 process can read V2 records, preserve their unknown fields, and
    // write them back beneath its hard-coded V1 wrapper. Recognize only the
    // observed unambiguous shape: a completed prior upgrade followed by a
    // wrapper-only downgrade of entirely valid V2 records. Mixed records or a
    // missing evidence chain remain conflicts rather than guessed migrations.
    const containsV2Records = parsed.records.some((record) => record.schemaVersion === 2)
    const hasLegacyRewriteEvidence = priorEvidence?.status === 'complete' ||
      (priorEvidence?.status === 'prepared' && priorEvidence.completedAt !== undefined)
    const legacyRewrite = hasLegacyRewriteEvidence &&
      parsed.records.length > 0 &&
      parsed.records.every((record) => record.schemaVersion === 2)
    if (containsV2Records && !legacyRewrite) {
      throw new WorktreeRegistryError(
        'REGISTRY_CONFLICT',
        'A V1 registry wrapper contains V2 records without an unambiguous completed upgrade lineage.',
        this.registryPath,
      )
    }
    if (legacyRewrite) {
      const priorBackup = parseRegistry(priorBackupBytes!.toString('utf8'), this.evidencePaths.backupPath)
      if (
        priorBackup.version !== 1 ||
        priorBackup.records.some((record) => record.schemaVersion === 2)
      ) {
        throw new WorktreeRegistryError(
          'REGISTRY_CONFLICT',
          'Legacy registry rewrite recovery requires the original pure V1 source backup.',
          this.registryPath,
        )
      }
    }
    if (!legacyRewrite && priorEvidence && priorEvidence.sourceHash !== source.hash) {
      throw new WorktreeRegistryError(
        'REGISTRY_CONFLICT',
        'The registry source hash conflicts with recorded upgrade evidence.',
        this.registryPath,
      )
    }

    const backupHash = legacyRewrite && priorEvidence
      ? priorEvidence.backupHash
      : this.prepareBackup(source.bytes, source.hash)
    const records = legacyRewrite
      ? cloneRecords(parsed.records as ManagedWorktreeRecordV2[])
      : (parsed.records as ManagedWorktreeRecord[]).map(
          (record) => upgradeRecord(record, this.registryPath),
        )
    const targetBytes = encodeRegistry(records)
    const targetHash = sha256(targetBytes)
    if (!legacyRewrite && priorEvidence?.status === 'complete' && priorEvidence.registryHash !== targetHash) {
      throw new WorktreeRegistryError(
        'REGISTRY_CONFLICT',
        'The backup-derived registry upgrade conflicts with the last completed registry hash.',
        this.registryPath,
      )
    }
    if (
      legacyRewrite &&
      priorEvidence?.status === 'prepared' &&
      priorEvidence.registryHash !== targetHash
    ) {
      throw new WorktreeRegistryError(
        'REGISTRY_CONFLICT',
        'Prepared legacy registry recovery evidence does not match the current source.',
        this.registryPath,
      )
    }
    const prepared: RegistryMarker = {
      schemaVersion: 1,
      status: 'prepared',
      sourceVersion: 1,
      sourceHash: legacyRewrite && priorEvidence ? priorEvidence.sourceHash : source.hash,
      backupHash,
      registryHash: targetHash,
      completedAt: legacyRewrite ? priorEvidence?.completedAt : undefined,
    }
    this.writeMarker(prepared)

    // The registry is the source of truth. A writer that does not participate
    // in the lock may still replace it while this upgrade is being prepared;
    // detect that immediately before the final atomic replace instead of
    // overwriting newer bytes with migration derived from an older source.
    try {
      writeBytesAtomically(this.registryPath, targetBytes, () => {
        this.hooks.beforeReplace?.()
        const beforeReplace = this.readSource()
        if (
          !beforeReplace.exists ||
          beforeReplace.hash !== source.hash ||
          beforeReplace.identity !== source.identity
        ) {
          throw new WorktreeRegistryError(
            'REGISTRY_CONFLICT',
            'The registry source changed during upgrade; source bytes were preserved.',
            this.registryPath,
          )
        }
        this.hooks.beforePublish?.()
      }, { exists: true, hash: source.hash })
    } catch (error) {
      throw wrapError(
        error,
        'REGISTRY_WRITE_FAILED',
        'Unable to atomically replace the managed-worktree registry during upgrade.',
        this.registryPath,
      )
    }

    // Verify the replacement before publishing completion evidence. If the
    // process crashes before this marker, the next load can validate V2 and
    // complete the evidence without touching registry bytes again.
    const replaced = this.readSource()
    if (!replaced.exists || replaced.hash !== targetHash) {
      throw new WorktreeRegistryError(
        'REGISTRY_CONFLICT',
        'The upgraded registry hash differs from the prepared output.',
        this.registryPath,
      )
    }
    this.writeMarker({
      ...prepared,
      status: 'complete',
      completedAt: legacyRewrite && priorEvidence?.completedAt !== undefined
        ? priorEvidence.completedAt
        : Date.now(),
    })
    return records
  }

  /**
   * Read the authoritative registry state while already holding the
   * cross-process lock. Performs missing-source recovery and the V1→V2
   * upgrade, then re-reads the source so the returned hash/identity describe
   * the bytes the caller will subsequently persist against.
   */
  private readAuthoritativeLocked(): {
    source: { exists: boolean; hash: string; identity: string | null }
    records: Map<string, ManagedWorktreeRecordV2>
  } {
    let source = this.readSource()
    if (!source.exists) {
      this.recoverMissingSourceLocked()
      source = this.readSource()
    }
    if (!source.exists) {
      return { source, records: new Map() }
    }
    const parsed = parseRegistry(source.raw, this.registryPath)
    const authoritative = this.upgradeLocked(source, parsed)
    const authoritativeSource = this.readSource()
    return {
      source: authoritativeSource,
      records: new Map(
        authoritative.map((record) => [record.managedWorktreeId, cloneRecord(record)] as const),
      ),
    }
  }

  /**
   * Read and validate the fixed registry. This method is intentionally
   * authoritative on every call: callers cannot use an old in-memory snapshot
   * to authorize a mutation after another process has written newer bytes.
   */
  async load(): Promise<void> {
    try {
      await this.lock.run(async () => {
        const { source, records } = this.readAuthoritativeLocked()
        this.cache = new Map(
          Array.from(records.values(), (record) => [record.managedWorktreeId, cloneRecord(record)] as const),
        )
        this.sourceState = source.exists ? 'present' : 'absent'
      })
    } catch (error) {
      // Do not clear cache or mark a failed source as loaded. Every public
      // operation calls load before using records, so corruption fails closed.
      if (error instanceof WorktreeRegistryError) throw error
      throw wrapError(
        error,
        'REGISTRY_LOCK_FAILED',
        'Unable to acquire the managed-worktree registry lock.',
        this.registryPath,
      )
    }
  }

  private persistLocked(
    records: Iterable<ManagedWorktreeRecordV2>,
    expectedSource: { exists: boolean; hash: string; identity: string | null },
  ): void {
    const source = this.readSource()
    if (
      source.exists !== expectedSource.exists ||
      (expectedSource.exists && (
        source.hash !== expectedSource.hash ||
        source.identity !== expectedSource.identity
      ))
    ) {
      throw new WorktreeRegistryError(
        'REGISTRY_CONFLICT',
        'The registry source changed before the mutation could be committed.',
        this.registryPath,
      )
    }

    const bytes = encodeRegistry(records)
    const expectedHash = sha256(bytes)
    try {
      writeBytesAtomically(this.registryPath, bytes, () => {
        this.hooks.beforeReplace?.()
        const beforeReplace = this.readSource()
        if (
          beforeReplace.exists !== expectedSource.exists ||
          (expectedSource.exists && (
            beforeReplace.hash !== expectedSource.hash ||
            beforeReplace.identity !== expectedSource.identity
          ))
        ) {
          throw new WorktreeRegistryError(
            'REGISTRY_CONFLICT',
            'The registry source changed during mutation; source bytes were preserved.',
            this.registryPath,
          )
        }
        this.hooks.beforePublish?.()
      }, expectedSource)
    } catch (error) {
      throw wrapError(
        error,
        'REGISTRY_WRITE_FAILED',
        'Unable to atomically persist the managed-worktree registry.',
        this.registryPath,
      )
    }
    const written = this.readSource()
    if (!written.exists || written.hash !== expectedHash) {
      throw new WorktreeRegistryError(
        'REGISTRY_CONFLICT',
        'The persisted registry hash differs from the mutation output.',
        this.registryPath,
      )
    }
    this.cache = new Map(Array.from(records, (record) => [record.managedWorktreeId, cloneRecord(record)] as const))
    this.sourceState = 'present'

    // Keep migration evidence hash-bound to the current valid V2 bytes. This
    // is not required for ordinary reads, but lets recovery tooling prove that
    // the registry still descends from the backed-up V1 source.
    const evidence = this.getUpgradeEvidence()
    if (evidence) {
      this.writeMarker({
        schemaVersion: 1,
        status: 'complete',
        sourceVersion: 1,
        sourceHash: evidence.sourceHash,
        backupHash: evidence.backupHash,
        registryHash: expectedHash,
        completedAt: evidence.completedAt ?? Date.now(),
      })
    }
  }

  private async mutate(
    mutator: (records: Map<string, ManagedWorktreeRecordV2>) => boolean,
  ): Promise<void> {
    try {
      await this.lock.run(async () => {
        // Read-modify-write starts from disk while holding the cross-process
        // lock, never from a potentially stale in-memory cache.
        const { source, records } = this.readAuthoritativeLocked()
        const changed = mutator(records)
        if (!changed) {
          const latest = this.readSource()
          if (
            latest.exists !== source.exists ||
            (source.exists && (
              latest.hash !== source.hash ||
              latest.identity !== source.identity
            ))
          ) {
            throw new WorktreeRegistryError(
              'REGISTRY_CONFLICT',
              'The registry source changed during a no-op mutation.',
              this.registryPath,
            )
          }
          this.cache = new Map(Array.from(records.values(), (record) => [record.managedWorktreeId, cloneRecord(record)] as const))
          this.sourceState = source.exists ? 'present' : 'absent'
          return
        }
        this.hooks.beforePersist?.()
        this.persistLocked(records.values(), {
          exists: source.exists,
          hash: source.hash,
          identity: source.identity,
        })
      })
    } catch (error) {
      if (error instanceof WorktreeRegistryError) throw error
      throw wrapError(
        error,
        'REGISTRY_LOCK_FAILED',
        'Unable to acquire the managed-worktree registry lock.',
        this.registryPath,
      )
    }
  }

  async list(): Promise<ManagedWorktreeRecordVersioned[]> {
    await this.load()
    return cloneRecords(this.cache.values())
  }

  async get(id: string): Promise<ManagedWorktreeRecordVersioned | undefined> {
    await this.load()
    const record = this.cache.get(id)
    return record ? cloneRecord(record) : undefined
  }

  /** Owner count from the authoritative registry (>= 0). */
  async getOwnerCount(id: string): Promise<number> {
    await this.load()
    return this.cache.get(id)?.ownerSessionIds.length ?? 0
  }

  async upsert(record: ManagedWorktreeRecord | ManagedWorktreeRecordV2): Promise<void> {
    await this.mutate((records) => {
      const normalized = normalizeRecord(record, this.registryPath)
      const previous = records.get(normalized.managedWorktreeId)
      records.set(normalized.managedWorktreeId, normalized)
      return !previous || JSON.stringify(previous) !== JSON.stringify(normalized)
    })
  }

  /**
   * Replace a record only when its full value is unchanged since the caller
   * observed it. Reconciliation uses this to avoid writing a stale snapshot
   * over an owner bind or an in-flight removal.
   */
  async upsertIfUnchanged(
    expected: ManagedWorktreeRecordVersioned,
    replacement: ManagedWorktreeRecord | ManagedWorktreeRecordV2,
  ): Promise<boolean> {
    const expectedNormalized = normalizeRecord(expected, this.registryPath)
    const replacementNormalized = normalizeRecord(replacement, this.registryPath)
    let applied = false
    await this.mutate((records) => {
      const current = records.get(expectedNormalized.managedWorktreeId)
      if (!current || JSON.stringify(current) !== JSON.stringify(expectedNormalized)) {
        return false
      }
      applied = true
      records.set(expectedNormalized.managedWorktreeId, replacementNormalized)
      return JSON.stringify(current) !== JSON.stringify(replacementNormalized)
    })
    return applied
  }

  async setState(id: string, state: ManagedWorktreeState): Promise<void> {
    if (!VALID_STATES.has(state)) {
      throw new WorktreeRegistryError('REGISTRY_INVALID_RECORD', 'Invalid managed-worktree state.', this.registryPath)
    }
    await this.mutate((records) => {
      const rec = records.get(id)
      if (!rec || rec.state === state) return false
      rec.state = state
      return true
    })
  }

  /**
   * Add an owner only while the record is still ready. The state check and
   * owner write happen in one locked read-modify-write, so removal can use
   * the same registry transaction to claim the record for destruction.
   */
  async addOwnerIfReady(
    id: string,
    sessionId: string,
  ): Promise<WorktreeOwnerBindResult> {
    if (!sessionId) {
      throw new WorktreeRegistryError('REGISTRY_INVALID_RECORD', 'Owner session ID must be non-empty.', this.registryPath)
    }
    let result: WorktreeOwnerBindResult = { status: 'missing' }
    await this.mutate((records) => {
      const rec = records.get(id)
      if (!rec) {
        result = { status: 'missing' }
        return false
      }
      if (rec.state !== 'ready') {
        result = { status: 'not-ready', state: rec.state }
        return false
      }
      if (rec.ownerSessionIds.includes(sessionId)) {
        result = { status: 'already-owned' }
        return false
      }
      rec.ownerSessionIds.push(sessionId)
      result = { status: 'added' }
      return true
    })
    return result
  }

  /**
   * Atomically claim a removable record after rechecking ownership.
   * `allowUnowned` is used only by reconciliation, which removes records after
   * it has resolved all persisted owner references. Missing and blocked records
   * remain claimable for explicit registry/branch cleanup retries.
   */
  async beginRemoval(
    id: string,
    requestingSessionId: string,
    allowUnowned = false,
  ): Promise<WorktreeRemovalBeginResult> {
    let result: WorktreeRemovalBeginResult = { status: 'missing' }
    await this.mutate((records) => {
      const rec = records.get(id)
      if (!rec) {
        result = { status: 'missing' }
        return false
      }
      // Missing and blocked records are still explicitly removable: their
      // checkout may already be gone, or a prior removal may have failed and
      // left a tracked record for retry. Only an in-flight removal is fenced
      // from a second destructive operation.
      if (rec.state === 'removing') {
        result = { status: 'not-ready', state: rec.state }
        return false
      }
      const otherOwners = rec.ownerSessionIds.filter((owner) => owner !== requestingSessionId)
      if (otherOwners.length > 0) {
        result = { status: 'other-owner' }
        return false
      }
      if (!allowUnowned && !rec.ownerSessionIds.includes(requestingSessionId)) {
        result = { status: 'not-owner' }
        return false
      }
      if (allowUnowned && rec.ownerSessionIds.length > 0) {
        result = { status: 'other-owner' }
        return false
      }
      rec.state = 'removing'
      result = { status: 'started' }
      return true
    })
    return result
  }

  /** Legacy unconditional owner mutation retained for registry maintenance callers. */
  async addOwner(id: string, sessionId: string): Promise<void> {
    if (!sessionId) {
      throw new WorktreeRegistryError('REGISTRY_INVALID_RECORD', 'Owner session ID must be non-empty.', this.registryPath)
    }
    await this.mutate((records) => {
      const rec = records.get(id)
      if (!rec || rec.ownerSessionIds.includes(sessionId)) return false
      rec.ownerSessionIds.push(sessionId)
      return true
    })
  }

  async removeOwner(id: string, sessionId: string): Promise<void> {
    await this.mutate((records) => {
      const rec = records.get(id)
      if (!rec) return false
      const next = rec.ownerSessionIds.filter((owner) => owner !== sessionId)
      if (next.length === rec.ownerSessionIds.length) return false
      rec.ownerSessionIds = next
      return true
    })
  }

  /** Server-authored activity update (creation, restore, attach, unarchive, message). */
  async updateLastUsedAt(id: string, at: number): Promise<void> {
    await this.mutate((records) => {
      const rec = records.get(id)
      if (!rec || rec.lastUsedAt === at) return false
      rec.lastUsedAt = at
      return true
    })
  }

  async remove(id: string): Promise<void> {
    await this.mutate((records) => records.delete(id))
  }

  /**
   * Exclusive registry transaction. Holds the cross-process registry lock for
   * the whole callback, so a lifecycle transaction (capture → commit) cannot be
   * interleaved by another registry writer. The callback mutates the in-memory
   * record map and calls `commit()` to persist atomically; uncommitted changes
   * are discarded when the callback returns.
   *
   * The registry lock is not reentrant. The callback must read and mutate
   * registry state **only through the provided `tx` object** (`tx.get()` /
   * `tx.list()` /
   * `tx.commit()`). Awaiting a lock-acquiring public registry method (such as
   * `get()`, `list()`, `upsert()`, or `remove()`) inside the callback will
   * deadlock: it attempts to acquire the lock this transaction already holds,
   * while the event loop stalls until the transaction releases it.
   */
  async runExclusive<T>(
    fn: (tx: WorktreeRegistryTransaction) => Promise<T> | T,
  ): Promise<T> {
    // Errors thrown by the callback are domain errors (e.g. a lifecycle state
    // guard) and must reach the caller unchanged; only lock acquisition and
    // registry I/O failures are lock failures.
    let callbackFailed = false
    let callbackError: unknown
    try {
      return await this.lock.run(async () => {
        const { source, records } = this.readAuthoritativeLocked()
        const tx: WorktreeRegistryTransaction = {
          // The transaction owns the in-memory map: callers mutate the returned
          // record directly and `commit()` persists it. No clone here, so the
          // mutation is not silently discarded.
          get: (id) => records.get(id),
          list: () => cloneRecords(records.values()),
          commit: () => {
            this.hooks.beforePersist?.()
            this.persistLocked(records.values(), {
              exists: source.exists,
              hash: source.hash,
              identity: source.identity,
            })
          },
        }
        try {
          return await fn(tx)
        } catch (error) {
          callbackFailed = true
          callbackError = error
          throw error
        }
      })
    } catch (error) {
      if (callbackFailed) throw callbackError
      if (error instanceof WorktreeRegistryError) throw error
      throw wrapError(
        error,
        'REGISTRY_LOCK_FAILED',
        'Unable to acquire the managed-worktree registry lock for an exclusive transaction.',
        this.registryPath,
      )
    }
  }

  /** Find a record by its checkout path (normalized). */
  async findByCheckoutPath(checkoutPath: string): Promise<ManagedWorktreeRecordVersioned | undefined> {
    await this.load()
    const normalized = resolvePath(checkoutPath)
    for (const rec of this.cache.values()) {
      if (resolvePath(rec.checkoutPath) === normalized) return cloneRecord(rec)
    }
    return undefined
  }

  /**
   * Reconcile owner/state derivations without ever silently repairing a bad
   * registry. The caller's mutator is authoritative and each operation starts
   * with a locked read-modify-write.
   */
  async reconcile(params: { knownSessionIds: Set<string> }): Promise<void> {
    await this.mutate((records) => {
      let dirty = false
      for (const rec of records.values()) {
        const owners = rec.ownerSessionIds.filter((sessionId) => params.knownSessionIds.has(sessionId))
        if (owners.length !== rec.ownerSessionIds.length) {
          rec.ownerSessionIds = owners
          dirty = true
        }
        if (rec.state === 'ready' && !existsSync(rec.checkoutPath)) {
          rec.state = 'missing'
          dirty = true
        }
      }
      return dirty
    })
  }
}

function normalizeRecord(
  record: ManagedWorktreeRecord | ManagedWorktreeRecordV2,
  registryPath: string,
): ManagedWorktreeRecordV2 {
  const parsed = (record as { schemaVersion?: unknown }).schemaVersion
  if (parsed === 2) return validateV2Record(record, registryPath)
  return upgradeRecord(validateCommonRecord(record, registryPath), registryPath)
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
