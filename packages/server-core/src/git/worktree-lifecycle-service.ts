/**
 * WorktreeLifecycleService — the single entry for every destructive and
 * recovery path over managed worktrees.
 *
 * V2 management, session deletion, archive/retention sweeps, and startup
 * reconciliation all route through this service. Every destructive
 * transaction:
 *
 *  1. acquires the cross-process registry lock (exclusive transaction), the
 *     host lifecycle lock, the common-directory lock, and all owner/path
 *     fences (foreign path leases are refused);
 *  2. quiesces every owning runtime — an unquiesceable runtime blocks;
 *  3. records a durable journal entry before touching the checkout;
 *  4. revalidates the bound fingerprint immediately before capture and again
 *     immediately before source release;
 *  5. requires a verified snapshot before releasing any materialized checkout;
 *  6. commits registry plus owner-session state through the journal before
 *     runtime access resumes.
 *
 * Candidate selection for automatic cleanup uses `lastUsedAt` (creation,
 * restore, owner attach, unarchive, accepted user message), then creation
 * time, then opaque ID. Disabling auto-delete fences new candidates at the
 * policy-version boundary; in-flight source release completes its journaled
 * transaction.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { randomBytes } from 'node:crypto'
import type {
  ManagedWorktreeRecordV2,
  ManagedWorktreeState,
  WorktreeArchiveResult,
  WorktreeCleanupResult,
  WorktreeDeleteResult,
  WorktreeInventory,
  WorktreeInventoryOwner,
  WorktreeInventoryRow,
  WorktreePermanentDeleteResult,
  WorktreePreviewResult,
  WorktreeRestoreResult,
  WorktreeRetryResult,
  ManagedWorktreeSnapshotMeta,
} from '@kata-sh/shared/protocol'
import { CrossProcessFileLock } from './mutation-lock'
import { WorktreeRegistry } from './worktree-registry'
import { WorktreeSnapshotService, WorktreeSnapshotError, computeWorktreeFingerprint } from './worktree-snapshot-service'
import { WorktreeSettingsService } from './worktree-settings-service'
import { ManagedWorktreeService, removeCheckoutFiles } from './managed-worktree-service'
import { PathLeaseManager } from './path-leases'
import { WorktreeJournal } from './worktree-journal'
import { listWorktreeIncludeFiles } from './worktree-include'
import { MutationLock } from './mutation-lock'

export type WorktreeLifecycleErrorCode =
  | 'LIFECYCLE_NOT_READY'
  | 'LIFECYCLE_RECORD_MISSING'
  | 'LIFECYCLE_PREVIEW_STALE'
  | 'LIFECYCLE_STATE_UNMANAGEABLE'
  | 'LIFECYCLE_OWNERS_PRESENT'
  | 'LIFECYCLE_NOT_QUIESCED'
  | 'LIFECYCLE_FOREIGN_LEASE'
  | 'LIFECYCLE_POLICY_CHANGED'
  | 'LIFECYCLE_FAILED'

export class WorktreeLifecycleError extends Error {
  readonly code: WorktreeLifecycleErrorCode
  constructor(code: WorktreeLifecycleErrorCode, message: string) {
    super(message)
    this.name = 'WorktreeLifecycleError'
    this.code = code
  }
}

/** States a record may enter a snapshot-first delete from. */
const DELETABLE_STATES = new Set<ManagedWorktreeState>([
  'ready',
  'unowned',
  'cleanup-failed',
  'restore-failed',
])
/** States restore may start from. */
const RESTORABLE_STATES = new Set<ManagedWorktreeState>([
  'snapshotted',
  'restore-failed',
  'cleanup-failed',
])

export interface LifecycleOwnerRuntime {
  sessionId: string
  active: boolean
  flagged: boolean
  archived: boolean
}

export interface WorktreeLifecycleDeps {
  registry: WorktreeRegistry
  snapshots: WorktreeSnapshotService
  settings: WorktreeSettingsService
  worktrees: ManagedWorktreeService
  mutationLock: MutationLock
  leases: PathLeaseManager
  journal: WorktreeJournal
  /** Host lifecycle lock path (one per server). */
  hostLockPath: string
  /** Server-level cleanup state file. */
  cleanupStatePath: string
  /** Quiesce every owning runtime; false when any cannot quiesce. */
  quiesceRuntimes?: (sessionIds: string[]) => Promise<boolean>
  /** Whether a session is running an agent turn. */
  isSessionActive?: (sessionId: string) => boolean
  /** Whether a session is flagged for attention. */
  isSessionFlagged?: (sessionId: string) => boolean
  /** Persist owner-session recovery state before the journal commit marker. */
  applyOwnerSessionState?: (
    sessionIds: string[],
    record: { managedWorktreeId: string; state: ManagedWorktreeState },
  ) => Promise<void> | void
  /** Persist a lastUsedAt touch for a session's checkout (accepted message). */
  touchSessionCheckout?: (sessionId: string) => Promise<void> | void
}

interface CleanupStateFile {
  lastCleanupResult?: WorktreeCleanupResult
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  // Sanitized server-local failure text: strip absolute paths that could leak
  // server layout into renderers, keep the actionable message.
  return message.replace(/\/[^\s/]+\/[^\s/]+/g, '…').slice(0, 500)
}

/** The registry upgrades every record to V2 in place; this cast is safe. */
function asV2(record: import('@kata-sh/shared/protocol').ManagedWorktreeRecordVersioned): ManagedWorktreeRecordV2 {
  return record as ManagedWorktreeRecordV2
}

export class WorktreeLifecycleService {
  private readonly deps: WorktreeLifecycleDeps
  private readonly hostLock: CrossProcessFileLock
  private ready = false
  private sweepRunning: Promise<WorktreeCleanupResult> | null = null

  constructor(deps: WorktreeLifecycleDeps) {
    this.deps = deps
    this.hostLock = new CrossProcessFileLock(deps.hostLockPath)
  }

  /**
   * Install runtime hooks late (the SessionManager wires them after the
   * services are constructed). Only the runtime-observation hooks are
   * replaceable; structural dependencies stay fixed at construction.
   */
  setHooks(hooks: {
    quiesceRuntimes?: WorktreeLifecycleDeps['quiesceRuntimes']
    isSessionActive?: WorktreeLifecycleDeps['isSessionActive']
    isSessionFlagged?: WorktreeLifecycleDeps['isSessionFlagged']
    applyOwnerSessionState?: WorktreeLifecycleDeps['applyOwnerSessionState']
    touchSessionCheckout?: WorktreeLifecycleDeps['touchSessionCheckout']
  }): void {
    if (hooks.quiesceRuntimes) this.deps.quiesceRuntimes = hooks.quiesceRuntimes
    if (hooks.isSessionActive) this.deps.isSessionActive = hooks.isSessionActive
    if (hooks.isSessionFlagged) this.deps.isSessionFlagged = hooks.isSessionFlagged
    if (hooks.applyOwnerSessionState) this.deps.applyOwnerSessionState = hooks.applyOwnerSessionState
    if (hooks.touchSessionCheckout) this.deps.touchSessionCheckout = hooks.touchSessionCheckout
  }

  // -------------------------------------------------------------------------
  // Readiness gate
  // -------------------------------------------------------------------------

  /** Startup reconciliation completed; lifecycle RPCs may run. */
  markReady(): void {
    this.ready = true
  }

  isReady(): boolean {
    return this.ready
  }

  /** Throw when lifecycle work is attempted before awaited reconciliation. */
  assertReady(): void {
    if (!this.ready) {
      throw new WorktreeLifecycleError(
        'LIFECYCLE_NOT_READY',
        'Worktree lifecycle reconciliation is still running; try again shortly.',
      )
    }
  }

  /**
   * Lifecycle state of the record a session's checkout points at. Sessions
   * without a managed checkout are always ready (no fencing applies).
   */
  recordStateForSession(sessionId: string): { managedWorktreeId: string | null; state: ManagedWorktreeState } {
    const leasedPaths = this.deps.leases.leasesForSession(sessionId)
    for (const path of leasedPaths) {
      const record = this.deps.registry.findByCheckoutPath(path)
      if (record) return { managedWorktreeId: record.managedWorktreeId, state: record.state }
    }
    return { managedWorktreeId: null, state: 'ready' }
  }

  /** True when the session's worktree record is usable for normal work. */
  isSessionRecordReady(sessionId: string): boolean {
    return this.recordStateForSession(sessionId).state === 'ready'
  }

  /** True when a record may be bound by new owners (ready and on disk). */
  isRecordReady(id: string): boolean {
    const record = this.getRecord(id)
    return record?.state === 'ready'
  }

  /** Touch the owning record's lastUsedAt (accepted user message). */
  touchForSession(sessionId: string): void {
    const { managedWorktreeId } = this.recordStateForSession(sessionId)
    if (!managedWorktreeId) return
    this.deps.registry.updateLastUsedAt(managedWorktreeId, Date.now())
    this.deps.touchSessionCheckout?.(sessionId)
  }

  // -------------------------------------------------------------------------
  // Inventory and preview
  // -------------------------------------------------------------------------

  /** The registry upgrades every record to V2 in place. */
  private getRecord(id: string): ManagedWorktreeRecordV2 | undefined {
    const record = this.deps.registry.get(id)
    return record ? asV2(record) : undefined
  }

  private listRecords(): ManagedWorktreeRecordV2[] {
    return this.deps.registry.list().map(asV2)
  }

  private ownerRuntime(record: ManagedWorktreeRecordV2): LifecycleOwnerRuntime[] {
    const archived = new Set(record.archivedOwnerSessionIds ?? [])
    return record.ownerSessionIds.map((sessionId) => ({
      sessionId,
      archived: archived.has(sessionId),
      active: this.deps.isSessionActive?.(sessionId) ?? false,
      flagged: this.deps.isSessionFlagged?.(sessionId) ?? false,
    }))
  }

  private toInventoryRow(record: ManagedWorktreeRecordV2): WorktreeInventoryRow {
    const snapshot = record.snapshot
    return {
      managedWorktreeId: record.managedWorktreeId,
      workspaceId: record.workspaceId,
      displayName: record.displayName,
      expectedBranch: record.expectedBranch,
      repositoryRoot: record.repositoryRoot,
      gitCommonDir: record.gitCommonDir,
      checkoutPath: record.checkoutPath,
      materializationRoot: record.materializationRoot,
      state: record.state,
      createdAt: record.createdAt,
      lastUsedAt: record.lastUsedAt,
      owners: this.ownerRuntime(record).map((owner) => ({
        sessionId: owner.sessionId,
        archived: owner.archived,
        active: owner.active,
        flagged: owner.flagged,
      })),
      snapshot: snapshot
        ? {
            snapshotId: snapshot.snapshotId,
            createdAt: snapshot.createdAt,
            headOid: snapshot.headOid,
            branch: snapshot.branch,
            manifestHash: snapshot.manifestHash,
            fileCount: snapshot.fileCount,
            totalBytes: snapshot.totalBytes,
          }
        : undefined,
      lastCleanupResult: record.lastCleanupResult,
      lastError: record.lastError,
      stateChangedAt: record.stateChangedAt,
    }
  }

  private readCleanupState(): CleanupStateFile {
    try {
      const parsed = JSON.parse(readFileSync(this.deps.cleanupStatePath, 'utf8')) as Partial<CleanupStateFile>
      if (parsed && typeof parsed === 'object' && parsed.lastCleanupResult) {
        return { lastCleanupResult: parsed.lastCleanupResult }
      }
      return {}
    } catch {
      return {}
    }
  }

  private writeCleanupState(state: CleanupStateFile): void {
    mkdirSync(dirname(this.deps.cleanupStatePath), { recursive: true })
    const tmp = `${this.deps.cleanupStatePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    try {
      renameSync(tmp, this.deps.cleanupStatePath)
    } catch (error) {
      try {
        rmSync(tmp, { force: true })
      } catch {
        /* preserve the original error */
      }
      throw error
    }
  }

  /** Per-server inventory across every workspace/repository/root. */
  inventory(): WorktreeInventory {
    const policy = this.deps.settings.getSnapshot()
    const records = this.listRecords()
    const counts = {
      total: records.length,
      materialized: 0,
      missing: 0,
      cleanupFailed: 0,
      snapshotted: 0,
      restoreFailed: 0,
      unowned: 0,
    }
    for (const record of records) {
      switch (record.state) {
        case 'ready':
        case 'unowned':
          counts.materialized += 1
          break
        case 'missing':
          counts.missing += 1
          break
        case 'cleanup-failed':
          counts.cleanupFailed += 1
          break
        case 'snapshotted':
          counts.snapshotted += 1
          break
        case 'restore-failed':
          counts.restoreFailed += 1
          break
        default:
          break
      }
    }
    return {
      serverId: policy.serverId,
      policy: {
        autoDeleteEnabled: policy.autoDeleteEnabled,
        retentionLimit: policy.retentionLimit,
        policyVersion: policy.version,
      },
      lastCleanupResult: this.readCleanupState().lastCleanupResult,
      counts,
      rows: records.map((record) => this.toInventoryRow(record)),
    }
  }

  /** Fresh risk preview naming every owner and the ignored-file policy. */
  async preview(managedWorktreeId: string): Promise<WorktreePreviewResult> {
    const record = this.getRecord(managedWorktreeId)
    if (!record) {
      return {
        managedWorktreeId,
        exists: false,
        state: 'missing',
        owners: [],
        uncommittedFileCount: 0,
        unpushedCommitCount: 0,
        branchHasUniqueWork: false,
        previewFingerprint: '',
        hasSnapshot: false,
        ignoredPolicy: { includeOnly: true, includeFileCount: 0 },
        blocked: true,
        blockedReason: 'The worktree record no longer exists.',
      }
    }
    const owners = this.ownerRuntime(record)
    const exists = existsSync(record.checkoutPath)
    const hasSnapshot = !!record.snapshot && record.state !== 'ready' && record.state !== 'unowned'

    let uncommittedFileCount = 0
    let unpushedCommitCount = 0
    let branchHasUniqueWork = false
    let previewFingerprint = ''
    if (exists && (record.state === 'ready' || record.state === 'unowned')) {
      const fingerprint = await computeWorktreeFingerprint({
        managedWorktreeId: record.managedWorktreeId,
        checkoutPath: record.checkoutPath,
        gitCommonDir: record.gitCommonDir,
        expectedBranch: record.expectedBranch,
        baseRef: record.baseRef,
        ownerSessionIds: record.ownerSessionIds,
        policyVersion: this.deps.settings.getSnapshot().version,
        archivedOwnerSessionIds: record.archivedOwnerSessionIds ?? [],
      })
      previewFingerprint = fingerprint
      const status = await this.deps.worktrees.inspectRemoval(managedWorktreeId, '__lifecycle__')
      uncommittedFileCount = status.uncommittedFileCount
      unpushedCommitCount = status.unpushedCommitCount
      branchHasUniqueWork = status.branchHasUniqueWork
    }

    const protectedOwner = owners.find((owner) => owner.active || owner.flagged)
    return {
      managedWorktreeId,
      exists,
      state: record.state,
      owners: owners.map((owner) => ({
        sessionId: owner.sessionId,
        archived: owner.archived,
        active: owner.active,
        flagged: owner.flagged,
      })),
      uncommittedFileCount,
      unpushedCommitCount,
      branchHasUniqueWork,
      previewFingerprint,
      hasSnapshot,
      ignoredPolicy: {
        includeOnly: true,
        includeFileCount: (await listWorktreeIncludeFiles(record.checkoutPath)).length,
      },
      blocked: protectedOwner
        ? true
        : !DELETABLE_STATES.has(record.state) && !RESTORABLE_STATES.has(record.state),
      blockedReason: protectedOwner
        ? `Session ${protectedOwner.sessionId} is ${protectedOwner.active ? 'active' : 'flagged'} and cannot be interrupted.`
        : undefined,
    }
  }

  // -------------------------------------------------------------------------
  // Manual delete
  // -------------------------------------------------------------------------

  /**
   * Snapshot-first manual deletion confirmed by a fresh preview fingerprint.
   * Revalidates the fingerprint immediately before capture and again after
   * runtime quiescence, immediately before source release.
   */
  async deleteWorktree(managedWorktreeId: string, previewFingerprint: string): Promise<WorktreeDeleteResult> {
    this.assertReady()
    const record = this.getRecord(managedWorktreeId)
    if (!record) {
      throw new WorktreeLifecycleError('LIFECYCLE_RECORD_MISSING', 'The worktree record no longer exists.')
    }
    if (!DELETABLE_STATES.has(record.state) && record.state !== 'missing') {
      throw new WorktreeLifecycleError(
        'LIFECYCLE_STATE_UNMANAGEABLE',
        `A worktree in state ${record.state} cannot be deleted; restore it or retry its failed step first.`,
      )
    }
    if (record.state === 'missing') {
      // Reconciliation already proved the checkout is absent from disk and
      // Git. There is nothing to capture or release; the confirmed action is
      // a journaled registry cleanup that retains the branch.
      return this.removeMissingRecord(record)
    }
    if (!previewFingerprint) {
      throw new WorktreeLifecycleError('LIFECYCLE_PREVIEW_STALE', 'A fresh preview fingerprint is required before deletion.')
    }

    const policy = this.deps.settings.getSnapshot()
    return this.hostLock.run(async () => {
      const outcome = await this.runRemovalTransaction(record, {
        expectedFingerprint: previewFingerprint,
        policyVersion: policy.version,
        journalOp: 'delete',
        requireQuiesce: true,
      })
      if (!outcome.ok) return outcome.result
      return { deleted: true, state: 'snapshotted', snapshotId: outcome.snapshotId }
    })
  }

  private async removeMissingRecord(record: ManagedWorktreeRecordV2): Promise<WorktreeDeleteResult> {
    const policy = this.deps.settings.getSnapshot()
    return this.hostLock.run(async () => {
      const journalEntry = this.deps.journal.begin({
        op: 'delete',
        recordId: record.managedWorktreeId,
        sessionIds: record.ownerSessionIds,
        policyVersion: policy.version,
      })
      this.deps.journal.step(journalEntry.journalId, 'missing-verified')
      this.deps.registry.remove(record.managedWorktreeId)
      this.deps.journal.commit(journalEntry.journalId, 'record-removed')
      return { deleted: true, state: 'missing' }
    })
  }

  // -------------------------------------------------------------------------
  // Restore
  // -------------------------------------------------------------------------

  /**
   * Restore a snapshotted record into a fresh checkout, rebinding every owner
   * session. Only after the registry + session commit is journaled may the
   * payload be removed and the hidden ref CAS-deleted.
   */
  async restoreWorktree(managedWorktreeId: string): Promise<WorktreeRestoreResult> {
    this.assertReady()
    const record = this.getRecord(managedWorktreeId)
    if (!record) {
      throw new WorktreeLifecycleError('LIFECYCLE_RECORD_MISSING', 'The worktree record no longer exists.')
    }
    if (!RESTORABLE_STATES.has(record.state) || !record.snapshot) {
      throw new WorktreeLifecycleError(
        'LIFECYCLE_STATE_UNMANAGEABLE',
        `A worktree in state ${record.state} cannot be restored from a snapshot.`,
      )
    }
    const policy = this.deps.settings.getSnapshot()
    const meta = record.snapshot

    return this.hostLock.run(async () => {
      const journalEntry = this.deps.journal.begin({
        op: 'restore',
        recordId: record.managedWorktreeId,
        sessionIds: record.ownerSessionIds,
        policyVersion: policy.version,
      })
      try {
          this.deps.journal.step(journalEntry.journalId, 'locks-acquired')
        const destination = this.buildRestoreDestination(record)
        this.deps.journal.step(journalEntry.journalId, 'destination-validated')
        const restored = await this.deps.snapshots.restore({ record, meta, checkoutPath: destination })
        this.deps.journal.step(journalEntry.journalId, 'state-restored')

        const readyRecord: ManagedWorktreeRecordV2 = {
          ...record,
          state: 'ready',
          checkoutPath: restored.checkoutPath,
          lastUsedAt: Date.now(),
          lastError: undefined,
          snapshot: undefined,
          stateChangedAt: Date.now(),
        }
        await this.deps.registry.runExclusive(async (tx) => {
          const current = tx.get(record.managedWorktreeId)
          if (!current) throw new WorktreeLifecycleError('LIFECYCLE_RECORD_MISSING', 'The worktree record disappeared during restore.')
          Object.assign(current, readyRecord)
          tx.commit()
        })
        await this.deps.applyOwnerSessionState?.(record.ownerSessionIds, {
          managedWorktreeId: record.managedWorktreeId,
          state: 'ready',
        })
        this.deps.journal.commit(journalEntry.journalId, 'registry-sessions-committed')

        // Only after the commit: remove the payload and CAS-delete the ref.
        this.deps.snapshots.removePayload(meta)
        await this.deps.snapshots.casDeleteRef(record.repositoryRoot, meta)
        return { restored: true, state: 'ready', checkoutPath: restored.checkoutPath }
      } catch (error) {
        const sanitized = sanitizeError(error)
        this.deps.journal.fail(journalEntry.journalId, sanitized)
        await this.recordFailure(record.managedWorktreeId, 'restore-failed', sanitized)
        return { restored: false, state: 'restore-failed', error: sanitized }
      }
    })
  }

  /**
   * Retry a safe failed step: re-run the removal for cleanup-failed records
   * and the restore for restore-failed records. Never touches records whose
   * state is not a failed terminal state.
   */
  async retryWorktree(managedWorktreeId: string): Promise<WorktreeRetryResult> {
    this.assertReady()
    const record = this.getRecord(managedWorktreeId)
    if (!record) {
      throw new WorktreeLifecycleError('LIFECYCLE_RECORD_MISSING', 'The worktree record no longer exists.')
    }
    if (record.state === 'cleanup-failed') {
      if (record.snapshot) {
        // The snapshot exists; complete the source release.
        const policy = this.deps.settings.getSnapshot()
        return this.hostLock.run(async () => {
          const journalEntry = this.deps.journal.begin({
            op: 'delete',
            recordId: record.managedWorktreeId,
            sessionIds: record.ownerSessionIds,
            policyVersion: policy.version,
          })
          try {
            this.deps.journal.step(journalEntry.journalId, 'retry-cleanup')
            const released = await removeCheckoutFiles(record.repositoryRoot, record.checkoutPath)
            if (!released) {
              throw new WorktreeLifecycleError('LIFECYCLE_FAILED', 'The checkout could not be removed; retry again.')
            }
            this.deps.journal.step(journalEntry.journalId, 'checkout-removed')
            const snapshotted: ManagedWorktreeRecordV2 = { ...record, state: 'snapshotted', lastError: undefined, stateChangedAt: Date.now() }
            await this.deps.registry.runExclusive(async (tx) => {
              const current = tx.get(record.managedWorktreeId)
              if (!current) return
              Object.assign(current, snapshotted)
              tx.commit()
            })
            this.deps.journal.commit(journalEntry.journalId, 'snapshotted')
            return { retried: true, state: 'snapshotted' }
          } catch (error) {
            const sanitized = sanitizeError(error)
            this.deps.journal.fail(journalEntry.journalId, sanitized)
            await this.recordFailure(record.managedWorktreeId, 'cleanup-failed', sanitized)
            return { retried: false, state: 'cleanup-failed', error: sanitized }
          }
        })
      }
      // No snapshot yet: re-run the full snapshot-first removal.
      const policy = this.deps.settings.getSnapshot()
      const outcome = await this.hostLock.run(() =>
        this.runRemovalTransaction(record, {
          expectedFingerprint: null,
          policyVersion: policy.version,
          journalOp: 'delete',
          requireQuiesce: true,
        }),
      )
      if (!outcome.ok) return { retried: false, state: record.state, error: outcome.result.error }
      return { retried: true, state: 'snapshotted' }
    }
    if (record.state === 'restore-failed') {
      const restored = await this.restoreWorktree(managedWorktreeId)
      return { retried: restored.restored, state: restored.state, error: restored.error }
    }
    throw new WorktreeLifecycleError(
      'LIFECYCLE_STATE_UNMANAGEABLE',
      `A worktree in state ${record.state} has no failed step to retry.`,
    )
  }

  /**
   * Permanent deletion of an unowned snapshot: verifies payload/ref ownership,
   * CAS-deletes only the captured hidden ref, retains the branch, removes the
   * payload, and finally removes the registry record.
   */
  async permanentDelete(managedWorktreeId: string, confirmIrreversible: boolean): Promise<WorktreePermanentDeleteResult> {
    this.assertReady()
    if (!confirmIrreversible) {
      throw new WorktreeLifecycleError(
        'LIFECYCLE_FAILED',
        'Permanent snapshot deletion requires the irreversibility confirmation.',
      )
    }
    const record = this.getRecord(managedWorktreeId)
    if (!record) {
      throw new WorktreeLifecycleError('LIFECYCLE_RECORD_MISSING', 'The worktree record no longer exists.')
    }
    if (record.ownerSessionIds.length > 0) {
      throw new WorktreeLifecycleError(
        'LIFECYCLE_OWNERS_PRESENT',
        'Owner sessions must first restore, rebind, or delete before the snapshot can be permanently deleted.',
      )
    }
    if (!record.snapshot) {
      throw new WorktreeLifecycleError(
        'LIFECYCLE_STATE_UNMANAGEABLE',
        'There is no snapshot payload to permanently delete.',
      )
    }
    const policy = this.deps.settings.getSnapshot()
    return this.hostLock.run(async () => {
      const journalEntry = this.deps.journal.begin({
        op: 'permanent-delete',
        recordId: record.managedWorktreeId,
        sessionIds: [],
        policyVersion: policy.version,
      })
      try {
        this.deps.journal.step(journalEntry.journalId, 'payload-verified')
        const snapshot = record.snapshot!
        await this.deps.snapshots.permanentDelete(record.repositoryRoot, snapshot)
        this.deps.journal.step(journalEntry.journalId, 'payload-removed')
        this.deps.registry.remove(record.managedWorktreeId)
        this.deps.journal.commit(journalEntry.journalId, 'record-removed')
        return { deleted: true }
      } catch (error) {
        const sanitized = sanitizeError(error)
        this.deps.journal.fail(journalEntry.journalId, sanitized)
        return { deleted: false, error: sanitized }
      }
    })
  }

  // -------------------------------------------------------------------------
  // Archive and owner-session lifecycle
  // -------------------------------------------------------------------------

  /** Owner archive/unarchive edge. All-archived triggers archive cleanup. */
  async setArchived(managedWorktreeId: string, sessionId: string, archived: boolean): Promise<WorktreeArchiveResult> {
    this.assertReady()
    const record = this.getRecord(managedWorktreeId)
    if (!record) {
      throw new WorktreeLifecycleError('LIFECYCLE_RECORD_MISSING', 'The worktree record no longer exists.')
    }
    if (!record.ownerSessionIds.includes(sessionId)) {
      throw new WorktreeLifecycleError('LIFECYCLE_OWNERS_PRESENT', 'Only an owner session can archive or unarchive a worktree.')
    }
    const archivedOwners = new Set(record.archivedOwnerSessionIds ?? [])
    if (archived) archivedOwners.add(sessionId)
    else archivedOwners.delete(sessionId)

    const next: ManagedWorktreeRecordV2 = {
      ...record,
      archivedOwnerSessionIds: [...archivedOwners],
      lastUsedAt: archived ? record.lastUsedAt : Date.now(),
      stateChangedAt: Date.now(),
    }
    this.deps.registry.upsert(next)

    const allArchived = record.ownerSessionIds.every((owner) => archivedOwners.has(owner))
    const anyProtected = record.ownerSessionIds.some(
      (owner) => (this.deps.isSessionActive?.(owner) ?? false) || (this.deps.isSessionFlagged?.(owner) ?? false),
    )
    const cleanupEnqueued = archived && allArchived && !anyProtected
    if (cleanupEnqueued) {
      await this.enqueueCleanup()
    }
    return { archived, state: next.state, cleanupEnqueued }
  }

  /**
   * Plain session deletion: remove one owner. Remaining owners and the
   * checkout survive. Final-owner deletion leaves an unowned record and
   * enqueues policy cleanup.
   */
  async detachSession(sessionId: string): Promise<void> {
    const { managedWorktreeId } = this.recordStateForSession(sessionId)
    if (!managedWorktreeId) return
    const record = this.getRecord(managedWorktreeId)
    if (!record) return
    const remaining = record.ownerSessionIds.filter((owner) => owner !== sessionId)
    const next: ManagedWorktreeRecordV2 = {
      ...record,
      ownerSessionIds: remaining,
      archivedOwnerSessionIds: (record.archivedOwnerSessionIds ?? []).filter((owner) => owner !== sessionId),
      state: remaining.length === 0 ? 'unowned' : record.state,
      stateChangedAt: Date.now(),
    }
    this.deps.registry.upsert(next)
    this.deps.leases.releaseSession(sessionId)
    if (remaining.length === 0) {
      await this.enqueueCleanup()
    }
  }

  /**
   * "Delete session and worktree": snapshot-first removal for the final owner.
   * The caller (SessionManager) has already staged the session storage
   * reversibly; on failure the staged session is restored and nothing is lost.
   * A session-delete request can never remove a worktree with another owner.
   */
  async removeForSessionDeletion(input: {
    sessionId: string
    managedWorktreeId: string
  }): Promise<{ outcome: 'removed' } | { outcome: 'blocked'; reason: string; reasonCode?: string }> {
    const record = this.getRecord(input.managedWorktreeId)
    if (!record) return { outcome: 'removed' }
    const otherOwners = record.ownerSessionIds.filter((owner) => owner !== input.sessionId)
    if (otherOwners.length > 0) {
      return {
        outcome: 'blocked',
        reason: 'Another session still owns this worktree; delete that session first.',
      }
    }
    const policy = this.deps.settings.getSnapshot()
    const outcome = await this.hostLock.run(() =>
      this.runRemovalTransaction(record, {
        expectedFingerprint: null,
        policyVersion: policy.version,
        journalOp: 'session-delete',
        requireQuiesce: false,
        droppingSessions: [input.sessionId],
      }),
    )
    if (!outcome.ok) return { outcome: 'blocked', reason: outcome.result.error ?? 'Removal failed.', reasonCode: 'agent_not_quiesced' }
    return { outcome: 'removed' }
  }

  // -------------------------------------------------------------------------
  // Automatic cleanup (archive + retention)
  // -------------------------------------------------------------------------

  /**
   * Coalescing enqueue: one sweep runs at a time; callers await the sweep that
   * covers their enqueue.
   */
  enqueueCleanup(): Promise<WorktreeCleanupResult> {
    const running = this.sweepRunning ?? this.runCleanupSweep()
    this.sweepRunning = running.finally(() => {
      if (this.sweepRunning === running) this.sweepRunning = null
    })
    return this.sweepRunning
  }

  /**
   * One idempotent sweep. Archive cleanup selects records whose owners are ALL
   * archived (none active/flagged/unquiesceable); retention cleanup selects
   * idle unarchived candidates beyond the retention limit, oldest `lastUsedAt`
   * first. Every candidate is tried at most once per sweep; candidate-specific
   * blocks are skipped and failures are persisted.
   */
  async runCleanupSweep(): Promise<WorktreeCleanupResult> {
    const policy = this.deps.settings.getSnapshot()
    if (!policy.autoDeleteEnabled) {
      const skipped: WorktreeCleanupResult = {
        at: Date.now(),
        outcome: 'skipped',
        policyVersion: policy.version,
        reason: 'Automatic cleanup is disabled.',
      }
      this.writeCleanupState({ lastCleanupResult: skipped })
      return skipped
    }

    const startedPolicyVersion = policy.version
    const records = this.listRecords()
    const byId = new Map(records.map((record) => [record.managedWorktreeId, record]))

    // Archive candidates: every owner archived, none protected.
    const archiveCandidates = records.filter((record) => {
      if (record.state !== 'ready' && record.state !== 'unowned') return false
      const archived = new Set(record.archivedOwnerSessionIds ?? [])
      if (record.ownerSessionIds.length === 0) return false
      if (!record.ownerSessionIds.every((owner) => archived.has(owner))) return false
      return !record.ownerSessionIds.some(
        (owner) => (this.deps.isSessionActive?.(owner) ?? false) || (this.deps.isSessionFlagged?.(owner) ?? false),
      )
    })

    // Retention candidates: materialized records beyond the limit, idle and
    // unarchived (protected records — active/flagged owners, foreign leases,
    // unsupported states — are skipped), ordered by lastUsedAt, createdAt,
    // then opaque ID.
    const materialized = records.filter(
      (record) => (record.state === 'ready' || record.state === 'unowned') && existsSync(record.checkoutPath),
    )
    const retentionCandidates = materialized
      .filter((record) => {
        const archived = new Set(record.archivedOwnerSessionIds ?? [])
        const anyArchived = record.ownerSessionIds.some((owner) => archived.has(owner))
        if (anyArchived) return false
        // Protected: an active or flagged owner blocks retention selection.
        return !record.ownerSessionIds.some(
          (owner) => (this.deps.isSessionActive?.(owner) ?? false) || (this.deps.isSessionFlagged?.(owner) ?? false),
        )
      })
      .sort((left, right) => {
        const byUsed = left.lastUsedAt - right.lastUsedAt
        if (byUsed !== 0) return byUsed
        const byCreated = left.createdAt - right.createdAt
        if (byCreated !== 0) return byCreated
        return left.managedWorktreeId < right.managedWorktreeId ? -1 : 1
      })
      .slice(0, Math.max(0, materialized.length - policy.retentionLimit))

    const candidates = [
      ...archiveCandidates.map((record) => ({ record, kind: 'archive' as const })),
      ...retentionCandidates.map((record) => ({ record, kind: 'retention' as const })),
    ]
    // One attempt per candidate per sweep.
    const attempted = new Set<string>()
    const failures: string[] = []

    for (const { record } of candidates) {
      if (attempted.has(record.managedWorktreeId)) continue
      attempted.add(record.managedWorktreeId)
      // A policy change (e.g. auto-delete disabled) fences NEW candidates at
      // the started policy version; the in-flight one completes its journaled
      // transaction.
      const currentPolicy = this.deps.settings.getSnapshot()
      if (currentPolicy.version !== startedPolicyVersion || !currentPolicy.autoDeleteEnabled) {
        break
      }
      const current = byId.get(record.managedWorktreeId)
      if (!current || current.state !== record.state) continue
      try {
            const outcome = await this.runRemovalTransaction(current, {
          expectedFingerprint: null,
          policyVersion: startedPolicyVersion,
          journalOp: 'cleanup',
          requireQuiesce: true,
        })
        if (outcome.ok) {
          const result: WorktreeCleanupResult = {
            at: Date.now(),
            outcome: 'succeeded',
            policyVersion: startedPolicyVersion,
            removedWorktreeId: record.managedWorktreeId,
          }
          this.writeCleanupState({ lastCleanupResult: result })
          return result
        }
        if (outcome.result.error) failures.push(outcome.result.error)
      } catch (error) {
        failures.push(sanitizeError(error))
      }
    }

    const insufficient = candidates.length > 0 && failures.length === 0
    const result: WorktreeCleanupResult = {
      at: Date.now(),
      outcome: 'blocked',
      policyVersion: startedPolicyVersion,
      reason: insufficient
        ? `No eligible candidate could satisfy the retention limit of ${policy.retentionLimit}.`
        : failures[0] ?? 'No candidates were eligible for cleanup.',
    }
    this.writeCleanupState({ lastCleanupResult: result })
    return result
  }

  // -------------------------------------------------------------------------
  // Shared transaction core
  // -------------------------------------------------------------------------

  private buildRestoreDestination(record: ManagedWorktreeRecordV2): string {
    const fragment = record.displayName
      .normalize('NFC')
      .replace(/[\\/]+/g, '-')
      .replace(/[^\p{L}\p{N}._-]+/gu, '-')
      .replace(/^[.-]+/, '')
      .replace(/[.-]+$/, '')
      .slice(0, 80) || 'worktree'
    const repoKey = record.managedWorktreeId.split('-')[0] ?? 'repo'
    return join(record.materializationRoot, record.workspaceId, repoKey, `${fragment}-${randomBytes(4).toString('hex')}`)
  }

  private async recordFailure(
    managedWorktreeId: string,
    state: 'cleanup-failed' | 'restore-failed',
    sanitized: string,
  ): Promise<void> {
    try {
      const record = this.getRecord(managedWorktreeId)
      if (!record) return
      this.deps.registry.upsert({
        ...record,
        state,
        lastError: sanitized,
        stateChangedAt: Date.now(),
      })
    } catch {
      /* the failure record is best-effort */
    }
  }

  /**
   * The snapshot-first removal transaction core. Returns the final state when
   * removal succeeded (`ok: true`) or a typed failure result otherwise. All
   * boundary checks happen before capture; the checkout is released only after
   * a verified snapshot and the final post-quiescence fingerprint.
   */
  private async runRemovalTransaction(
    record: ManagedWorktreeRecordV2,
    options: {
      expectedFingerprint: string | null
      policyVersion: number
      journalOp: 'delete' | 'session-delete' | 'cleanup'
      requireQuiesce: boolean
      droppingSessions?: string[]
    },
  ): Promise<{ ok: true; snapshotId: string } | { ok: false; result: WorktreeDeleteResult }> {
    const managedWorktreeId = record.managedWorktreeId
    const ownerSet = new Set(record.ownerSessionIds)
    const journalEntry = this.deps.journal.begin({
      op: options.journalOp,
      recordId: managedWorktreeId,
      sessionIds: record.ownerSessionIds,
      policyVersion: options.policyVersion,
    })
    const fail = async (code: WorktreeLifecycleErrorCode, message: string): Promise<{ ok: false; result: WorktreeDeleteResult }> => {
      this.deps.journal.fail(journalEntry.journalId, message)
      return { ok: false, result: { deleted: false, state: record.state, error: message } }
    }

    try {
      this.deps.journal.step(journalEntry.journalId, 'locks-acquired')

      // Path fences: every canonical checkout path must be leased only by the
      // transaction's owner set (sessions not yet in the registry still hold
      // leases and protect their checkout).
      const foreignLeases = this.deps.leases.leasedBy(record.checkoutPath).filter((sessionId) => !ownerSet.has(sessionId))
      if (foreignLeases.length > 0) {
        return fail('LIFECYCLE_FOREIGN_LEASE', `Another session (${foreignLeases.join(', ')}) is using this checkout path.`)
      }

      // Runtime quiescence: every owning runtime must stop before capture.
      if (options.requireQuiesce) {
        const quiesced = this.deps.quiesceRuntimes ? await this.deps.quiesceRuntimes(record.ownerSessionIds) : true
        if (!quiesced) {
          return fail('LIFECYCLE_NOT_QUIESCED', 'An owning agent runtime could not be quiesced.')
        }
      }
        this.deps.journal.step(journalEntry.journalId, 'quiesced')

      // Revalidate the fingerprint immediately before capture.
      if (options.expectedFingerprint) {
        const fresh = await this.deps.snapshots.recomputeFingerprint(record)
        if (fresh !== options.expectedFingerprint) {
          return fail('LIFECYCLE_PREVIEW_STALE', 'The worktree changed after the confirmation; inspect it again.')
        }
      }
      this.deps.journal.step(journalEntry.journalId, 'fingerprint-validated')

      // Registry: snapshotting.
      await this.deps.registry.runExclusive(async (tx) => {
        const current = tx.get(managedWorktreeId)
        if (!current || current.state !== record.state) {
          throw new WorktreeLifecycleError('LIFECYCLE_PREVIEW_STALE', 'The worktree state changed; re-inspect it.')
        }
        current.state = 'snapshotting'
        current.policyVersion = options.policyVersion
        current.lastError = undefined
        current.stateChangedAt = Date.now()
        tx.commit()
      })
        this.deps.journal.step(journalEntry.journalId, 'registry-snapshotting')

      // Capture (skipped when a verified snapshot already exists).
      let meta: ManagedWorktreeSnapshotMeta | null = null
      if (record.snapshot && record.state !== 'ready' && record.state !== 'unowned') {
        meta = record.snapshot
        try {
          this.deps.snapshots.verifyPayload(meta)
          await this.deps.snapshots.verifyHiddenRef(record.repositoryRoot, meta)
        } catch {
          meta = null
        }
      }
      if (!meta) {
        const finalFingerprint = await this.deps.snapshots.recomputeFingerprint(record)
        const captured = await this.deps.snapshots.capture({
          record: { ...record, state: 'snapshotting' },
          finalFingerprint,
          previewFingerprint: options.expectedFingerprint ?? finalFingerprint,
          policyVersion: options.policyVersion,
        })
        meta = captured.meta
        this.deps.journal.step(journalEntry.journalId, 'captured')
      } else {
        this.deps.journal.step(journalEntry.journalId, 'snapshot-verified')
      }

      // Registry: snapshotted (durable before source release).
      await this.deps.registry.runExclusive(async (tx) => {
        const current = tx.get(managedWorktreeId)
        if (!current) throw new WorktreeLifecycleError('LIFECYCLE_RECORD_MISSING', 'The worktree record disappeared during capture.')
        current.state = 'snapshotted'
        current.snapshot = meta!
        current.lastError = undefined
        current.stateChangedAt = Date.now()
        tx.commit()
      })
        this.deps.journal.step(journalEntry.journalId, 'registry-snapshotted')

      // Final post-quiescence fingerprint immediately before source release.
      if (options.expectedFingerprint) {
        const finalFingerprint = await this.deps.snapshots.recomputeFingerprint(record)
        if (finalFingerprint !== options.expectedFingerprint) {
          throw new WorktreeLifecycleError('LIFECYCLE_PREVIEW_STALE', 'The worktree changed during capture; nothing was removed.')
        }
      }
      this.deps.journal.step(journalEntry.journalId, 'fingerprint-final')

      // Source release: the checkout may leave only after the verified
      // snapshot. The branch is always retained.
      const released = await removeCheckoutFiles(record.repositoryRoot, record.checkoutPath)
      if (!released) {
        throw new WorktreeLifecycleError('LIFECYCLE_FAILED', 'The checkout could not be removed; it is still tracked and can be retried.')
      }
      this.deps.journal.step(journalEntry.journalId, 'checkout-removed')

      // Drop sessions being deleted from the owner set; owners of a manually
      // deleted worktree remain attached (fenced) until restore/permanent
      // delete resolves them.
      const remainingOwners = options.droppingSessions
        ? record.ownerSessionIds.filter((owner) => !options.droppingSessions!.includes(owner))
        : record.ownerSessionIds
      await this.deps.registry.runExclusive(async (tx) => {
        const current = tx.get(managedWorktreeId)
        if (!current) return
        current.ownerSessionIds = remainingOwners
        current.stateChangedAt = Date.now()
        tx.commit()
      })
      if (options.droppingSessions) {
        for (const sessionId of options.droppingSessions) this.deps.leases.releaseSession(sessionId)
      }
      await this.deps.applyOwnerSessionState?.(record.ownerSessionIds, {
        managedWorktreeId,
        state: 'snapshotted',
      })
      this.deps.journal.commit(journalEntry.journalId, 'registry-sessions-committed')
      return { ok: true, snapshotId: meta.snapshotId }
    } catch (error) {
      const sanitized = sanitizeError(error)
      this.deps.journal.fail(journalEntry.journalId, sanitized)
      await this.recordFailure(managedWorktreeId, 'cleanup-failed', sanitized)
      return { ok: false, result: { deleted: false, state: 'cleanup-failed', error: sanitized } }
    }
  }

  /**
   * Startup reconciliation of interrupted lifecycle transactions. Classifies
   * in-progress journal entries from registry/ref/path evidence and resumes
   * only idempotent safe work. Never infers successful deletion from a missing
   * path alone.
   */
  async reconcileJournal(): Promise<{ recovered: number; resumed: number }> {
    const report = { recovered: 0, resumed: 0 }
    const inProgress = this.deps.journal.inProgress()
    for (const entry of inProgress) {
      const record = this.getRecord(entry.recordId)
      const snapshotExists = record?.snapshot
        ? existsSync(join(record.snapshot.payloadPath, 'manifest.json'))
        : false
      const checkoutGone = record ? !existsSync(record.checkoutPath) : true
      const branchStillThere = record
        ? await this.refExists(record.repositoryRoot, `refs/heads/${record.expectedBranch}`)
        : false

      if (entry.op === 'delete' || entry.op === 'session-delete' || entry.op === 'cleanup') {
        if (record && record.state === 'snapshotting' && !entry.steps.includes('captured')) {
          // Capture never happened; the checkout is untouched. Revert to the
          // pre-transaction state: ready when owners remain, else unowned.
          const reverted: ManagedWorktreeRecordV2 = {
            ...record,
            state: record.ownerSessionIds.length > 0 ? 'ready' : 'unowned',
            lastError: 'Interrupted deletion was rolled back.',
            stateChangedAt: Date.now(),
          }
          this.deps.registry.upsert(reverted)
          this.deps.journal.recover(entry.journalId, 'rolled-back')
          report.recovered += 1
          continue
        }
        if (record && record.state === 'snapshotted' && snapshotExists && checkoutGone) {
          // Capture + removal completed; only the journal commit was lost.
          this.deps.journal.recover(entry.journalId, 'delete-completed')
          report.resumed += 1
          continue
        }
        if (record && record.state === 'snapshotted' && snapshotExists && !checkoutGone) {
          // Removal did not complete; resume it idempotently.
          const released = await removeCheckoutFiles(record.repositoryRoot, record.checkoutPath)
          if (released) {
            this.deps.journal.recover(entry.journalId, 'checkout-removed')
            report.resumed += 1
          } else {
            await this.recordFailure(record.managedWorktreeId, 'cleanup-failed', 'Interrupted deletion could not release the checkout.')
            this.deps.journal.recover(entry.journalId, 'cleanup-failed')
            report.recovered += 1
          }
          continue
        }
        if (!record && checkoutGone && !branchStillThere && entry.steps.includes('registry-snapshotted')) {
          // Record and checkout both gone after a committed deletion — a
          // missing-path classification, never proof of deletion by itself;
          // the journal step evidence makes it safe to mark resolved.
          this.deps.journal.recover(entry.journalId, 'delete-observed')
          report.recovered += 1
          continue
        }
        // Anything else stays in-progress for explicit recovery.
        continue
      }
      if (entry.op === 'restore') {
        if (record && record.state === 'ready' && entry.steps.includes('state-restored')) {
          // Restore completed through the registry commit; finish the journal.
          this.deps.journal.recover(entry.journalId, 'restore-completed')
          report.resumed += 1
          continue
        }
        if (record && record.state === 'restoring') {
          const reverted: ManagedWorktreeRecordV2 = {
            ...record,
            state: 'restore-failed',
            lastError: 'Interrupted restore; retry it.',
            stateChangedAt: Date.now(),
          }
          this.deps.registry.upsert(reverted)
          this.deps.journal.recover(entry.journalId, 'restore-interrupted')
          report.recovered += 1
        }
        continue
      }
      if (entry.op === 'permanent-delete') {
        if (!record && entry.steps.includes('payload-removed')) {
          this.deps.journal.recover(entry.journalId, 'permanent-delete-completed')
          report.resumed += 1
        }
        continue
      }
    }
    return report
  }

  private async refExists(repositoryRoot: string, ref: string): Promise<boolean> {
    try {
      const { runGit } = await import('./command-runner')
      const result = await runGit(['rev-parse', '--verify', '--quiet', ref], {
        cwd: repositoryRoot,
        okExitCodes: [1, 128],
      })
      return result.exitCode === 0
    } catch {
      return false
    }
  }
}
