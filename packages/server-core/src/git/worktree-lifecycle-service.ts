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
  'missing',
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
  /** Whether a pending/recovery handoff owns this canonical path. */
  isPathFenced?: (path: string) => boolean
  /** Persist owner-session recovery state before the journal commit marker. */
  applyOwnerSessionState?: (
    sessionIds: string[],
    record: { managedWorktreeId: string; state: ManagedWorktreeState; checkoutPath?: string },
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

  /** True while an archive/retention sweep is running (handoff blocker). */
  isCleanupInProgress(): boolean {
    return this.sweepRunning !== null
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
    isPathFenced?: WorktreeLifecycleDeps['isPathFenced']
    applyOwnerSessionState?: WorktreeLifecycleDeps['applyOwnerSessionState']
    touchSessionCheckout?: WorktreeLifecycleDeps['touchSessionCheckout']
  }): void {
    if (hooks.quiesceRuntimes) this.deps.quiesceRuntimes = hooks.quiesceRuntimes
    if (hooks.isSessionActive) this.deps.isSessionActive = hooks.isSessionActive
    if (hooks.isSessionFlagged) this.deps.isSessionFlagged = hooks.isSessionFlagged
    if (hooks.isPathFenced) this.deps.isPathFenced = hooks.isPathFenced
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
    // Fall back to the owner set: a restore moves the checkout to a new path
    // before the owner leases are rebound, so in that window the session's
    // lease still names the old path and the record must stay reachable for
    // detach and fencing decisions.
    for (const record of this.listRecords()) {
      if (record.ownerSessionIds.includes(sessionId)) {
        return { managedWorktreeId: record.managedWorktreeId, state: record.state }
      }
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
          counts.materialized += 1
          break
        case 'unowned':
          counts.materialized += 1
          counts.unowned += 1
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
    if (!DELETABLE_STATES.has(record.state)) {
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
    const outcome = await this.runRemovalTransaction(record, {
      expectedFingerprint: previewFingerprint,
      policyVersion: policy.version,
      journalOp: 'delete',
      requireQuiesce: true,
    })
    if (!outcome.ok) return outcome.result
    return { deleted: true, state: 'snapshotted', snapshotId: outcome.snapshotId }
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
      // The confirmed removal releases every owner lease and stamps their
      // sessions with the missing recovery state so the UI keeps showing the
      // stale checkout as unrecoverable instead of silently ready.
      for (const owner of record.ownerSessionIds) {
        this.deps.leases.releaseSession(owner)
      }
      await this.deps.applyOwnerSessionState?.(record.ownerSessionIds, {
        managedWorktreeId: record.managedWorktreeId,
        state: 'missing',
      })
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

    // One lifecycle scope: host lock → common-directory mutation lock (same
    // order as removal/creation), registry lock per state transition.
    return this.hostLock.run(() =>
      this.deps.mutationLock.withLock(record.gitCommonDir, async () => {
        const journalEntry = this.deps.journal.begin({
          op: 'restore',
          recordId: record.managedWorktreeId,
          sessionIds: record.ownerSessionIds,
          policyVersion: policy.version,
        })
        let committed = false
        try {
          this.deps.journal.step(journalEntry.journalId, 'locks-acquired')
          // Durable in-flight marker before any checkout mutation, so a crash
          // is classified as an interrupted restore, never a ready record.
          await this.deps.registry.runExclusive(async (tx) => {
            const current = tx.get(record.managedWorktreeId)
            if (!current || current.state !== record.state) {
              throw new WorktreeLifecycleError('LIFECYCLE_STATE_UNMANAGEABLE', 'The worktree state changed; re-inspect it.')
            }
            current.state = 'restoring'
            current.lastError = undefined
            current.stateChangedAt = Date.now()
            tx.commit()
          })
          this.deps.journal.step(journalEntry.journalId, 'registry-restoring')
          const destination = this.buildRestoreDestination(record)
          this.deps.journal.step(journalEntry.journalId, 'destination-validated')
          const restored = await this.deps.snapshots.restore({ record, meta, checkoutPath: destination })
          this.deps.journal.step(journalEntry.journalId, 'state-restored')

          // Commit #1: ready record + owner sessions through the journal. The
          // snapshot metadata is retained until the payload and hidden ref are
          // provably gone, so a post-commit failure can never orphan a
          // restorable payload behind a record that no longer references it.
          // Commit #1 applies only the fields this transaction owns; the owner
          // set and archive state come from the CURRENT registry record so a
          // concurrent owner change is never clobbered by a stale snapshot.
          await this.deps.registry.runExclusive(async (tx) => {
            const current = tx.get(record.managedWorktreeId)
            if (!current) throw new WorktreeLifecycleError('LIFECYCLE_RECORD_MISSING', 'The worktree record disappeared during restore.')
            current.state = 'ready'
            current.checkoutPath = restored.checkoutPath
            current.lastUsedAt = Date.now()
            current.lastError = undefined
            current.stateChangedAt = Date.now()
            tx.commit()
            committed = true
          })
          // Re-read the owner set under the registry lock immediately before
          // stamping: an owner may have detached while the restore awaited
          // snapshot I/O and must not be re-associated with the restored
          // checkout.
          let stampOwners: string[] = []
          await this.deps.registry.runExclusive(async (tx) => {
            const current = tx.get(record.managedWorktreeId)
            if (current) stampOwners = [...current.ownerSessionIds]
          })
          await this.deps.applyOwnerSessionState?.(stampOwners, {
            managedWorktreeId: record.managedWorktreeId,
            state: 'ready',
            checkoutPath: restored.checkoutPath,
          })
          // Re-lease every owner to the restored path so lifecycle decisions see
          // the full fence set at the live checkout. The owner set is observed
          // and the leases are moved under one registry-lock hold: a session
          // that detached during the session-stamping await needs the same
          // lock to commit, so it can never be leased back onto the restored
          // checkout after its detachment.
          await this.deps.registry.runExclusive(async (tx) => {
            const current = tx.get(record.managedWorktreeId)
            if (!current) return
            for (const owner of current.ownerSessionIds) {
              this.deps.leases.releaseSession(owner)
              this.deps.leases.lease(owner, restored.checkoutPath)
            }
          })
          this.deps.journal.commit(journalEntry.journalId, 'registry-sessions-committed')

          // Only after the commit: remove the payload and CAS-delete the ref.
          // A crash in this window is invisible to the journal (already
          // committed), so startup reconciliation also sweeps ready records
          // that still carry snapshot metadata.
          this.deps.snapshots.removePayload(meta)
          await this.deps.snapshots.casDeleteRef(record.repositoryRoot, meta)
          // Commit #2: drop the snapshot reference now that the payload and
          // hidden ref are provably gone. On failure the record stays `ready`
          // with snapshot metadata and startup reconciliation retries cleanup.
          try {
            await this.deps.registry.runExclusive(async (tx) => {
              const current = tx.get(record.managedWorktreeId)
              if (!current) return
              current.snapshot = undefined
              tx.commit()
            })
          } catch {
            /* reconciliation retries the snapshot cleanup */
          }
          return { restored: true, state: 'ready', checkoutPath: restored.checkoutPath }
        } catch (error) {
          const sanitized = sanitizeError(error)
          this.deps.journal.fail(journalEntry.journalId, sanitized)
          // Only THIS transaction's commit counts: a concurrent restore that
          // observed another restore's `ready` state must not claim success.
          if (!committed) {
            await this.recordFailure(record.managedWorktreeId, 'restore-failed', sanitized)
          }
          return { restored: committed, state: committed ? 'ready' : 'restore-failed', error: sanitized }
        }
      }),
    )
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
      // The snapshot exists (or not): the retry re-enters the FULL locked
      // transaction — host + common-directory mutation locks, path fences,
      // quiescence, and the stability fingerprint — so a checkout that changed
      // since the failed attempt is never released against stale evidence.
      const policy = this.deps.settings.getSnapshot()
      const outcome = await this.runRemovalTransaction(record, {
        expectedFingerprint: null,
        policyVersion: policy.version,
        journalOp: 'delete',
        requireQuiesce: true,
      })
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
    // Re-read inside the registry lock and mutate only the fields this method
    // owns so a concurrent owner bind, detach, or state transition is never
    // overwritten by a stale full-record spread.
    let result: WorktreeArchiveResult | undefined
    let cleanupEnqueued = false
    await this.deps.registry.runExclusive(async (tx) => {
      const current = tx.get(managedWorktreeId)
      if (!current) {
        throw new WorktreeLifecycleError('LIFECYCLE_RECORD_MISSING', 'The worktree record no longer exists.')
      }
      if (!current.ownerSessionIds.includes(sessionId)) {
        throw new WorktreeLifecycleError('LIFECYCLE_OWNERS_PRESENT', 'Only an owner session can archive or unarchive a worktree.')
      }
      const archivedOwners = new Set(current.archivedOwnerSessionIds ?? [])
      if (archived) archivedOwners.add(sessionId)
      else archivedOwners.delete(sessionId)
      current.archivedOwnerSessionIds = [...archivedOwners]
      if (!archived) current.lastUsedAt = Date.now()
      current.stateChangedAt = Date.now()
      tx.commit()
      const allArchived = current.ownerSessionIds.every((owner) => archivedOwners.has(owner))
      const anyProtected = current.ownerSessionIds.some(
        (owner) => (this.deps.isSessionActive?.(owner) ?? false) || (this.deps.isSessionFlagged?.(owner) ?? false),
      )
      cleanupEnqueued = archived && allArchived && !anyProtected
      result = { archived, state: current.state, cleanupEnqueued }
    })
    if (cleanupEnqueued) {
      await this.enqueueCleanup()
    }
    return result!
  }

  /**
   * Plain session deletion: remove one owner. Remaining owners and the
   * checkout survive. Final-owner deletion leaves an unowned record and
   * enqueues policy cleanup.
   */
  async detachSession(sessionId: string): Promise<void> {
    const { managedWorktreeId } = this.recordStateForSession(sessionId)
    if (!managedWorktreeId) return
    let remainingCount = 0
    await this.deps.registry.runExclusive(async (tx) => {
      const current = tx.get(managedWorktreeId)
      if (!current) return
      current.ownerSessionIds = current.ownerSessionIds.filter((owner) => owner !== sessionId)
      current.archivedOwnerSessionIds = (current.archivedOwnerSessionIds ?? []).filter((owner) => owner !== sessionId)
      if (current.ownerSessionIds.length === 0) current.state = 'unowned'
      current.stateChangedAt = Date.now()
      remainingCount = current.ownerSessionIds.length
      tx.commit()
    })
    this.deps.leases.releaseSession(sessionId)
    if (remainingCount === 0) {
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
    const outcome = await this.runRemovalTransaction(record, {
      expectedFingerprint: null,
      policyVersion: policy.version,
      journalOp: 'session-delete',
      requireQuiesce: false,
      droppingSessions: [input.sessionId],
    })
    if (!outcome.ok) return { outcome: 'blocked', reason: outcome.result.error ?? 'Removal failed.', reasonCode: 'agent_not_quiesced' }
    return { outcome: 'removed' }
  }

  // -------------------------------------------------------------------------
  // Automatic cleanup (archive + retention)
  // -------------------------------------------------------------------------

  /**
   * Coalescing enqueue: one sweep runs at a time; callers await the sweep that
   * covers their enqueue. The finally-chain resets the slot only when the
   * original sweep settles, so later events always start a fresh sweep. An
   * enqueue while a sweep is running is answered by a follow-up sweep that
   * starts once the running one settles, so its candidate is actually covered.
   */
  enqueueCleanup(): Promise<WorktreeCleanupResult> {
    const running = this.sweepRunning
    if (!running) {
      const sweep = this.runCleanupSweep()
      // The slot holds the raw sweep promise; a side-chain clears the slot when
      // THAT sweep settles, so the comparison can never miss.
      this.sweepRunning = sweep
      void sweep
        .finally(() => {
          if (this.sweepRunning === sweep) this.sweepRunning = null
        })
        .catch(() => undefined)
      return sweep
    }
    // The in-flight sweep already selected its candidates, so it cannot cover
    // a candidate that became eligible after it started. Chain a follow-up
    // sweep; concurrent enqueuers all await the same follow-up.
    return running.then(
      () => this.scheduleFollowUpSweep(running),
      () => this.scheduleFollowUpSweep(running),
    )
  }

  private scheduleFollowUpSweep(running: Promise<WorktreeCleanupResult>): Promise<WorktreeCleanupResult> {
    if (this.sweepRunning && this.sweepRunning !== running) return this.sweepRunning
    const sweep = this.runCleanupSweep()
    this.sweepRunning = sweep
    void sweep
      .finally(() => {
        if (this.sweepRunning === sweep) this.sweepRunning = null
      })
      .catch(() => undefined)
    return sweep
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
    // One attempt per candidate per sweep. The loop continues until no
    // candidate succeeds, so a sweep that removes one worktree keeps removing
    // the remaining surplus until the retention limit is satisfied.
    const attempted = new Set<string>()
    const failures: string[] = []
    let removedCount = 0
    let lastRemovedId: string | undefined

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
          removedCount += 1
          lastRemovedId = record.managedWorktreeId
          continue
        }
        if (outcome.result.error) failures.push(outcome.result.error)
      } catch (error) {
        failures.push(sanitizeError(error))
      }
    }

    if (removedCount > 0) {
      const result: WorktreeCleanupResult = {
        at: Date.now(),
        outcome: 'succeeded',
        policyVersion: startedPolicyVersion,
        removedWorktreeId: lastRemovedId,
      }
      this.writeCleanupState({ lastCleanupResult: result })
      return result
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
      await this.deps.registry.runExclusive(async (tx) => {
        const current = tx.get(managedWorktreeId)
        if (!current) return
        current.state = state
        current.lastError = sanitized
        current.stateChangedAt = Date.now()
        tx.commit()
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
    // Every destructive transaction enters one lifecycle scope: the host
    // lifecycle lock (per server), then the common-directory mutation lock, and
    // the registry lock per state transition — in the same order creation uses
    // (mutation → registry), so no lock cycle is possible.
    return this.hostLock.run(() =>
      this.deps.mutationLock.withLock(record.gitCommonDir, () =>
        this.runRemovalTransactionLocked(record, options),
      ),
    )
  }

  private async runRemovalTransactionLocked(
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

      // Handoff owns a stronger transaction fence than ordinary lifecycle
      // ownership. Cleanup must never race a pending/recovery checkout move.
      if (this.deps.isPathFenced?.(record.checkoutPath)) {
        return fail('LIFECYCLE_FOREIGN_LEASE', 'A checkout handoff owns this path; retry after it commits or recovers.')
      }

      // Path fences: every canonical checkout path must be leased only by the
      // transaction's owner set (sessions not yet in the registry still hold
      // leases and protect their checkout).
      const foreignLeases = this.deps.leases.leasedBy(record.checkoutPath).filter((sessionId) => !ownerSet.has(sessionId))
      if (foreignLeases.length > 0) {
        return fail('LIFECYCLE_FOREIGN_LEASE', `Another session (${foreignLeases.join(', ')}) is using this checkout path.`)
      }

      // Runtime quiescence: every owning runtime must stop before capture.
      // A flagged owner protects the worktree even when its runtime would
      // quiesce — flag state is deliberately not part of the fingerprint
      // (it changes dynamically), so the protection is enforced here.
      const protectedOwner = record.ownerSessionIds.find(
        (owner) =>
          (this.deps.isSessionActive?.(owner) ?? false) || (this.deps.isSessionFlagged?.(owner) ?? false),
      )
      if (protectedOwner) {
        return fail(
          'LIFECYCLE_OWNERS_PRESENT',
          `Session ${protectedOwner} is ${this.deps.isSessionActive?.(protectedOwner) ? 'active' : 'flagged'} and cannot be interrupted.`,
        )
      }
      if (options.requireQuiesce) {
        const quiesced = this.deps.quiesceRuntimes ? await this.deps.quiesceRuntimes(record.ownerSessionIds) : true
        if (!quiesced) {
          return fail('LIFECYCLE_NOT_QUIESCED', 'An owning agent runtime could not be quiesced.')
        }
      }
      this.deps.journal.step(journalEntry.journalId, 'quiesced')

      // A verified snapshot may already exist (retry after a failed release).
      // Verify it FIRST: its captured fingerprint replaces the pre-capture
      // inspection, and a partially released checkout has no computable
      // working-tree fingerprint at all.
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

      // Revalidate the fingerprint immediately before capture. Automatic and
      // session-delete transactions have no client confirmation, so a stable
      // pre-capture fingerprint is recorded and rechecked after capture.
      let stabilityFingerprint: string | null = null
      if (!meta) {
        if (options.expectedFingerprint) {
          const fresh = await this.deps.snapshots.recomputeFingerprint(record, options.policyVersion)
          if (fresh !== options.expectedFingerprint) {
            return fail('LIFECYCLE_PREVIEW_STALE', 'The worktree changed after the confirmation; inspect it again.')
          }
        } else {
          stabilityFingerprint = await this.deps.snapshots.recomputeFingerprint(record, options.policyVersion)
        }
      } else {
        // Retry path: if the checkout is still fully inspectable it must be
        // byte-identical to what the snapshot captured; if it is no longer a
        // usable worktree the release already began and there is nothing left
        // to protect, so the verified snapshot governs.
        try {
          const current = await this.deps.snapshots.recomputeFingerprint(record, options.policyVersion)
          if (current !== meta.fingerprint) {
            return fail(
              'LIFECYCLE_PREVIEW_STALE',
              'The checkout changed after its snapshot was captured; restore it and inspect it again.',
            )
          }
        } catch {
          /* partially released checkout: the verified snapshot governs */
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
      if (!meta) {
        const finalFingerprint = await this.deps.snapshots.recomputeFingerprint(record, options.policyVersion)
        const captured = await this.deps.snapshots.capture({
          record: { ...record, state: 'snapshotting' },
          finalFingerprint,
          previewFingerprint: options.expectedFingerprint ?? stabilityFingerprint ?? finalFingerprint,
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
        const finalFingerprint = await this.deps.snapshots.recomputeFingerprint(record, options.policyVersion)
        if (finalFingerprint !== options.expectedFingerprint) {
          throw new WorktreeLifecycleError('LIFECYCLE_PREVIEW_STALE', 'The worktree changed during capture; nothing was removed.')
        }
      } else if (stabilityFingerprint) {
        // Automatic/session-delete transactions have no client confirmation:
        // the checkout must be byte-identical to the pre-capture inspection.
        const finalFingerprint = await this.deps.snapshots.recomputeFingerprint(record, options.policyVersion)
        if (finalFingerprint !== stabilityFingerprint) {
          throw new WorktreeLifecycleError(
            'LIFECYCLE_PREVIEW_STALE',
            'The worktree changed while it was being captured; nothing was removed.',
          )
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

      // Drop sessions being deleted from the owner set. The owner set is
      // re-read under the registry lock: the record was not `ready` throughout
      // the transaction, so no new owner can have bound since the snapshot was
      // taken, but the write must never overwrite a fresher set.
      await this.deps.registry.runExclusive(async (tx) => {
        const current = tx.get(managedWorktreeId)
        if (!current) return
        const dropping = new Set(options.droppingSessions ?? [])
        current.ownerSessionIds = current.ownerSessionIds.filter((owner) => !dropping.has(owner))
        current.stateChangedAt = Date.now()
        tx.commit()
      })
      if (options.droppingSessions) {
        for (const sessionId of options.droppingSessions) this.deps.leases.releaseSession(sessionId)
      }
      // Stamp only the remaining owners: the dropped sessions are mid-deletion
      // with their storage staged away, and persisting them would recreate the
      // session at its original path.
      const remainingOwners = record.ownerSessionIds.filter(
        (owner) => !(options.droppingSessions ?? []).includes(owner),
      )
      await this.deps.applyOwnerSessionState?.(remainingOwners, {
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
    // Markers left by a crashed process would otherwise fence every destructive
    // transaction on that checkout as a foreign lease.
    this.deps.leases.pruneStale()
    await this.cleanupPendingRestores(report)
    await this.gcOrphanedSnapshots(report)
    const inProgress = this.deps.journal.inProgress()
    for (const entry of inProgress) {
      const record = this.getRecord(entry.recordId)
      let snapshotVerified = false
      let refVerified = false
      if (record?.snapshot) {
        try {
          this.deps.snapshots.verifyPayload(record.snapshot)
          snapshotVerified = true
        } catch {
          snapshotVerified = false
        }
        try {
          await this.deps.snapshots.verifyHiddenRef(record.repositoryRoot, record.snapshot)
          refVerified = true
        } catch {
          refVerified = false
        }
      }
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
        if (record && record.state === 'snapshotted' && snapshotVerified && refVerified && checkoutGone) {
          // Capture + removal completed; only the journal commit was lost.
          this.deps.journal.recover(entry.journalId, 'delete-completed')
          report.resumed += 1
          continue
        }
        if (record && record.state === 'snapshotted' && snapshotVerified && !checkoutGone) {
          // Removal did not complete; resume it idempotently. The hidden ref
          // pins the captured HEAD, so releasing the checkout is safe.
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
          // Restore completed through the registry commit; finish the journal
          // and clean up the retained snapshot (payload + hidden ref) if the
          // post-commit cleanup never ran.
          if (record.snapshot) {
            try {
              this.deps.snapshots.removePayload(record.snapshot)
              await this.deps.snapshots.casDeleteRef(record.repositoryRoot, record.snapshot)
              const cleared = this.getRecord(record.managedWorktreeId)
              if (cleared?.snapshot) {
                const next: ManagedWorktreeRecordV2 = { ...cleared, snapshot: undefined }
                this.deps.registry.upsert(next)
              }
            } catch {
              /* retained for a later retry; the record stays ready */
            }
          }
          this.deps.journal.recover(entry.journalId, 'restore-completed')
          report.resumed += 1
          continue
        }
        if (record && (record.state === 'restoring' || record.state === 'restore-failed')) {
          // Interrupted restore: the snapshot is intact and the attempt-created
          // artifacts were already removed by the restore compensation. Keep
          // the payload/ref and mark the step failed for an explicit retry.
          if (record.state === 'restoring') {
            const reverted: ManagedWorktreeRecordV2 = {
              ...record,
              state: 'restore-failed',
              lastError: 'Interrupted restore; retry it.',
              stateChangedAt: Date.now(),
            }
            this.deps.registry.upsert(reverted)
          }
          this.deps.journal.recover(entry.journalId, 'restore-interrupted')
          report.recovered += 1
        }
        continue
      }
      if (entry.op === 'permanent-delete') {
        if (record && entry.steps.includes('payload-removed')) {
          // The payload and hidden ref are gone; only the record removal is
          // pending. Complete it with the journal evidence.
          this.deps.registry.remove(entry.recordId)
          this.deps.journal.recover(entry.journalId, 'permanent-delete-completed')
          report.resumed += 1
        } else if (!record && entry.steps.includes('payload-removed')) {
          this.deps.journal.recover(entry.journalId, 'permanent-delete-completed')
          report.resumed += 1
        }
        continue
      }
    }
    return report
  }

  /**
   * Finish restore payload cleanup for records that committed as `ready` but
   * still carry snapshot metadata (a crash between the journal commit and the
   * payload/ref removal). Idempotent: verification precedes every deletion.
   */
  private async cleanupPendingRestores(report: { recovered: number; resumed: number }): Promise<void> {
    await this.hostLock.run(async () => {
      for (const record of this.listRecords()) {
        if (record.state !== 'ready' || !record.snapshot) continue
        try {
          this.deps.snapshots.verifyPayload(record.snapshot)
          this.deps.snapshots.removePayload(record.snapshot)
          await this.deps.snapshots.casDeleteRef(record.repositoryRoot, record.snapshot)
          const current = this.getRecord(record.managedWorktreeId)
          if (current?.snapshot) {
            const next: ManagedWorktreeRecordV2 = { ...current, snapshot: undefined }
            this.deps.registry.upsert(next)
          }
          report.resumed += 1
        } catch {
          // Unverifiable payloads are retained for explicit recovery.
        }
      }
    })
  }

  /**
   * Remove snapshot payloads no record references and stale capture staging
   * directories. A crash between atomic publish and the journal/registry
   * evidence leaves such an orphan; the hidden ref (if any) is CAS-deleted with
   * the captured OID from the manifest. Never touches referenced payloads.
   */
  private async gcOrphanedSnapshots(report: { recovered: number; resumed: number }): Promise<void> {
    // Cross-process: another server process may be mid-transaction on the same
    // snapshot root, so the host lifecycle lock fences the sweep.
    await this.hostLock.run(async () => {
      let entries: string[]
      try {
        const { readdirSync } = await import('node:fs')
        entries = readdirSync(this.deps.snapshots.getSnapshotsRoot())
      } catch {
        return
      }
      const referenced = new Set(
        this.listRecords()
          .map((record) => record.snapshot?.snapshotId)
          .filter((id): id is string => !!id),
      )
      // A pending/failed handoff retains its snapshot as the recovery
      // authority even after the managed source record was removed
      // (managed-to-current release). Never GC a payload recovery needs.
      // A pending/failed fork retains its seed the same way: the confirm
      // journal records the seed id immediately after capture, and an
      // interrupted confirm must still be able to restore the target from it.
      for (const entry of this.deps.journal.entries()) {
        if (entry.status !== 'in-progress' && entry.status !== 'failed') continue
        if (entry.op === 'handoff') {
          const retained = entry.metadata?.retainedSnapshotId
          if (typeof retained === 'string' && retained) referenced.add(retained)
        } else if (entry.op === 'fork') {
          const seed = entry.metadata?.seedSnapshotId
          if (typeof seed === 'string' && seed) referenced.add(seed)
        }
      }
      for (const name of entries) {
        if (name.startsWith('.tmp-')) {
          // Owner-only capture staging; never referenced by any record. Hidden
          // refs created before a crash stay until their repository is known;
          // they are inert in the refs/kata namespace.
          this.deps.snapshots.removeStagingDir(name)
          report.recovered += 1
          continue
        }
        if (referenced.has(name)) continue
        // No record references this payload: it can never be restored and no
        // rollback can resurrect it. Removing it is safe server-local cleanup.
        this.deps.snapshots.removePayload({
          payloadPath: join(this.deps.snapshots.getSnapshotsRoot(), name),
        } as ManagedWorktreeSnapshotMeta)
        report.recovered += 1
      }
    })
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
