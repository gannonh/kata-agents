/**
 * WorktreeHandoffService — conflict-safe checkout handoff (Worktree V2 Phase 3).
 *
 * Handoff moves a single-owner idle session and its exact supported Git work
 * state between a managed worktree and the repository's registered current
 * checkout without overwriting destination work or breaking provider
 * conversation continuity.
 *
 * Three directions (spec: same-repository, single-owner):
 *
 *  - `current-to-managed`: snapshot the current checkout, create
 *    `kata-agent/<name>` at source HEAD, restore/verify the unoccupied
 *    managed target, remove only captured state from current, commit the
 *    session to the target execution CWD. Destination verification precedes
 *    source cleanup (destination-authoritative).
 *  - `managed-to-current`: snapshot/verify the managed source, release it
 *    (Git cannot check out one branch twice), switch current to the branch,
 *    restore/verify, commit. The retained snapshot is the rollback authority
 *    (source-authoritative); destination-first verification is impossible.
 *  - `hand-back`: snapshot current, remove captured transferable state,
 *    restore the recorded return ref to free the branch, materialize/restore/
 *    verify the managed target, commit.
 *
 * Preview is side-effect free beyond registering an in-memory transaction:
 * it binds every decision-relevant fact into `previewFingerprint` and returns
 * a typed blocker instead of mutating when any precondition fails. Confirm
 * revalidates the fingerprint under the common-directory lock and journals
 * every idempotent step; the durable session binding changes only at the
 * commit point, and the immutable transcript CWD never changes.
 */

import { existsSync, lstatSync, readFileSync, rmSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import type {
  SessionCheckout,
  SessionCheckoutV2,
  WorktreeHandoffBlockerCode,
  WorktreeHandoffCleanupSummary,
  WorktreeHandoffConfirmInput,
  WorktreeHandoffDirection,
  WorktreeHandoffIncludeConflict,
  WorktreeHandoffPreview,
  WorktreeHandoffPreviewInput,
  WorktreeHandoffProviderCapability,
  WorktreeHandoffRecoveryBehavior,
  WorktreeHandoffRecoverInput,
  WorktreeHandoffRecoveryState,
  WorktreeHandoffResult,
  WorktreeHandoffReturnRef,
  WorktreeHandoffStatus,
} from '@kata-sh/shared/protocol'
import { isGitWorkspaceV1Enabled, isWorktreeV2Enabled } from '@kata-sh/shared/feature-flags'
import type { ExecutionCwdProof, ExecutionCwdRebindCapability } from '@kata-sh/shared/agent/backend'
import type { WorktreeRegistry } from './worktree-registry'
import type { WorktreeSnapshotManifest, WorktreeSnapshotService } from './worktree-snapshot-service'
import { computeWorktreeFingerprint } from './worktree-snapshot-service'
import { WorktreeSnapshotError as SnapshotError } from './worktree-snapshot-service'
import { removeCheckoutFiles, type ManagedWorktreeService } from './managed-worktree-service'
import type { MutationLock } from './mutation-lock'
import type { PathLeaseManager } from './path-leases'
import type { WorktreeJournal } from './worktree-journal'
import type { WorktreeLifecycleService } from './worktree-lifecycle-service'
import type { RepositoryService } from './repository-service'
import type { WorktreeSettingsService } from './worktree-settings-service'
import { listWorktreeIncludeFiles } from './worktree-include'
import { runGit, runGitBuffer, splitNul } from './command-runner'

export type WorktreeHandoffErrorCode =
  | 'HANDOFF_SESSION_UNKNOWN'
  | 'HANDOFF_TRANSACTION_UNKNOWN'
  | 'HANDOFF_DIRECTION_MISMATCH'
  | 'HANDOFF_NOT_IMPLEMENTED'

export class WorktreeHandoffError extends Error {
  readonly code: WorktreeHandoffErrorCode
  constructor(code: WorktreeHandoffErrorCode, message: string) {
    super(message)
    this.name = 'WorktreeHandoffError'
    this.code = code
  }
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  // Strip POSIX and Windows absolute path tokens; server layout never crosses
  // the wire. Keep a bounded diagnostic rather than returning raw exceptions.
  return message
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|\/)[^\s'"`]+/g, '…')
    .slice(0, 500)
}

/** Session facts the host supplies for one handoff evaluation. */
export interface HandoffSessionInfo {
  /** The session's active checkout path (never client-nominated). */
  checkoutPath: string
  workspaceId: string
  /** Persisted checkout metadata (null for legacy/current sessions). */
  checkout: SessionCheckout | null
  /** Immutable transcript CWD (session.sdkCwd) — never changed by handoff. */
  transcriptCwd: string
}

/** The durable session binding committed at the handoff commit point. */
export interface HandoffBindingCommit {
  sessionId: string
  checkout: SessionCheckout
  /** Destination execution CWD the runtime must resolve before Send unlocks. */
  executionCwd: string
}

export interface WorktreeHandoffHooks {
  /** Resolve persisted session facts; null for an unknown session. */
  resolveSession?: (sessionId: string) => HandoffSessionInfo | null
  /** Resolve the provider adapter's advertised handoff capability. */
  resolveCapability?: (sessionId: string) => WorktreeHandoffProviderCapability | null
  /** Resolve the live adapter used for rebind + execution-CWD proof. */
  resolveCapabilityAdapter?: (sessionId: string) => ExecutionCwdRebindCapability | null
  /** Whether a session is running an agent turn. */
  isSessionActive?: (sessionId: string) => boolean
  /** Quiesce the session's runtime; false when it cannot quiesce. */
  quiesceRuntimes?: (sessionIds: string[]) => Promise<boolean>
  /** Commit the durable session binding (checkout + execution CWD). */
  commitSessionBinding?: (input: HandoffBindingCommit) => Promise<void> | void
}

export interface WorktreeHandoffDeps {
  registry: WorktreeRegistry
  snapshots: WorktreeSnapshotService
  worktrees: ManagedWorktreeService
  mutationLock: MutationLock
  leases: PathLeaseManager
  journal: WorktreeJournal
  lifecycle: WorktreeLifecycleService
  repository: RepositoryService
  settings: WorktreeSettingsService
  /** Stable server identity stamped into previews. */
  serverId: string
  hooks?: WorktreeHandoffHooks
}

/** One in-flight handoff transaction (preview → confirm/recover). */
interface HandoffTransaction {
  transactionId: string
  sessionId: string
  direction: WorktreeHandoffDirection
  state: WorktreeHandoffRecoveryState
  fingerprint: string
  /** Generated/edited name for the new managed worktree. */
  nameSuffix?: string
  /** Pre-issued path token pinning the destination path from the preview. */
  pathToken?: string
  returnRef?: WorktreeHandoffReturnRef
  retainedSnapshotId?: string
  managedWorktreeId?: string
  sourcePath: string
  destinationPath: string
  repositoryRoot: string
  gitCommonDir: string
  /** Branch the new/existing managed worktree carries. */
  expectedBranch: string
  /** Idempotent steps completed so far, in order. */
  steps: string[]
  /** Durable journal identity. */
  journalId: string
  providerCapability?: WorktreeHandoffProviderCapability
  transcriptCwd?: string
  sourceLeases: string[]
  destinationLeases: string[]
  runtimeProof?: ExecutionCwdProof
  /** Exact include matches observed at capture; cleanup must not recompute them. */
  capturedIncludedFiles?: string[]
  startedAt: number
}

function newTransactionId(): string {
  return randomBytes(8).toString('hex')
}

function newPathToken(): string {
  return randomBytes(4).toString('hex')
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function lstatSyncSafe(path: string): 'symlink' | 'other' | null {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) return 'symlink'
    return 'other'
  } catch {
    return null
  }
}

function isContainedPath(parent: string, child: string): boolean {
  const rel = relative(resolvePath(parent), resolvePath(child))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** True when a porcelain worktree list checks out exactly `branch`. */
function branchCheckedOutInWorktree(porcelain: string, branch: string): boolean {
  const expected = `branch refs/heads/${branch}`
  return porcelain.split('\n').some((line) => line.trim() === expected)
}

const HANDOFF_RECOVERY_STATES = new Set<WorktreeHandoffRecoveryState>([
  'pending', 'quiesced', 'snapshotted', 'source-released', 'target-created',
  'branch-switched', 'binding-committed', 'runtime-rebuilding', 'restore-failed',
  'cleanup-failed', 'recovery-required',
])

export class WorktreeHandoffService {
  private readonly deps: WorktreeHandoffDeps
  private readonly transactions = new Map<string, HandoffTransaction>()
  private previewSerial: Promise<void> = Promise.resolve()

  constructor(deps: WorktreeHandoffDeps) {
    this.deps = deps
    this.restoreJournalTransactions()
  }

  /** Install runtime/session hooks late (the host wires them after construction). */
  setHooks(hooks: WorktreeHandoffHooks): void {
    this.deps.hooks = { ...this.deps.hooks, ...hooks }
  }

  private get hooks(): WorktreeHandoffHooks {
    return this.deps.hooks ?? {}
  }

  // -------------------------------------------------------------------------
  // Preview
  // -------------------------------------------------------------------------

  async preview(input: WorktreeHandoffPreviewInput): Promise<WorktreeHandoffPreview> {
    let release!: () => void
    const previous = this.previewSerial
    this.previewSerial = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      return await this.previewInternal(input)
    } finally {
      release()
    }
  }

  private async previewInternal(input: WorktreeHandoffPreviewInput): Promise<WorktreeHandoffPreview> {
    const session = this.hooks.resolveSession?.(input.sessionId)
    if (!session) {
      throw new WorktreeHandoffError('HANDOFF_SESSION_UNKNOWN', 'Unknown session for handoff preview.')
    }
    const capability = this.hooks.resolveCapability?.(input.sessionId) ?? null
    const facts = await this.gatherFacts(input, session, capability)
    const blocked = facts.blocker
      ? { blocked: true as const, code: facts.blocker, reason: facts.blockerReason ?? '' }
      : undefined

    let preview: WorktreeHandoffPreview
    if (blocked) {
      preview = {
        transactionId: newTransactionId(),
        previewFingerprint: sha256(JSON.stringify({ blocked: facts.blocker, at: facts.source.checkoutPath })),
        direction: input.direction,
        providerCapability: capability ?? { adapterId: 'unknown', executionCwdRebindable: false },
        source: facts.source,
        destination: facts.destination,
        includeCopyConflicts: [],
        excludedIgnoredPolicy: { includeOnly: true, includeFileCount: facts.included.length },
        cleanup: facts.cleanup,
        ...(facts.returnRef ? { returnRef: facts.returnRef } : {}),
        recoveryBehavior: facts.recoveryBehavior,
        blocked,
      }
      return preview
    }

    const transactionId = newTransactionId()
    const fingerprint = await this.computeFingerprint(input.sessionId, input.direction, session, facts, capability!, transactionId)
    preview = {
      transactionId,
      previewFingerprint: fingerprint,
      direction: input.direction,
      providerCapability: capability!,
      source: facts.source,
      destination: facts.destination,
      includeCopyConflicts: facts.includeConflicts,
      excludedIgnoredPolicy: { includeOnly: true, includeFileCount: facts.included.length },
      cleanup: facts.cleanup,
      ...(facts.returnRef ? { returnRef: facts.returnRef } : {}),
      recoveryBehavior: facts.recoveryBehavior,
    }
    return this.deps.registry.runExclusive(async () => {
      const existingJournal = this.deps.journal.inProgress().find(
        (entry) => entry.op === 'handoff' && entry.sessionIds.includes(input.sessionId),
      )
      if (existingJournal) {
        return {
          ...preview,
          previewFingerprint: sha256(JSON.stringify({ blocked: 'handoff-in-progress', sessionId: input.sessionId })),
          blocked: {
            blocked: true,
            code: 'handoff-in-progress' as const,
            reason: 'A handoff transaction is already in progress for this session.',
          },
        }
      }
      const transaction: HandoffTransaction = {
        transactionId,
        sessionId: input.sessionId,
        direction: input.direction,
        state: 'pending',
        fingerprint,
        nameSuffix: facts.nameSuffix,
        pathToken: facts.pathToken,
        returnRef: facts.returnRef,
        managedWorktreeId: facts.managedWorktreeId,
        sourcePath: facts.source.checkoutPath,
        destinationPath: facts.destination.checkoutPath,
        repositoryRoot: facts.repositoryRoot,
        gitCommonDir: facts.gitCommonDir,
        expectedBranch: facts.expectedBranch,
        steps: [],
        journalId: '',
        providerCapability: capability ?? undefined,
        transcriptCwd: session.transcriptCwd,
        sourceLeases: [...facts.source.leases],
        destinationLeases: [...facts.destination.leases],
        startedAt: Date.now(),
      }
      const journal = this.deps.journal.begin({
        op: 'handoff',
        recordId: transactionId,
        sessionIds: [input.sessionId],
        policyVersion: this.deps.settings.getSnapshot(this.deps.serverId).version,
        metadata: this.transactionMetadata(transaction),
      })
      transaction.journalId = journal.journalId
      this.transactions.set(input.sessionId, transaction)
      return preview
    })
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  /** True while a pending/recovery handoff owns a session fence. */
  isSessionFenced(sessionId: string): boolean {
    return this.transactions.has(sessionId)
  }

  /** True while a pending/recovery handoff owns a canonical path fence. */
  isPathFenced(path: string): boolean {
    const canonical = resolvePath(path)
    for (const txn of this.transactions.values()) {
      if (resolvePath(txn.sourcePath) === canonical || resolvePath(txn.destinationPath) === canonical) return true
    }
    return false
  }

  async status(sessionId: string): Promise<WorktreeHandoffStatus> {
    const txn = this.transactions.get(sessionId)
    if (!txn) return { active: false }
    return {
      active: true,
      transactionId: txn.transactionId,
      direction: txn.direction,
      state: txn.state,
      ...(txn.retainedSnapshotId ? { retainedSnapshotId: txn.retainedSnapshotId } : {}),
      since: txn.startedAt,
    }
  }

  // -------------------------------------------------------------------------
  // Confirm
  // -------------------------------------------------------------------------

  async confirm(input: WorktreeHandoffConfirmInput): Promise<WorktreeHandoffResult> {
    const txn = this.transactions.get(input.sessionId)
    if (!txn || txn.transactionId !== input.transactionId) {
      throw new WorktreeHandoffError('HANDOFF_TRANSACTION_UNKNOWN', 'Unknown handoff transaction.')
    }
    if (txn.direction !== input.direction) {
      throw new WorktreeHandoffError('HANDOFF_DIRECTION_MISMATCH', 'Handoff direction does not match the transaction.')
    }
    const session = this.hooks.resolveSession?.(input.sessionId)
    if (!session) throw new WorktreeHandoffError('HANDOFF_SESSION_UNKNOWN', 'Unknown session for handoff confirmation.')
    const capability = this.hooks.resolveCapability?.(input.sessionId) ?? null
    if (!capability || capability.executionCwdRebindable !== true) {
      this.deps.journal.fail(txn.journalId, 'The provider adapter cannot safely rebind its execution CWD.')
      this.transactions.delete(input.sessionId)
      return this.blockedResult(txn, 'unsupported-provider', 'The provider adapter cannot safely rebind its execution CWD.')
    }
    if (!this.hooks.resolveCapabilityAdapter?.(input.sessionId) || !this.hooks.commitSessionBinding) {
      this.deps.journal.fail(txn.journalId, 'Handoff runtime or durable session binding is not wired.')
      this.transactions.delete(input.sessionId)
      throw new WorktreeHandoffError(
        'HANDOFF_NOT_IMPLEMENTED',
        'Handoff requires a live runtime rebind and durable session-binding host.',
      )
    }

    if (txn.direction === 'managed-to-current') {
      return this.confirmManagedToCurrent(txn, input, session, capability)
    }
    if (txn.direction === 'hand-back') {
      return this.confirmHandBack(txn, input, session, capability)
    }

    return this.deps.mutationLock.withLock<WorktreeHandoffResult>(txn.gitCommonDir, async () => {
      const facts = await this.gatherFacts(
        {
          sessionId: input.sessionId,
          direction: txn.direction,
          worktreeNameSuffix: txn.nameSuffix,
        },
        session,
        capability,
        txn.transactionId,
      )
      if (facts.blocker) {
        this.deps.journal.fail(txn.journalId, facts.blockerReason ?? 'Handoff precondition failed.')
        this.transactions.delete(input.sessionId)
        return this.blockedResult(txn, facts.blocker, facts.blockerReason ?? 'Handoff precondition failed.')
      }
      const freshFingerprint = await this.computeFingerprint(
        input.sessionId,
        txn.direction,
        session,
        facts,
        capability,
        txn.transactionId,
      )
      if (freshFingerprint !== txn.fingerprint || input.previewFingerprint !== txn.fingerprint) {
        this.deps.journal.fail(txn.journalId, 'The checkout changed after the preview.')
        this.transactions.delete(input.sessionId)
        return this.blockedResult(txn, 'identity-drift', 'The checkout changed after the preview; inspect it again.')
      }

      const journalId = txn.journalId || this.deps.journal.begin({
        op: 'handoff',
        recordId: txn.transactionId,
        sessionIds: [input.sessionId],
        policyVersion: this.deps.settings.getSnapshot(this.deps.serverId).version,
        metadata: this.transactionMetadata(txn),
      }).journalId
      txn.journalId = journalId
      txn.steps.push('locks-acquired')
      this.deps.journal.step(journalId, 'locks-acquired')
      let transactionLeaseId: string | null = null
      try {
        if (this.hooks.isSessionActive?.(input.sessionId)) {
          this.deps.journal.fail(journalId, 'The session runtime is active.')
          this.transactions.delete(input.sessionId)
          return this.blockedResult(txn, 'runtime-active', 'The session runtime could not be quiesced.')
        }
        const quiesced = this.hooks.quiesceRuntimes ? await this.hooks.quiesceRuntimes([input.sessionId]) : true
        if (!quiesced) {
          this.deps.journal.fail(journalId, 'The session runtime could not be quiesced.')
          this.transactions.delete(input.sessionId)
          return this.blockedResult(txn, 'runtime-active', 'The session runtime could not be quiesced.')
        }
        txn.state = 'quiesced'
        txn.steps.push('quiesced')
        this.deps.journal.step(journalId, 'quiesced')

        const sourceBranch = facts.source.branch
        if (!sourceBranch) {
          this.deps.journal.fail(journalId, 'The current checkout is detached.')
          this.transactions.delete(input.sessionId)
          return this.blockedResult(txn, 'unsupported-snapshot', 'A detached current checkout cannot be captured for this handoff.')
        }
        const settings = this.deps.settings.getSnapshot(this.deps.serverId)
        const sourceRecord = this.currentSnapshotRecord(input.sessionId, session, facts, sourceBranch, settings.version, settings.materializationRoot)
        const sourceFingerprint = await computeWorktreeFingerprint({
          managedWorktreeId: sourceRecord.managedWorktreeId,
          checkoutPath: sourceRecord.checkoutPath,
          gitCommonDir: sourceRecord.gitCommonDir,
          expectedBranch: sourceRecord.expectedBranch,
          baseRef: sourceRecord.baseRef,
          ownerSessionIds: sourceRecord.ownerSessionIds,
          policyVersion: settings.version,
          archivedOwnerSessionIds: [],
        })
        let captured: Awaited<ReturnType<WorktreeSnapshotService['capture']>>
        try {
          captured = await this.deps.snapshots.capture({
            record: sourceRecord,
            finalFingerprint: sourceFingerprint,
            previewFingerprint: txn.fingerprint,
            policyVersion: settings.version,
          })
        } catch (error) {
          const code = error instanceof SnapshotError && error.code === 'SNAPSHOT_LIMIT'
            ? 'oversized-capture'
            : error instanceof SnapshotError && error.code === 'SNAPSHOT_UNSUPPORTED_STATE'
              ? 'git-operation-in-progress'
              : 'unsupported-snapshot'
          this.deps.journal.fail(journalId, sanitizeError(error))
          this.transactions.delete(input.sessionId)
          return this.blockedResult(txn, code, sanitizeError(error))
        }
        const afterCaptureFingerprint = await computeWorktreeFingerprint({
          managedWorktreeId: sourceRecord.managedWorktreeId,
          checkoutPath: sourceRecord.checkoutPath,
          gitCommonDir: sourceRecord.gitCommonDir,
          expectedBranch: sourceRecord.expectedBranch,
          baseRef: sourceRecord.baseRef,
          ownerSessionIds: sourceRecord.ownerSessionIds,
          policyVersion: settings.version,
          archivedOwnerSessionIds: [],
        })
        if (afterCaptureFingerprint !== captured.meta.fingerprint) {
          throw new Error('The source checkout changed during snapshot capture.')
        }
        this.assertLeaseStability(txn)
        txn.capturedIncludedFiles = await listWorktreeIncludeFiles(sourceRecord.checkoutPath)
        this.deps.journal.updateMetadata(journalId, { capturedIncludedFiles: txn.capturedIncludedFiles })
        txn.retainedSnapshotId = captured.meta.snapshotId
        txn.state = 'snapshotted'
        txn.steps.push('captured')
        this.deps.journal.updateMetadata(journalId, { state: 'snapshotted', retainedSnapshotId: captured.meta.snapshotId })
        this.deps.journal.step(journalId, 'captured')

        transactionLeaseId = `handoff:${txn.transactionId}`
        this.deps.leases.lease(transactionLeaseId, facts.destination.checkoutPath)
        txn.steps.push('destination-leased')
        this.deps.journal.step(journalId, 'destination-leased')

        const created = await this.deps.worktrees.createWorktree({
          workspaceId: session.workspaceId,
          sessionId: input.sessionId,
          repositoryRoot: facts.repositoryRoot,
          gitCommonDir: facts.gitCommonDir,
          baseRef: sourceBranch,
          worktreeNameSuffix: txn.nameSuffix,
          pathToken: txn.pathToken,
          lockAlreadyHeld: true,
        })
        if (created.record.schemaVersion !== 2) {
          throw new Error('Named handoff creation did not produce a V2 worktree record.')
        }
        const managedRecord = created.record
        txn.managedWorktreeId = managedRecord.managedWorktreeId
        txn.state = 'target-created'
        txn.steps.push('target-created')
        this.deps.journal.updateMetadata(journalId, { state: 'target-created', managedWorktreeId: managedRecord.managedWorktreeId })
        this.deps.journal.step(journalId, 'target-created')

        await this.deps.snapshots.applySnapshotToCheckout({
          meta: captured.meta,
          checkoutPath: managedRecord.checkoutPath,
        })
        const targetContext = await this.deps.repository.getContext(managedRecord.checkoutPath)
        if (
          !targetContext.isGitRepository ||
          targetContext.currentBranch !== managedRecord.expectedBranch ||
          targetContext.headSha !== captured.meta.headOid
        ) {
          throw new Error('The managed destination failed identity verification after restore.')
        }
        txn.steps.push('target-verified')
        this.deps.journal.step(journalId, 'target-verified')

        const adapter = this.hooks.resolveCapabilityAdapter?.(input.sessionId)
        if (!adapter) {
          throw new Error('The provider runtime could not be resolved for execution-CWD rebinding.')
        }
        await adapter.rebindExecutionCwd(managedRecord.checkoutPath)
        const proof = await adapter.verifyExecutionCwd(managedRecord.checkoutPath)
        if (
          proof.adapterId !== capability.adapterId ||
          resolvePath(proof.destinationPath) !== resolvePath(managedRecord.checkoutPath) ||
          proof.checks.length === 0 ||
          !proof.checks.some((check) => check.startsWith('file:')) ||
          !proof.checks.some((check) => check.startsWith('shell:')) ||
          !proof.checks.some((check) => check.startsWith('mcp:')) ||
          !proof.checks.some((check) => check.startsWith('provider:'))
        ) {
          throw new Error('The provider runtime did not prove execution in the managed destination.')
        }
        txn.runtimeProof = proof
        txn.steps.push('runtime-rebound')
        this.deps.journal.updateMetadata(journalId, {
          state: 'runtime-rebuilding',
          executionCwd: managedRecord.checkoutPath,
          runtimeProof: proof,
        })
        this.deps.journal.step(journalId, 'runtime-rebound')

        const postCaptureFingerprint = await computeWorktreeFingerprint({
          managedWorktreeId: sourceRecord.managedWorktreeId,
          checkoutPath: sourceRecord.checkoutPath,
          gitCommonDir: sourceRecord.gitCommonDir,
          expectedBranch: sourceRecord.expectedBranch,
          baseRef: sourceRecord.baseRef,
          ownerSessionIds: sourceRecord.ownerSessionIds,
          policyVersion: settings.version,
          archivedOwnerSessionIds: [],
        })
        if (postCaptureFingerprint !== captured.meta.fingerprint) {
          throw new Error('The source checkout changed after the snapshot was captured.')
        }
        this.assertLeaseStability(txn, transactionLeaseId)

        await this.removeCapturedState(
          facts.source.checkoutPath,
          captured.manifest,
          txn.capturedIncludedFiles ?? [],
        )
        txn.steps.push('source-cleaned')
        this.deps.journal.step(journalId, 'source-cleaned')

        const checkout: SessionCheckoutV2 = {
          schemaVersion: 2,
          mode: 'managed-worktree',
          repositoryRoot: managedRecord.repositoryRoot,
          checkoutPath: managedRecord.checkoutPath,
          branchAtPreparation: managedRecord.expectedBranch,
          baseRef: managedRecord.baseRef,
          managedWorktreeId: managedRecord.managedWorktreeId,
          displayName: managedRecord.displayName,
          expectedBranch: managedRecord.expectedBranch,
          materializationRoot: managedRecord.materializationRoot,
        }
        if (this.hooks.commitSessionBinding) {
          await this.hooks.commitSessionBinding({
            sessionId: input.sessionId,
            checkout,
            executionCwd: managedRecord.checkoutPath,
          })
        }
        txn.state = 'binding-committed'
        txn.steps.push('binding-committed')
        this.deps.journal.step(journalId, 'binding-committed')
        this.deps.journal.updateMetadata(journalId, {
          state: 'binding-committed',
          binding: { checkout, executionCwd: managedRecord.checkoutPath, transcriptCwd: session.transcriptCwd },
        })
        this.deps.journal.commit(journalId, txn.transactionId)
        if (transactionLeaseId) this.deps.leases.release(transactionLeaseId, facts.destination.checkoutPath)
        this.transactions.delete(input.sessionId)
        return {
          outcome: 'committed',
          transactionId: txn.transactionId,
          summary: {
            sessionId: input.sessionId,
            direction: txn.direction,
            checkout,
            executionCwd: managedRecord.checkoutPath,
            transcriptCwd: session.transcriptCwd,
            retainedSnapshotId: captured.meta.snapshotId,
            committedAt: Date.now(),
          },
        }
      } catch (error) {
        if (transactionLeaseId) this.deps.leases.release(transactionLeaseId, facts.destination.checkoutPath)
        txn.state = 'recovery-required'
        this.deps.journal.updateMetadata(journalId, { state: 'recovery-required', retainedSnapshotId: txn.retainedSnapshotId })
        this.deps.journal.fail(journalId, sanitizeError(error))
        return {
          outcome: 'recovery-required',
          transactionId: txn.transactionId,
          recovery: txn.state,
          ...(txn.retainedSnapshotId ? { retainedSnapshotId: txn.retainedSnapshotId } : {}),
          reason: sanitizeError(error),
        }
      }
    }).catch((error) => {
      if (error instanceof WorktreeHandoffError) throw error
      this.transactions.delete(input.sessionId)
      return this.blockedResult(txn, 'git-operation-in-progress', sanitizeError(error))
    })
  }

  private async confirmManagedToCurrent(
    txn: HandoffTransaction,
    input: WorktreeHandoffConfirmInput,
    session: HandoffSessionInfo,
    capability: WorktreeHandoffProviderCapability,
  ): Promise<WorktreeHandoffResult> {
    return this.deps.mutationLock.withLock<WorktreeHandoffResult>(txn.gitCommonDir, async () => {
      const facts = await this.gatherFacts(
        {
          sessionId: input.sessionId,
          direction: txn.direction,
          worktreeNameSuffix: txn.nameSuffix,
        },
        session,
        capability,
        txn.transactionId,
      )
      if (facts.blocker) {
        this.deps.journal.fail(txn.journalId, facts.blockerReason ?? 'Handoff precondition failed.')
        this.transactions.delete(input.sessionId)
        return this.blockedResult(txn, facts.blocker, facts.blockerReason ?? 'Handoff precondition failed.')
      }
      const freshFingerprint = await this.computeFingerprint(
        input.sessionId,
        txn.direction,
        session,
        facts,
        capability,
        txn.transactionId,
      )
      if (freshFingerprint !== txn.fingerprint || input.previewFingerprint !== txn.fingerprint) {
        this.deps.journal.fail(txn.journalId, 'The checkout changed after the preview.')
        this.transactions.delete(input.sessionId)
        return this.blockedResult(txn, 'identity-drift', 'The checkout changed after the preview; inspect it again.')
      }

      const journalId = txn.journalId || this.deps.journal.begin({
        op: 'handoff',
        recordId: txn.transactionId,
        sessionIds: [input.sessionId],
        policyVersion: this.deps.settings.getSnapshot(this.deps.serverId).version,
        metadata: this.transactionMetadata(txn),
      }).journalId
      txn.journalId = journalId
      txn.steps.push('locks-acquired')
      this.deps.journal.step(journalId, 'locks-acquired')
      let transactionLeaseId: string | null = null
      try {
        if (this.hooks.isSessionActive?.(input.sessionId)) {
          this.deps.journal.fail(journalId, 'The session runtime is active.')
          this.transactions.delete(input.sessionId)
          return this.blockedResult(txn, 'runtime-active', 'The session runtime could not be quiesced.')
        }
        const quiesced = this.hooks.quiesceRuntimes ? await this.hooks.quiesceRuntimes([input.sessionId]) : true
        if (!quiesced) {
          this.deps.journal.fail(journalId, 'The session runtime could not be quiesced.')
          this.transactions.delete(input.sessionId)
          return this.blockedResult(txn, 'runtime-active', 'The session runtime could not be quiesced.')
        }
        txn.state = 'quiesced'
        txn.steps.push('quiesced')
        this.deps.journal.updateMetadata(journalId, { state: txn.state })
        this.deps.journal.step(journalId, 'quiesced')

        const record = this.deps.registry.get(txn.managedWorktreeId ?? '')
        if (!record || record.schemaVersion !== 2 || record.state !== 'ready') {
          throw new Error('The managed source record changed before capture.')
        }
        if (record.ownerSessionIds.length !== 1 || record.ownerSessionIds[0] !== input.sessionId) {
          throw new Error('The managed source owner changed before capture.')
        }
        const settings = this.deps.settings.getSnapshot(this.deps.serverId)
        const sourceFingerprint = await computeWorktreeFingerprint({
          managedWorktreeId: record.managedWorktreeId,
          checkoutPath: record.checkoutPath,
          gitCommonDir: record.gitCommonDir,
          expectedBranch: record.expectedBranch,
          baseRef: record.baseRef,
          ownerSessionIds: record.ownerSessionIds,
          policyVersion: settings.version,
          archivedOwnerSessionIds: [],
        })
        let captured: Awaited<ReturnType<WorktreeSnapshotService['capture']>>
        try {
          captured = await this.deps.snapshots.capture({
            record,
            finalFingerprint: sourceFingerprint,
            previewFingerprint: txn.fingerprint,
            policyVersion: settings.version,
          })
        } catch (error) {
          const code = error instanceof SnapshotError && error.code === 'SNAPSHOT_LIMIT'
            ? 'oversized-capture'
            : error instanceof SnapshotError && error.code === 'SNAPSHOT_UNSUPPORTED_STATE'
              ? 'git-operation-in-progress'
              : 'unsupported-snapshot'
          this.deps.journal.fail(journalId, sanitizeError(error))
          this.transactions.delete(input.sessionId)
          return this.blockedResult(txn, code, sanitizeError(error))
        }
        const afterCaptureFingerprint = await computeWorktreeFingerprint({
          managedWorktreeId: record.managedWorktreeId,
          checkoutPath: record.checkoutPath,
          gitCommonDir: record.gitCommonDir,
          expectedBranch: record.expectedBranch,
          baseRef: record.baseRef,
          ownerSessionIds: record.ownerSessionIds,
          policyVersion: settings.version,
          archivedOwnerSessionIds: [],
        })
        if (afterCaptureFingerprint !== captured.meta.fingerprint) {
          throw new Error('The managed source changed during snapshot capture.')
        }
        this.assertLeaseStability(txn)
        txn.capturedIncludedFiles = await listWorktreeIncludeFiles(record.checkoutPath)
        txn.retainedSnapshotId = captured.meta.snapshotId
        txn.state = 'snapshotted'
        txn.steps.push('captured')
        this.deps.journal.updateMetadata(journalId, {
          state: txn.state,
          retainedSnapshotId: txn.retainedSnapshotId,
          capturedIncludedFiles: txn.capturedIncludedFiles,
        })
        this.deps.journal.step(journalId, 'captured')

        transactionLeaseId = `handoff:${txn.transactionId}`
        this.deps.leases.lease(transactionLeaseId, facts.destination.checkoutPath)
        txn.steps.push('destination-leased')
        this.deps.journal.step(journalId, 'destination-leased')

        const returnRef = txn.returnRef ?? facts.returnRef
        const beforeReleaseContext = await this.deps.repository.getContext(facts.destination.checkoutPath)
        const destinationCounts = await this.transferableStateCounts(facts.destination.checkoutPath)
        if (
          !returnRef ||
          beforeReleaseContext.currentBranch !== returnRef.branch ||
          beforeReleaseContext.headSha !== returnRef.headSha ||
          destinationCounts.trackedFileCount > 0 ||
          destinationCounts.stagedFileCount > 0 ||
          destinationCounts.eligibleUntrackedFileCount > 0
        ) {
          throw new Error('The current destination changed before the managed source was released.')
        }

        const released = await removeCheckoutFiles(record.repositoryRoot, record.checkoutPath)
        if (!released) throw new Error('The managed source checkout could not be released safely.')
        // Retain the record as the hand-back target: snapshotted state plus
        // the captured snapshot meta. Git can no longer check out the branch
        // twice, and hand-back re-materializes this record from the journal
        // return ref. The orphan GC treats the snapshot as referenced.
        this.deps.registry.upsert({
          ...record,
          state: 'snapshotted',
          snapshot: captured.meta,
        })
        txn.state = 'source-released'
        txn.steps.push('source-released')
        this.deps.journal.updateMetadata(journalId, { state: txn.state })
        this.deps.journal.step(journalId, 'source-released')

        this.assertLeaseStability(txn, transactionLeaseId)
        const branchOid = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${record.expectedBranch}`], {
          cwd: facts.destination.checkoutPath,
          okExitCodes: [1, 128],
        })
        if (branchOid.exitCode !== 0 || branchOid.stdout.trim() !== captured.meta.headOid) {
          throw new Error('The released managed branch no longer points at the captured source.')
        }
        await runGit(['switch', record.expectedBranch], { cwd: facts.destination.checkoutPath })
        txn.state = 'branch-switched'
        txn.steps.push('branch-switched')
        this.deps.journal.updateMetadata(journalId, { state: txn.state })
        this.deps.journal.step(journalId, 'branch-switched')

        await this.deps.snapshots.applySnapshotToCheckout({
          meta: captured.meta,
          checkoutPath: facts.destination.checkoutPath,
        })
        const destinationContext = await this.deps.repository.getContext(facts.destination.checkoutPath)
        if (
          !destinationContext.isGitRepository ||
          destinationContext.currentBranch !== record.expectedBranch ||
          destinationContext.headSha !== captured.meta.headOid
        ) {
          throw new Error('The current checkout failed identity verification after snapshot restore.')
        }
        txn.steps.push('target-verified')
        this.deps.journal.step(journalId, 'target-verified')

        const adapter = this.hooks.resolveCapabilityAdapter?.(input.sessionId)
        if (!adapter) throw new Error('The provider runtime could not be resolved for execution-CWD rebinding.')
        await adapter.rebindExecutionCwd(facts.destination.checkoutPath)
        const proof = await adapter.verifyExecutionCwd(facts.destination.checkoutPath)
        if (
          proof.adapterId !== capability.adapterId ||
          resolvePath(proof.destinationPath) !== resolvePath(facts.destination.checkoutPath) ||
          proof.checks.length === 0 ||
          !proof.checks.some((check) => check.startsWith('file:')) ||
          !proof.checks.some((check) => check.startsWith('shell:')) ||
          !proof.checks.some((check) => check.startsWith('mcp:')) ||
          !proof.checks.some((check) => check.startsWith('provider:'))
        ) {
          throw new Error('The provider runtime did not prove execution in the current checkout.')
        }
        txn.runtimeProof = proof
        txn.state = 'runtime-rebuilding'
        txn.steps.push('runtime-rebound')
        this.deps.journal.updateMetadata(journalId, {
          state: txn.state,
          executionCwd: facts.destination.checkoutPath,
          runtimeProof: proof,
        })
        this.deps.journal.step(journalId, 'runtime-rebound')
        this.assertLeaseStability(txn, transactionLeaseId)

        if (!returnRef) throw new Error('The current checkout return ref is unavailable.')
        const checkout: SessionCheckout = {
          schemaVersion: 1,
          mode: 'current',
          repositoryRoot: record.repositoryRoot,
          checkoutPath: facts.destination.checkoutPath,
          branchAtPreparation: record.expectedBranch,
          baseRef: null,
          managedWorktreeId: null,
          expectedBranch: null,
        }
        await this.hooks.commitSessionBinding!({
          sessionId: input.sessionId,
          checkout,
          executionCwd: facts.destination.checkoutPath,
        })
        txn.state = 'binding-committed'
        txn.steps.push('binding-committed')
        this.deps.journal.step(journalId, 'binding-committed')
        this.deps.journal.updateMetadata(journalId, {
          state: txn.state,
          returnRef,
          binding: { checkout, executionCwd: facts.destination.checkoutPath, transcriptCwd: session.transcriptCwd },
        })
        this.deps.journal.commit(journalId, txn.transactionId)
        if (transactionLeaseId) this.deps.leases.release(transactionLeaseId, facts.destination.checkoutPath)
        this.transactions.delete(input.sessionId)
        return {
          outcome: 'committed',
          transactionId: txn.transactionId,
          summary: {
            sessionId: input.sessionId,
            direction: txn.direction,
            checkout,
            executionCwd: facts.destination.checkoutPath,
            transcriptCwd: session.transcriptCwd,
            retainedSnapshotId: captured.meta.snapshotId,
            committedAt: Date.now(),
          },
        }
      } catch (error) {
        if (transactionLeaseId) this.deps.leases.release(transactionLeaseId, facts.destination.checkoutPath)
        txn.state = 'recovery-required'
        this.deps.journal.updateMetadata(journalId, {
          state: txn.state,
          retainedSnapshotId: txn.retainedSnapshotId,
          runtimeProof: txn.runtimeProof,
        })
        this.deps.journal.fail(journalId, sanitizeError(error))
        return {
          outcome: 'recovery-required',
          transactionId: txn.transactionId,
          recovery: txn.state,
          ...(txn.retainedSnapshotId ? { retainedSnapshotId: txn.retainedSnapshotId } : {}),
          reason: sanitizeError(error),
        }
      }
    })
  }

  private async confirmHandBack(
    txn: HandoffTransaction,
    input: WorktreeHandoffConfirmInput,
    session: HandoffSessionInfo,
    capability: WorktreeHandoffProviderCapability,
  ): Promise<WorktreeHandoffResult> {
    return this.deps.mutationLock.withLock<WorktreeHandoffResult>(txn.gitCommonDir, async () => {
      const facts = await this.gatherFacts(
        {
          sessionId: input.sessionId,
          direction: txn.direction,
          worktreeNameSuffix: txn.nameSuffix,
        },
        session,
        capability,
        txn.transactionId,
      )
      if (facts.blocker) {
        this.deps.journal.fail(txn.journalId, facts.blockerReason ?? 'Handoff precondition failed.')
        this.transactions.delete(input.sessionId)
        return this.blockedResult(txn, facts.blocker, facts.blockerReason ?? 'Handoff precondition failed.')
      }
      const freshFingerprint = await this.computeFingerprint(
        input.sessionId,
        txn.direction,
        session,
        facts,
        capability,
        txn.transactionId,
      )
      if (freshFingerprint !== txn.fingerprint || input.previewFingerprint !== txn.fingerprint) {
        this.deps.journal.fail(txn.journalId, 'The checkout changed after the preview.')
        this.transactions.delete(input.sessionId)
        return this.blockedResult(txn, 'identity-drift', 'The checkout changed after the preview; inspect it again.')
      }

      const journalId = txn.journalId || this.deps.journal.begin({
        op: 'handoff',
        recordId: txn.transactionId,
        sessionIds: [input.sessionId],
        policyVersion: this.deps.settings.getSnapshot(this.deps.serverId).version,
        metadata: this.transactionMetadata(txn),
      }).journalId
      txn.journalId = journalId
      txn.steps.push('locks-acquired')
      this.deps.journal.step(journalId, 'locks-acquired')
      let transactionLeaseId: string | null = null
      try {
        if (this.hooks.isSessionActive?.(input.sessionId)) {
          this.deps.journal.fail(journalId, 'The session runtime is active.')
          this.transactions.delete(input.sessionId)
          return this.blockedResult(txn, 'runtime-active', 'The session runtime could not be quiesced.')
        }
        const quiesced = this.hooks.quiesceRuntimes ? await this.hooks.quiesceRuntimes([input.sessionId]) : true
        if (!quiesced) {
          this.deps.journal.fail(journalId, 'The session runtime could not be quiesced.')
          this.transactions.delete(input.sessionId)
          return this.blockedResult(txn, 'runtime-active', 'The session runtime could not be quiesced.')
        }
        txn.state = 'quiesced'
        txn.steps.push('quiesced')
        this.deps.journal.updateMetadata(journalId, { state: txn.state })
        this.deps.journal.step(journalId, 'quiesced')

        const record = this.deps.registry.get(txn.managedWorktreeId ?? '')
        if (!record || record.schemaVersion !== 2 || record.state !== 'snapshotted') {
          throw new Error('The released managed target record changed before capture.')
        }
        if (record.ownerSessionIds.length !== 1 || record.ownerSessionIds[0] !== input.sessionId) {
          throw new Error('The released managed target owner changed before capture.')
        }
        const returnRef = txn.returnRef ?? facts.returnRef
        if (!returnRef) throw new Error('The recorded return ref is unavailable for the hand-back.')
        const settings = this.deps.settings.getSnapshot(this.deps.serverId)
        const sourceBranch = facts.source.branch
        if (!sourceBranch) throw new Error('The current checkout is detached; it cannot hand back.')
        const sourceRecord = this.currentSnapshotRecord(
          input.sessionId,
          session,
          facts,
          sourceBranch,
          settings.version,
          settings.materializationRoot,
        )
        const sourceFingerprint = await computeWorktreeFingerprint({
          managedWorktreeId: sourceRecord.managedWorktreeId,
          checkoutPath: sourceRecord.checkoutPath,
          gitCommonDir: sourceRecord.gitCommonDir,
          expectedBranch: sourceRecord.expectedBranch,
          baseRef: sourceRecord.baseRef,
          ownerSessionIds: sourceRecord.ownerSessionIds,
          policyVersion: settings.version,
          archivedOwnerSessionIds: [],
        })
        let captured: Awaited<ReturnType<WorktreeSnapshotService['capture']>>
        try {
          captured = await this.deps.snapshots.capture({
            record: sourceRecord,
            finalFingerprint: sourceFingerprint,
            previewFingerprint: txn.fingerprint,
            policyVersion: settings.version,
          })
        } catch (error) {
          const code = error instanceof SnapshotError && error.code === 'SNAPSHOT_LIMIT'
            ? 'oversized-capture'
            : error instanceof SnapshotError && error.code === 'SNAPSHOT_UNSUPPORTED_STATE'
              ? 'git-operation-in-progress'
              : 'unsupported-snapshot'
          this.deps.journal.fail(journalId, sanitizeError(error))
          this.transactions.delete(input.sessionId)
          return this.blockedResult(txn, code, sanitizeError(error))
        }
        const afterCaptureFingerprint = await computeWorktreeFingerprint({
          managedWorktreeId: sourceRecord.managedWorktreeId,
          checkoutPath: sourceRecord.checkoutPath,
          gitCommonDir: sourceRecord.gitCommonDir,
          expectedBranch: sourceRecord.expectedBranch,
          baseRef: sourceRecord.baseRef,
          ownerSessionIds: sourceRecord.ownerSessionIds,
          policyVersion: settings.version,
          archivedOwnerSessionIds: [],
        })
        if (afterCaptureFingerprint !== captured.meta.fingerprint) {
          throw new Error('The current checkout changed during snapshot capture.')
        }
        this.assertLeaseStability(txn)
        txn.capturedIncludedFiles = await listWorktreeIncludeFiles(sourceRecord.checkoutPath)
        txn.retainedSnapshotId = captured.meta.snapshotId
        txn.state = 'snapshotted'
        txn.steps.push('captured')
        this.deps.journal.updateMetadata(journalId, {
          state: txn.state,
          retainedSnapshotId: txn.retainedSnapshotId,
          capturedIncludedFiles: txn.capturedIncludedFiles,
        })
        this.deps.journal.step(journalId, 'captured')

        transactionLeaseId = `handoff:${txn.transactionId}`
        this.deps.leases.lease(transactionLeaseId, facts.destination.checkoutPath)
        txn.steps.push('destination-leased')
        this.deps.journal.step(journalId, 'destination-leased')

        await this.removeCapturedState(
          facts.source.checkoutPath,
          captured.manifest,
          txn.capturedIncludedFiles ?? [],
        )
        txn.steps.push('source-cleaned')
        this.deps.journal.step(journalId, 'source-cleaned')

        // Free the handed branch: current returns to the recorded ref so the
        // managed target can materialize the same branch again.
        await runGit(['switch', returnRef.branch], { cwd: facts.source.checkoutPath })
        const switchedContext = await this.deps.repository.getContext(facts.source.checkoutPath)
        if (switchedContext.currentBranch !== returnRef.branch || switchedContext.headSha !== returnRef.headSha) {
          throw new Error('The current checkout did not return to the recorded ref.')
        }
        const worktrees = await runGit(['worktree', 'list', '--porcelain'], { cwd: facts.source.checkoutPath })
        if (branchCheckedOutInWorktree(worktrees.stdout, record.expectedBranch)) {
          throw new Error('The handed branch is still checked out elsewhere; it cannot be materialized again.')
        }
        txn.state = 'branch-switched'
        txn.steps.push('branch-switched')
        this.deps.journal.updateMetadata(journalId, { state: txn.state })
        this.deps.journal.step(journalId, 'branch-switched')

        const restored = await this.deps.snapshots.restore({
          record,
          meta: captured.meta,
          checkoutPath: record.checkoutPath,
        })
        const targetContext = await this.deps.repository.getContext(restored.checkoutPath)
        if (
          !targetContext.isGitRepository ||
          targetContext.currentBranch !== record.expectedBranch ||
          targetContext.headSha !== captured.meta.headOid
        ) {
          throw new Error('The managed target failed identity verification after hand-back restore.')
        }
        txn.steps.push('target-verified')
        this.deps.journal.step(journalId, 'target-verified')

        const adapter = this.hooks.resolveCapabilityAdapter?.(input.sessionId)
        if (!adapter) throw new Error('The provider runtime could not be resolved for execution-CWD rebinding.')
        await adapter.rebindExecutionCwd(restored.checkoutPath)
        const proof = await adapter.verifyExecutionCwd(restored.checkoutPath)
        if (
          proof.adapterId !== capability.adapterId ||
          resolvePath(proof.destinationPath) !== resolvePath(restored.checkoutPath) ||
          proof.checks.length === 0 ||
          !proof.checks.some((check) => check.startsWith('file:')) ||
          !proof.checks.some((check) => check.startsWith('shell:')) ||
          !proof.checks.some((check) => check.startsWith('mcp:')) ||
          !proof.checks.some((check) => check.startsWith('provider:'))
        ) {
          throw new Error('The provider runtime did not prove execution in the managed target.')
        }
        txn.runtimeProof = proof
        txn.state = 'runtime-rebuilding'
        txn.steps.push('runtime-rebound')
        this.deps.journal.updateMetadata(journalId, {
          state: txn.state,
          executionCwd: restored.checkoutPath,
          runtimeProof: proof,
        })
        this.deps.journal.step(journalId, 'runtime-rebound')
        this.assertLeaseStability(txn, transactionLeaseId)

        const checkout: SessionCheckoutV2 = {
          schemaVersion: 2,
          mode: 'managed-worktree',
          repositoryRoot: record.repositoryRoot,
          checkoutPath: record.checkoutPath,
          branchAtPreparation: record.expectedBranch,
          baseRef: record.baseRef,
          managedWorktreeId: record.managedWorktreeId,
          displayName: record.displayName,
          expectedBranch: record.expectedBranch,
          materializationRoot: record.materializationRoot,
        }
        await this.hooks.commitSessionBinding!({
          sessionId: input.sessionId,
          checkout,
          executionCwd: record.checkoutPath,
        })
        this.deps.registry.upsert({
          ...record,
          state: 'ready',
          snapshot: undefined,
        })
        txn.state = 'binding-committed'
        txn.steps.push('binding-committed')
        this.deps.journal.step(journalId, 'binding-committed')
        this.deps.journal.updateMetadata(journalId, {
          state: txn.state,
          binding: { checkout, executionCwd: record.checkoutPath, transcriptCwd: session.transcriptCwd },
        })
        this.deps.journal.commit(journalId, txn.transactionId)
        // Post-commit snapshot hygiene: the projected snapshot and the
        // superseded managed-to-current authority are no longer recoverable
        // sources, so remove their payloads/refs best-effort (GC handles
        // stragglers).
        try {
          this.deps.snapshots.removePayload(captured.meta)
          await this.deps.snapshots.casDeleteRef(record.repositoryRoot, captured.meta)
        } catch {
          /* best-effort; GC covers stragglers */
        }
        if (record.snapshot) {
          try {
            await this.deps.snapshots.permanentDelete(record.repositoryRoot, record.snapshot)
          } catch {
            /* best-effort; GC covers stragglers */
          }
        }
        if (transactionLeaseId) this.deps.leases.release(transactionLeaseId, facts.destination.checkoutPath)
        this.transactions.delete(input.sessionId)
        return {
          outcome: 'committed',
          transactionId: txn.transactionId,
          summary: {
            sessionId: input.sessionId,
            direction: txn.direction,
            checkout,
            executionCwd: record.checkoutPath,
            transcriptCwd: session.transcriptCwd,
            retainedSnapshotId: captured.meta.snapshotId,
            committedAt: Date.now(),
          },
        }
      } catch (error) {
        if (transactionLeaseId) this.deps.leases.release(transactionLeaseId, facts.destination.checkoutPath)
        txn.state = 'recovery-required'
        this.deps.journal.updateMetadata(journalId, {
          state: txn.state,
          retainedSnapshotId: txn.retainedSnapshotId,
          runtimeProof: txn.runtimeProof,
        })
        this.deps.journal.fail(journalId, sanitizeError(error))
        return {
          outcome: 'recovery-required',
          transactionId: txn.transactionId,
          recovery: txn.state,
          ...(txn.retainedSnapshotId ? { retainedSnapshotId: txn.retainedSnapshotId } : {}),
          reason: sanitizeError(error),
        }
      }
    })
  }

  private blockedResult(
    txn: HandoffTransaction,
    code: WorktreeHandoffBlockerCode,
    reason: string,
  ): WorktreeHandoffResult {
    return { outcome: 'blocked', transactionId: txn.transactionId, code, reason: sanitizeError(reason) }
  }

  private currentSnapshotRecord(
    sessionId: string,
    session: HandoffSessionInfo,
    facts: Awaited<ReturnType<WorktreeHandoffService['gatherFacts']>>,
    branch: string,
    policyVersion: number,
    materializationRoot: string,
  ): import('@kata-sh/shared/protocol').ManagedWorktreeRecordV2 {
    const now = Date.now()
    return {
      schemaVersion: 2,
      managedWorktreeId: `handoff-current-${sha256(`${session.checkoutPath}:${session.workspaceId}`).slice(0, 16)}`,
      workspaceId: session.workspaceId,
      repositoryRoot: facts.repositoryRoot,
      gitCommonDir: facts.gitCommonDir,
      checkoutPath: facts.source.checkoutPath,
      baseRef: branch,
      expectedBranch: branch,
      displayName: 'current',
      materializationRoot,
      createdAt: now,
      lastUsedAt: now,
      ownerSessionIds: [sessionId],
      state: 'ready',
      policyVersion,
    }
  }

  private assertLeaseStability(txn: HandoffTransaction, transactionLeaseId?: string | null): void {
    const sourceLeases = this.deps.leases.leasedBy(txn.sourcePath).sort()
    const destinationLeases = this.deps.leases
      .leasedBy(txn.destinationPath)
      .filter((owner) => owner !== transactionLeaseId)
      .sort()
    if (
      JSON.stringify(sourceLeases) !== JSON.stringify([...txn.sourceLeases].sort()) ||
      JSON.stringify(destinationLeases) !== JSON.stringify([...txn.destinationLeases].sort())
    ) {
      throw new Error('A checkout path lease changed during handoff.')
    }
  }

  private async removeCapturedState(
    checkoutPath: string,
    manifest: WorktreeSnapshotManifest,
    capturedIncludedFiles: string[],
  ): Promise<void> {
    await runGit(['reset', '--hard', 'HEAD'], { cwd: checkoutPath })
    const included = new Set(capturedIncludedFiles)
    for (const entry of manifest.files) {
      if (included.has(entry.path)) continue
      const absolute = resolvePath(join(checkoutPath, entry.path))
      const relativePath = relative(resolvePath(checkoutPath), absolute)
      if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
        throw new Error(`Captured path escapes the checkout: ${entry.path}`)
      }
      rmSync(absolute, { force: true, recursive: false })
    }
    const remaining = await this.transferableStateCounts(checkoutPath)
    if (remaining.trackedFileCount || remaining.stagedFileCount || remaining.eligibleUntrackedFileCount) {
      throw new Error('Source cleanup did not remove the exact captured transferable state.')
    }
  }

  // -------------------------------------------------------------------------
  // Recover
  // -------------------------------------------------------------------------

  async recover(input: WorktreeHandoffRecoverInput): Promise<WorktreeHandoffResult> {
    const txn = this.transactions.get(input.sessionId)
    if (!txn || txn.transactionId !== input.transactionId) {
      throw new WorktreeHandoffError('HANDOFF_TRANSACTION_UNKNOWN', 'Unknown handoff transaction.')
    }
    // Conservative until T5 reconciliation: a pending transaction never
    // mutated anything, so it can be discarded; anything past pending is
    // recovery-required with its retained snapshot authority.
    if (txn.state === 'pending') {
      this.deps.journal.recover(txn.journalId, 'preview-cancelled')
      this.transactions.delete(input.sessionId)
      return {
        outcome: 'blocked',
        transactionId: input.transactionId,
        code: 'identity-drift',
        reason: 'The preview transaction expired before confirmation; preview again.',
      }
    }
    // A durable binding without a journal commit is ambiguous (the binding
    // cannot be revoked through this service); only explicit recovery applies.
    if (txn.state === 'binding-committed' || txn.steps.includes('binding-committed')) {
      return {
        outcome: 'recovery-required',
        transactionId: input.transactionId,
        recovery: txn.state,
        ...(txn.retainedSnapshotId ? { retainedSnapshotId: txn.retainedSnapshotId } : {}),
        reason: 'The session binding committed before the journal commit marker; resolve the binding before retrying.',
      }
    }

    // Snapshot-backed rollback: undo exactly the steps the journal records,
    // using the retained snapshot as the authority. Idempotent so a crash
    // during rollback can safely re-run it.
    return this.deps.mutationLock.withLock<WorktreeHandoffResult>(txn.gitCommonDir, async () => {
      try {
        await this.rollbackTransaction(txn)
        this.deps.journal.updateMetadata(txn.journalId, { state: 'rolled-back', rolledBackAt: Date.now() })
        this.deps.journal.recover(txn.journalId, 'rolled-back')
        this.transactions.delete(input.sessionId)
        return {
          outcome: 'blocked',
          transactionId: input.transactionId,
          code: 'handoff-rolled-back',
          reason: 'The interrupted handoff was rolled back to its previous checkout state; preview again to retry.',
        }
      } catch (error) {
        this.deps.journal.updateMetadata(txn.journalId, {
          state: 'recovery-required',
          retainedSnapshotId: txn.retainedSnapshotId,
        })
        this.deps.journal.fail(txn.journalId, sanitizeError(error))
        return {
          outcome: 'recovery-required',
          transactionId: input.transactionId,
          recovery: txn.state,
          ...(txn.retainedSnapshotId ? { retainedSnapshotId: txn.retainedSnapshotId } : {}),
          reason: sanitizeError(error),
        }
      }
    }).catch((error) => {
      if (error instanceof WorktreeHandoffError) throw error
      this.transactions.delete(input.sessionId)
      return this.blockedResult(txn, 'git-operation-in-progress', sanitizeError(error))
    })
  }

  /**
   * Undo an interrupted handoff from its journal steps and retained snapshot
   * authority. Never touches a binding that already committed; ambiguous
   * states stay recovery-required. Idempotent: re-running after a crash only
   * completes unfinished undo steps.
   */
  private async rollbackTransaction(txn: HandoffTransaction): Promise<void> {
    if (txn.direction === 'current-to-managed') {
      await this.rollbackCurrentToManaged(txn)
      return
    }
    if (txn.direction === 'managed-to-current') {
      await this.rollbackManagedToCurrent(txn)
      return
    }
    await this.rollbackHandBack(txn)
  }

  /** c2m: remove the created target, delete its branch when still txn-owned, restore source from the retained snapshot if it was cleaned. */
  private async rollbackCurrentToManaged(txn: HandoffTransaction): Promise<void> {
    const targetCreated = txn.steps.includes('target-created')
    const sourceCleaned = txn.steps.includes('source-cleaned')
    if (targetCreated) {
      const record = txn.managedWorktreeId ? this.deps.registry.get(txn.managedWorktreeId) : undefined
      if (!record || record.schemaVersion !== 2) {
        // A prior rollback attempt may have removed the record before its
        // crash. When the target checkout is provably gone too, treat the
        // removal as already complete and continue to source restore.
        const targetPath = txn.destinationPath
        if (existsSync(targetPath) || lstatSyncSafe(targetPath) === 'symlink') {
          throw new Error('The interrupted target record is missing; explicit recovery is required.')
        }
      } else {
        const owners = record.ownerSessionIds
        if (owners.length !== 1 || owners[0] !== txn.sessionId) {
          throw new Error('The interrupted target gained other owners; explicit recovery is required.')
        }
        const released = await removeCheckoutFiles(record.repositoryRoot, record.checkoutPath)
        if (!released) throw new Error('The interrupted target checkout could not be removed for rollback.')
        this.deps.registry.remove(record.managedWorktreeId)
      }
      // The branch is txn-owned only while it still points at the captured
      // source HEAD; anything else may be external work and is preserved.
      // Runs in both the first rollback and idempotent re-entry.
      const branchOid = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${txn.expectedBranch}`], {
        cwd: txn.repositoryRoot,
        okExitCodes: [1, 128],
      })
      if (txn.retainedSnapshotId && branchOid.exitCode === 0 && branchOid.stdout.trim() !== '') {
        const authority = this.deps.snapshots.loadSnapshotMeta(txn.retainedSnapshotId)
        if (authority && branchOid.stdout.trim() === authority.headOid) {
          await runGit(['branch', '-D', txn.expectedBranch], { cwd: txn.repositoryRoot, okExitCodes: [1, 128] })
        }
      }
    }
    if (sourceCleaned) {
      if (!txn.retainedSnapshotId) throw new Error('The cleaned source has no retained snapshot authority.')
      const authority = this.deps.snapshots.loadSnapshotMeta(txn.retainedSnapshotId)
      if (!authority) throw new Error('The retained snapshot authority is missing; source restore is impossible.')
      if (!(await this.checkoutMatchesSnapshot(txn.sourcePath, authority))) {
        await this.deps.snapshots.applySnapshotToCheckout({ meta: authority, checkoutPath: txn.sourcePath })
      }
    }
    if (txn.retainedSnapshotId) {
      const authority = this.deps.snapshots.loadSnapshotMeta(txn.retainedSnapshotId)
      if (authority) {
        try {
          await this.deps.snapshots.permanentDelete(txn.repositoryRoot, authority)
        } catch {
          /* best-effort; GC covers stragglers */
        }
      }
    }
  }

  /** m2c: re-materialize the released managed target from its retained snapshot, after freeing the branch in current. */
  private async rollbackManagedToCurrent(txn: HandoffTransaction): Promise<void> {
    const released = txn.steps.includes('source-released')
    const branchSwitched = txn.steps.includes('branch-switched')
    if (!released) {
      // Only a capture happened; nothing to undo beyond dropping the snapshot.
      if (txn.retainedSnapshotId) {
        const authority = this.deps.snapshots.loadSnapshotMeta(txn.retainedSnapshotId)
        if (authority) {
          try {
            await this.deps.snapshots.permanentDelete(txn.repositoryRoot, authority)
          } catch {
            /* best-effort; GC covers stragglers */
          }
        }
      }
      return
    }
    const record = txn.managedWorktreeId ? this.deps.registry.get(txn.managedWorktreeId) : undefined
    if (!record || record.schemaVersion !== 2 || record.state !== 'snapshotted') {
      throw new Error('The released managed record is missing; explicit recovery is required.')
    }
    if (record.ownerSessionIds.length !== 1 || record.ownerSessionIds[0] !== txn.sessionId) {
      throw new Error('The released managed record gained other owners; explicit recovery is required.')
    }
    let authority = record.snapshot ?? null
    if (!authority && txn.retainedSnapshotId) {
      authority = this.deps.snapshots.loadSnapshotMeta(txn.retainedSnapshotId)
    }
    if (!authority) throw new Error('The managed rollback snapshot authority is missing.')
    const currentPath = txn.destinationPath
    const currentContext = await this.deps.repository.getContext(currentPath)
    if (!currentContext.isGitRepository) throw new Error('The current checkout is unreadable during rollback.')
    if (branchSwitched && currentContext.currentBranch === txn.expectedBranch) {
      // The interrupted confirm already projected the captured state into the
      // current checkout. Remove exactly that state before switching back so
      // no duplicate copy remains and the destination stays clean.
      const manifest = this.deps.snapshots.verifyPayload(authority)
      await this.removeCapturedState(currentPath, manifest, txn.capturedIncludedFiles ?? [])
      const returnRef = txn.returnRef
      if (!returnRef) throw new Error('The recorded return ref is missing; explicit recovery is required.')
      await runGit(['switch', returnRef.branch], { cwd: currentPath })
      const after = await this.deps.repository.getContext(currentPath)
      if (after.currentBranch !== returnRef.branch || after.headSha !== returnRef.headSha) {
        throw new Error('The current checkout did not return to the recorded ref during rollback.')
      }
    }
    if (existsSync(record.checkoutPath) || lstatSyncSafe(record.checkoutPath) === 'symlink') {
      // A partial rollback already re-materialized the target; verify it
      // byte-for-byte so a stale or foreign checkout is never trusted.
      const context = await this.deps.repository.getContext(record.checkoutPath)
      if (
        !context.isGitRepository ||
        context.currentBranch !== record.expectedBranch ||
        context.headSha !== authority.headOid ||
        !(await this.checkoutMatchesSnapshot(record.checkoutPath, authority))
      ) {
        throw new Error('A pre-existing path occupies the managed target; explicit recovery is required.')
      }
    } else {
      await this.deps.snapshots.restore({ record, meta: authority, checkoutPath: record.checkoutPath })
    }
    this.deps.registry.upsert({ ...record, state: 'ready', snapshot: undefined })
    try {
      await this.deps.snapshots.permanentDelete(record.repositoryRoot, authority)
    } catch {
      /* best-effort; GC covers stragglers */
    }
  }

  /** hand-back: remove the materialized target, return current to the handed branch, restore it from the retained snapshot. */
  private async rollbackHandBack(txn: HandoffTransaction): Promise<void> {
    const sourceCleaned = txn.steps.includes('source-cleaned')
    if (!sourceCleaned) {
      // Only a capture happened; nothing to undo beyond dropping the snapshot.
      if (txn.retainedSnapshotId) {
        const authority = this.deps.snapshots.loadSnapshotMeta(txn.retainedSnapshotId)
        if (authority) {
          try {
            await this.deps.snapshots.permanentDelete(txn.repositoryRoot, authority)
          } catch {
            /* best-effort; GC covers stragglers */
          }
        }
      }
      return
    }
    if (!txn.retainedSnapshotId) throw new Error('The handed source has no retained snapshot authority.')
    const authority = this.deps.snapshots.loadSnapshotMeta(txn.retainedSnapshotId)
    if (!authority) throw new Error('The retained snapshot authority is missing; current restore is impossible.')
    const record = txn.managedWorktreeId ? this.deps.registry.get(txn.managedWorktreeId) : undefined
    if (!record || record.schemaVersion !== 2 || record.state !== 'snapshotted') {
      throw new Error('The released managed record is missing; explicit recovery is required.')
    }
    if (record.ownerSessionIds.length !== 1 || record.ownerSessionIds[0] !== txn.sessionId) {
      throw new Error('The released managed record gained other owners; explicit recovery is required.')
    }
    // Free the handed branch before current can return to it: remove the
    // materialized target (restore ran during the interrupted confirm).
    if (existsSync(record.checkoutPath) || lstatSyncSafe(record.checkoutPath) === 'symlink') {
      const released = await removeCheckoutFiles(record.repositoryRoot, record.checkoutPath)
      if (!released) throw new Error('The materialized target could not be removed for rollback.')
    }
    const currentPath = txn.sourcePath
    const currentContext = await this.deps.repository.getContext(currentPath)
    if (!currentContext.isGitRepository) throw new Error('The current checkout is unreadable during rollback.')
    if (currentContext.currentBranch !== authority.branch) {
      await runGit(['switch', authority.branch], { cwd: currentPath })
      const after = await this.deps.repository.getContext(currentPath)
      if (after.currentBranch !== authority.branch || after.headSha !== authority.headOid) {
        throw new Error('The current checkout did not return to the handed branch during rollback.')
      }
    }
    if (!(await this.checkoutMatchesSnapshot(currentPath, authority))) {
      await this.deps.snapshots.applySnapshotToCheckout({ meta: authority, checkoutPath: currentPath })
    }
    try {
      await this.deps.snapshots.permanentDelete(currentPath, authority)
    } catch {
      /* best-effort; GC covers stragglers */
    }
  }

  /** True when a checkout already reproduces a snapshot exactly (idempotent re-entry). */
  private async checkoutMatchesSnapshot(
    checkoutPath: string,
    meta: import('@kata-sh/shared/protocol').ManagedWorktreeSnapshotMeta,
  ): Promise<boolean> {
    const manifest = this.deps.snapshots.verifyPayload(meta)
    const maxBufferBytes = this.deps.snapshots.getMaxBytes() + 16 * 1024
    try {
      const staged = (
        await runGitBuffer(['diff', '--cached', '--binary', '--no-color', '--no-ext-diff'], {
          cwd: checkoutPath,
          maxBufferBytes,
        })
      ).stdout
      if (sha256(staged) !== manifest.stagedPatch.sha256) return false
      const unstaged = (
        await runGitBuffer(['diff', '--binary', '--no-color', '--no-ext-diff'], {
          cwd: checkoutPath,
          maxBufferBytes,
        })
      ).stdout
      if (sha256(unstaged) !== manifest.unstagedPatch.sha256) return false
      for (const entry of manifest.files) {
        const dest = join(checkoutPath, entry.path)
        const kind = lstatSyncSafe(dest)
        if (kind === null) return false
        if (entry.mode === '120000') {
          if (kind !== 'symlink' || readFileSync(dest, 'utf8') !== entry.linkText) return false
          continue
        }
        if (kind !== 'other') return false
        const actual = statSync(dest)
        if (!actual.isFile() || (actual.mode & 0o777) !== parseInt(entry.mode.slice(-3), 8) || sha256(readFileSync(dest)) !== entry.sha256) {
          return false
        }
      }
      return true
    } catch {
      return false
    }
  }

  private transactionMetadata(txn: HandoffTransaction): Record<string, unknown> {
    return {
      transactionId: txn.transactionId,
      sessionId: txn.sessionId,
      direction: txn.direction,
      state: txn.state,
      fingerprint: txn.fingerprint,
      nameSuffix: txn.nameSuffix,
      pathToken: txn.pathToken,
      returnRef: txn.returnRef,
      retainedSnapshotId: txn.retainedSnapshotId,
      managedWorktreeId: txn.managedWorktreeId,
      sourcePath: txn.sourcePath,
      destinationPath: txn.destinationPath,
      repositoryRoot: txn.repositoryRoot,
      gitCommonDir: txn.gitCommonDir,
      expectedBranch: txn.expectedBranch,
      providerCapability: txn.providerCapability,
      transcriptCwd: txn.transcriptCwd,
      sourceLeases: txn.sourceLeases,
      destinationLeases: txn.destinationLeases,
      runtimeProof: txn.runtimeProof,
      capturedIncludedFiles: txn.capturedIncludedFiles,
      startedAt: txn.startedAt,
    }
  }

  /** Restore status/recovery visibility after a process restart. */
  private restoreJournalTransactions(): void {
    for (const entry of this.deps.journal.entries()) {
      if (
        entry.op !== 'handoff' ||
        entry.sessionIds.length !== 1 ||
        !entry.metadata ||
        (entry.status !== 'in-progress' && entry.status !== 'failed')
      ) continue
      const metadata = entry.metadata
      const stringValue = (key: string): string | undefined =>
        typeof metadata[key] === 'string' ? metadata[key] as string : undefined
      const transactionId = stringValue('transactionId')
      const journalSessionId = entry.sessionIds[0]
      const metadataSessionId = stringValue('sessionId')
      if (!journalSessionId || !metadataSessionId || metadataSessionId !== journalSessionId) continue
      const sessionId = journalSessionId
      const direction = stringValue('direction')
      const fingerprint = stringValue('fingerprint')
      const sourcePath = stringValue('sourcePath')
      const destinationPath = stringValue('destinationPath')
      const repositoryRoot = stringValue('repositoryRoot')
      const gitCommonDir = stringValue('gitCommonDir')
      const expectedBranch = stringValue('expectedBranch')
      if (
        entry.recordId !== transactionId ||
        !transactionId || !/^[a-f0-9]{16}$/.test(transactionId) || !sessionId ||
        (direction !== 'current-to-managed' && direction !== 'managed-to-current' && direction !== 'hand-back') ||
        !fingerprint || !sourcePath || !destinationPath || !repositoryRoot || !gitCommonDir || !expectedBranch
      ) continue
      const absolutePaths = [sourcePath, destinationPath, repositoryRoot, gitCommonDir]
      if (absolutePaths.some((path) => !isAbsolute(path) || path.includes('\0'))) continue
      const root = resolvePath(this.deps.settings.getSnapshot(this.deps.serverId).materializationRoot)
      const topologyValid = direction === 'current-to-managed'
        ? resolvePath(sourcePath) === resolvePath(repositoryRoot) && isContainedPath(root, destinationPath)
        : direction === 'managed-to-current'
          ? resolvePath(destinationPath) === resolvePath(repositoryRoot) && isContainedPath(root, sourcePath)
          : resolvePath(sourcePath) === resolvePath(repositoryRoot) && isContainedPath(root, destinationPath)
      if (!topologyValid) continue
      const state = stringValue('state') as WorktreeHandoffRecoveryState | undefined
      if (!state || !HANDOFF_RECOVERY_STATES.has(state)) continue
      const providerCapability = metadata.providerCapability
      if (
        !providerCapability || typeof providerCapability !== 'object' ||
        typeof (providerCapability as { adapterId?: unknown }).adapterId !== 'string' ||
        (providerCapability as { executionCwdRebindable?: unknown }).executionCwdRebindable !== true
      ) continue
      const sourceLeases = metadata.sourceLeases
      const destinationLeases = metadata.destinationLeases
      if (
        !Array.isArray(sourceLeases) || !sourceLeases.every((value) => typeof value === 'string') ||
        !Array.isArray(destinationLeases) || !destinationLeases.every((value) => typeof value === 'string')
      ) continue
      const retainedSnapshotId = stringValue('retainedSnapshotId')
      const transcriptCwd = stringValue('transcriptCwd')
      if (!transcriptCwd || !isAbsolute(transcriptCwd)) continue
      const nameSuffix = stringValue('nameSuffix')
      const pathToken = stringValue('pathToken')
      if ((nameSuffix && nameSuffix.includes('\0')) || (pathToken && !/^[a-f0-9]{8}$/.test(pathToken))) continue
      if (entry.status === 'failed' && !retainedSnapshotId && state !== 'recovery-required') continue
      const returnRef = metadata.returnRef
      const validReturnRef = returnRef && typeof returnRef === 'object' &&
        typeof (returnRef as { branch?: unknown }).branch === 'string' &&
        typeof (returnRef as { headSha?: unknown }).headSha === 'string'
        ? returnRef as WorktreeHandoffReturnRef
        : undefined
      const runtimeProof = metadata.runtimeProof
      const requiresProof = entry.steps.includes('runtime-rebound') || state === 'runtime-rebuilding' || state === 'binding-committed'
      if (requiresProof && runtimeProof === undefined) continue
      if (runtimeProof !== undefined) {
        if (!runtimeProof || typeof runtimeProof !== 'object') continue
        const checks = (runtimeProof as { checks?: unknown }).checks
        if (
          typeof (runtimeProof as { adapterId?: unknown }).adapterId !== 'string' ||
          (runtimeProof as { adapterId: string }).adapterId !== (providerCapability as { adapterId: string }).adapterId ||
          typeof (runtimeProof as { destinationPath?: unknown }).destinationPath !== 'string' ||
          !isAbsolute((runtimeProof as { destinationPath: string }).destinationPath) ||
          resolvePath((runtimeProof as { destinationPath: string }).destinationPath) !== resolvePath(destinationPath) ||
          !Number.isFinite((runtimeProof as { verifiedAt?: unknown }).verifiedAt) ||
          !Array.isArray(checks) ||
          !(checks as unknown[]).every((check) => typeof check === 'string') ||
          !(checks as string[]).some((check) => check.startsWith('file:')) ||
          !(checks as string[]).some((check) => check.startsWith('shell:')) ||
          !(checks as string[]).some((check) => check.startsWith('mcp:')) ||
          !(checks as string[]).some((check) => check.startsWith('provider:'))
        ) continue
      }
      const capturedIncludedFilesValue = metadata.capturedIncludedFiles
      const requiresCapturedIncludeSet = Boolean(retainedSnapshotId) || entry.steps.includes('captured')
      if (
        (requiresCapturedIncludeSet && !Array.isArray(capturedIncludedFilesValue)) ||
        (capturedIncludedFilesValue !== undefined &&
          (!Array.isArray(capturedIncludedFilesValue) ||
            !capturedIncludedFilesValue.every((value) =>
              typeof value === 'string' && value.length > 0 && !isAbsolute(value) && !value.split('/').includes('..')
            )))
      ) continue
      const capturedIncludedFiles = capturedIncludedFilesValue as string[] | undefined
      const transaction: HandoffTransaction = {
        transactionId,
        sessionId,
        direction,
        state,
        fingerprint,
        nameSuffix,
        pathToken,
        returnRef: validReturnRef,
        retainedSnapshotId,
        managedWorktreeId: stringValue('managedWorktreeId'),
        sourcePath,
        destinationPath,
        repositoryRoot,
        gitCommonDir,
        expectedBranch,
        steps: [...entry.steps],
        journalId: entry.journalId,
        providerCapability: providerCapability as WorktreeHandoffProviderCapability,
        transcriptCwd,
        sourceLeases: sourceLeases as string[],
        destinationLeases: destinationLeases as string[],
        runtimeProof: runtimeProof as ExecutionCwdProof | undefined,
        capturedIncludedFiles,
        startedAt: typeof metadata.startedAt === 'number' ? metadata.startedAt : entry.startedAt,
      }
      this.transactions.set(sessionId, transaction)
    }
  }

  // -------------------------------------------------------------------------
  // Fact gathering and blockers
  // -------------------------------------------------------------------------

  private async gatherFacts(
    input: WorktreeHandoffPreviewInput,
    session: HandoffSessionInfo,
    capability: WorktreeHandoffProviderCapability | null,
    transactionIdToAllow?: string,
  ): Promise<{
    blocker: WorktreeHandoffBlockerCode | null
    blockerReason?: string
    source: WorktreeHandoffPreview['source']
    destination: WorktreeHandoffPreview['destination']
    cleanup: WorktreeHandoffCleanupSummary
    included: string[]
    includeConflicts: WorktreeHandoffIncludeConflict[]
    returnRef?: WorktreeHandoffReturnRef
    recoveryBehavior: WorktreeHandoffRecoveryBehavior
    repositoryRoot: string
    gitCommonDir: string
    expectedBranch: string
    nameSuffix?: string
    pathToken?: string
    managedWorktreeId?: string
  }> {
    const fail = (code: WorktreeHandoffBlockerCode, reason: string) => ({ blocker: code, blockerReason: reason })
    let sourcePath = resolvePath(session.checkoutPath)
    let repositoryRoot = sourcePath // refined per direction below
    let gitCommonDir = ''
    let expectedBranch = ''
    let nameSuffix: string | undefined
    let pathToken: string | undefined
    let managedWorktreeId: string | undefined
    let returnRef: WorktreeHandoffReturnRef | undefined
    let recoveryBehavior: WorktreeHandoffRecoveryBehavior = 'destination-authoritative'
    let destination: WorktreeHandoffPreview['destination']

    // Early blockers (no Git inspection needed).
    if (!isGitWorkspaceV1Enabled() || !isWorktreeV2Enabled()) {
      return { ...fail('flags-disabled', 'Required feature flags are disabled.'), ...this.emptyFacts(sourcePath, repositoryRoot) }
    }
    if (!capability || capability.executionCwdRebindable !== true) {
      return { ...fail('unsupported-provider', 'The provider adapter cannot safely rebind its execution CWD.'), ...this.emptyFacts(sourcePath, repositoryRoot) }
    }
    const existingTransaction = this.transactions.get(input.sessionId)
    if (existingTransaction && existingTransaction.transactionId !== transactionIdToAllow) {
      return { ...fail('handoff-in-progress', 'A handoff transaction is already in progress for this session.'), ...this.emptyFacts(sourcePath, repositoryRoot) }
    }
    if (this.hooks.isSessionActive?.(input.sessionId)) {
      return { ...fail('runtime-active', 'The session has an active turn; handoff requires an idle session.'), ...this.emptyFacts(sourcePath, repositoryRoot) }
    }
    if (this.deps.lifecycle.isCleanupInProgress()) {
      return { ...fail('cleanup-in-progress', 'Worktree lifecycle cleanup is running; try again shortly.'), ...this.emptyFacts(sourcePath, repositoryRoot) }
    }

    if (!existsSync(sourcePath)) {
      return { ...fail('unsupported-snapshot', 'The source checkout path does not exist.'), ...this.emptyFacts(sourcePath, repositoryRoot) }
    }

    const sourceCtx = await this.deps.repository.getContext(sourcePath)
    if (!sourceCtx.isGitRepository || !sourceCtx.gitCommonDir) {
      return { ...fail('unsupported-snapshot', 'The source checkout is not a readable Git worktree.'), ...this.emptyFacts(sourcePath, repositoryRoot) }
    }
    gitCommonDir = sourceCtx.gitCommonDir
    repositoryRoot = sourceCtx.repositoryRoot ?? sourcePath
    // Legacy/current sessions may retain a nested working directory. The
    // canonical current checkout is the repository root; snapshots, cleanup,
    // fingerprints, and leases must all use that root.
    if (input.direction !== 'managed-to-current' && sourceCtx.repositoryRoot) {
      sourcePath = resolvePath(sourceCtx.repositoryRoot)
      repositoryRoot = sourcePath
    }

    const foreignSourceLeases = this.deps.leases.leasedBy(sourcePath).filter((id) => id !== input.sessionId)

    if (input.direction === 'current-to-managed') {
      nameSuffix = input.worktreeNameSuffix ?? existingTransaction?.nameSuffix ?? newPathToken()
      pathToken = existingTransaction?.pathToken ?? newPathToken()
      expectedBranch = `kata-agent/${nameSuffix}`
      const destinationPath = this.deps.worktrees.resolveWorktreePath({
        workspaceId: session.workspaceId,
        gitCommonDir,
        worktreeNameSuffix: nameSuffix,
        pathToken,
      })
      destination = {
        serverId: this.deps.serverId,
        repositoryRoot: sourceCtx.repositoryRoot ?? sourcePath,
        branch: expectedBranch,
        checkoutPath: destinationPath,
        exists: existsSync(destinationPath),
        leases: this.deps.leases.leasedBy(destinationPath),
      }
      const nameValid = nameSuffix.trim() === nameSuffix && nameSuffix.length > 0 && !nameSuffix.includes('\0')
      const refCheck = nameValid
        ? await runGit(['check-ref-format', '--branch', expectedBranch], { cwd: sourcePath, okExitCodes: [1, 128] })
        : null
      if (!nameValid || !refCheck || refCheck.exitCode !== 0) {
        return { ...fail('invalid-name', 'The requested worktree name is not a valid Git branch suffix.'), ...this.factsFor(sourcePath, sourceCtx.repositoryRoot ?? sourcePath, gitCommonDir, destination, expectedBranch, undefined, recoveryBehavior, undefined, nameSuffix, pathToken) }
      }
      if (destination.exists || lstatSyncSafe(destinationPath) === 'symlink') {
        return { ...fail('destination-dirty', 'The generated managed destination path is already occupied.'), ...this.factsFor(sourcePath, sourceCtx.repositoryRoot ?? sourcePath, gitCommonDir, destination, expectedBranch, undefined, recoveryBehavior, undefined, nameSuffix, pathToken) }
      }
    } else if (input.direction === 'managed-to-current') {
      const checkout = session.checkout
      if (!checkout || checkout.mode !== 'managed-worktree' || !checkout.managedWorktreeId) {
        throw new WorktreeHandoffError(
          'HANDOFF_DIRECTION_MISMATCH',
          'The session is not bound to a managed worktree; managed-to-current handoff does not apply.',
        )
      }
      const record = this.deps.registry.get(checkout.managedWorktreeId)
      managedWorktreeId = checkout.managedWorktreeId
      if (!record || record.state !== 'ready' || !existsSync(record.checkoutPath)) {
        return { ...fail('destination-missing', 'The managed worktree is not materialized and ready.'), ...this.emptyFacts(sourcePath, sourceCtx.repositoryRoot ?? sourcePath, gitCommonDir) }
      }
      if (record.ownerSessionIds.length !== 1 || record.ownerSessionIds[0] !== input.sessionId) {
        return { ...fail('shared-owners', 'Handoff requires exactly one owner.'), ...this.emptyFacts(sourcePath, record.repositoryRoot, gitCommonDir) }
      }
      expectedBranch = record.expectedBranch
      recoveryBehavior = 'source-authoritative'
      destination = {
        serverId: this.deps.serverId,
        repositoryRoot: record.repositoryRoot,
        branch: '',
        checkoutPath: record.repositoryRoot,
        exists: existsSync(record.repositoryRoot),
        leases: this.deps.leases.leasedBy(record.repositoryRoot),
      }
      // Destination (current checkout) checks.
      const destCtx = await this.deps.repository.getContext(record.repositoryRoot)
      if (!destCtx.isGitRepository || !destCtx.gitCommonDir) {
        return { ...fail('destination-missing', 'The current checkout is not a readable Git worktree.'), ...this.factsFor(sourcePath, record.repositoryRoot, gitCommonDir, destination, expectedBranch, managedWorktreeId, recoveryBehavior) }
      }
      if (resolvePath(destCtx.gitCommonDir) !== resolvePath(record.gitCommonDir)) {
        return { ...fail('identity-drift', 'The current checkout no longer belongs to the recorded repository.'), ...this.factsFor(sourcePath, record.repositoryRoot, gitCommonDir, destination, expectedBranch, managedWorktreeId, recoveryBehavior) }
      }
      if (destCtx.detached || !destCtx.currentBranch) {
        return { ...fail('destination-detached', 'The current checkout is on a detached HEAD.'), ...this.factsFor(sourcePath, record.repositoryRoot, gitCommonDir, destination, expectedBranch, managedWorktreeId, recoveryBehavior) }
      }
      destination = { ...destination, branch: destCtx.currentBranch }
      returnRef = { branch: destCtx.currentBranch, headSha: destCtx.headSha ?? '' }
      const destDirty = await this.transferableStateCounts(record.repositoryRoot)
      if (destDirty.trackedFileCount > 0 || destDirty.stagedFileCount > 0 || destDirty.eligibleUntrackedFileCount > 0) {
        return { ...fail('destination-dirty', 'The current checkout has tracked, staged, or untracked state.'), ...this.factsFor(sourcePath, record.repositoryRoot, gitCommonDir, destination, expectedBranch, managedWorktreeId, recoveryBehavior, returnRef) }
      }
    } else {
      // hand-back: session in current checkout; the managed target is a
      // released (snapshotted) record owned solely by this session.
      const commonDir = gitCommonDir
      const candidates = this.deps.registry
        .list()
        .filter(
          (rec) =>
            rec.state === 'snapshotted' &&
            rec.ownerSessionIds.length === 1 &&
            rec.ownerSessionIds[0] === input.sessionId &&
            resolvePath(rec.gitCommonDir) === resolvePath(commonDir),
        )
      const record = candidates[0]
      recoveryBehavior = 'source-authoritative'
      if (!record) {
        return { ...fail('destination-missing', 'No released managed worktree exists to hand back to.'), ...this.emptyFacts(sourcePath, sourceCtx.repositoryRoot ?? sourcePath, gitCommonDir) }
      }
      managedWorktreeId = record.managedWorktreeId
      expectedBranch = record.expectedBranch
      destination = {
        serverId: this.deps.serverId,
        repositoryRoot: record.repositoryRoot,
        branch: record.expectedBranch,
        checkoutPath: record.checkoutPath,
        exists: existsSync(record.checkoutPath) || lstatSyncSafe(record.checkoutPath) === 'symlink',
        leases: this.deps.leases.leasedBy(record.checkoutPath).filter((id) => id !== input.sessionId),
      }
      if (destination.exists || lstatSyncSafe(record.checkoutPath) === 'symlink') {
        return { ...fail('destination-dirty', 'The managed worktree path is occupied.'), ...this.factsFor(sourcePath, record.repositoryRoot, gitCommonDir, destination, expectedBranch, managedWorktreeId, recoveryBehavior) }
      }
      returnRef = this.lastReturnRefFor(input.sessionId, record.managedWorktreeId)
      if (!returnRef) {
        return { ...fail('unsupported-snapshot', 'No recorded return ref authorizes the hand-back.'), ...this.factsFor(sourcePath, record.repositoryRoot, gitCommonDir, destination, expectedBranch, managedWorktreeId, recoveryBehavior) }
      }
      if (!sourceCtx.currentBranch || sourceCtx.currentBranch !== record.expectedBranch) {
        return { ...fail('unsupported-snapshot', 'The current checkout is not on the handed branch.'), ...this.factsFor(sourcePath, record.repositoryRoot, gitCommonDir, destination, expectedBranch, managedWorktreeId, recoveryBehavior, returnRef) }
      }
    }

    // Git operation / unmerged index on either side.
    for (const path of [sourcePath, ...(destination.exists ? [destination.checkoutPath] : [])]) {
      const status = await this.deps.repository.getStatus(path)
      if (status.operationInProgress || status.entries.some((entry) => entry.conflicted)) {
        return { ...fail('git-operation-in-progress', 'A Git operation is in progress or the index is unmerged.'), ...this.factsFor(sourcePath, repositoryRoot, gitCommonDir, destination, expectedBranch, managedWorktreeId, recoveryBehavior, returnRef, nameSuffix, pathToken) }
      }
    }

    if (foreignSourceLeases.length > 0 || destination.leases.some((id) => id !== input.sessionId)) {
      return { ...fail('another-path-user', 'Another session or runtime leases the source or destination path.'), ...this.factsFor(sourcePath, repositoryRoot, gitCommonDir, destination, expectedBranch, managedWorktreeId, recoveryBehavior, returnRef, nameSuffix, pathToken) }
    }

    // Branch occupancy (current-to-managed): the requested branch must be
    // free and not checked out by any worktree outside this transaction.
    if (input.direction === 'current-to-managed') {
      const occupied = await this.branchOccupied(repositoryRoot, expectedBranch)
      if (occupied) {
        return { ...fail('branch-occupied-outside-journal', `The branch ${expectedBranch} is already in use.`), ...this.factsFor(sourcePath, repositoryRoot, gitCommonDir, destination, expectedBranch, managedWorktreeId, recoveryBehavior, returnRef, nameSuffix, pathToken) }
      }
    }

    const cleanup = await this.transferableStateCounts(sourcePath)
    const included = await listWorktreeIncludeFiles(sourcePath)
    const includeConflicts = await this.includeConflictsFor(sourcePath, destination.checkoutPath, included)
    if (includeConflicts.length > 0) {
      return {
        ...fail('destination-dirty', 'A differing .worktreeinclude file exists in the destination.'),
        ...this.factsFor(sourcePath, repositoryRoot, gitCommonDir, destination, expectedBranch, managedWorktreeId, recoveryBehavior, returnRef, nameSuffix, pathToken),
        includeConflicts,
        included,
        cleanup,
      }
    }

    return {
      blocker: null,
      source: {
        serverId: this.deps.serverId,
        branch: input.direction === 'current-to-managed' || input.direction === 'hand-back'
          ? (sourceCtx.currentBranch ?? null)
          : expectedBranch,
        headSha: sourceCtx.headSha,
        state: sourceCtx.detached
          ? 'detached'
          : cleanup.trackedFileCount + cleanup.stagedFileCount + cleanup.eligibleUntrackedFileCount > 0
            ? 'dirty'
            : 'clean',
        checkoutPath: sourcePath,
        leases: this.deps.leases.leasedBy(sourcePath),
      },
      destination,
      cleanup,
      included,
      includeConflicts,
      returnRef,
      recoveryBehavior,
      repositoryRoot: sourceCtx.repositoryRoot ?? repositoryRoot,
      gitCommonDir,
      expectedBranch,
      nameSuffix,
      pathToken,
      managedWorktreeId,
    }
  }

  private emptyFacts(sourcePath: string, repositoryRoot: string, gitCommonDir = '') {
    return {
      source: {
        serverId: this.deps.serverId,
        branch: null,
        headSha: null,
        state: 'clean' as const,
        checkoutPath: sourcePath,
        leases: [],
      },
      destination: {
        serverId: this.deps.serverId,
        repositoryRoot,
        branch: '',
        checkoutPath: '',
        exists: false,
        leases: [],
      },
      cleanup: { trackedFileCount: 0, stagedFileCount: 0, eligibleUntrackedFileCount: 0, includedIgnoredFileCount: 0 },
      included: [] as string[],
      includeConflicts: [] as WorktreeHandoffIncludeConflict[],
      recoveryBehavior: 'destination-authoritative' as const,
      repositoryRoot,
      gitCommonDir,
      expectedBranch: '',
    }
  }

  private factsFor(
    sourcePath: string,
    repositoryRoot: string,
    gitCommonDir: string,
    destination: WorktreeHandoffPreview['destination'],
    expectedBranch: string,
    managedWorktreeId?: string,
    recoveryBehavior: WorktreeHandoffRecoveryBehavior = 'destination-authoritative',
    returnRef?: WorktreeHandoffReturnRef,
    nameSuffix?: string,
    pathToken?: string,
  ) {
    return {
      ...this.emptyFacts(sourcePath, repositoryRoot, gitCommonDir),
      destination,
      expectedBranch,
      managedWorktreeId,
      recoveryBehavior,
      returnRef,
      nameSuffix,
      pathToken,
    }
  }

  /** Counts of the exact state that transfers out of a checkout. */
  private async transferableStateCounts(checkoutPath: string): Promise<WorktreeHandoffCleanupSummary> {
    const staged = splitNul((await runGit(['diff', '--cached', '--name-only', '-z'], { cwd: checkoutPath })).stdout)
    const unstaged = splitNul((await runGit(['diff', '--name-only', '-z'], { cwd: checkoutPath })).stdout)
    const untracked = splitNul(
      (await runGit(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: checkoutPath })).stdout,
    )
    const included = await listWorktreeIncludeFiles(checkoutPath)
    return {
      trackedFileCount: unstaged.length,
      stagedFileCount: staged.length,
      eligibleUntrackedFileCount: untracked.length,
      includedIgnoredFileCount: included.length,
    }
  }

  private async includeConflictsFor(
    sourcePath: string,
    destinationPath: string,
    included: string[],
  ): Promise<WorktreeHandoffIncludeConflict[]> {
    const conflicts: WorktreeHandoffIncludeConflict[] = []
    for (const rel of included) {
      const dest = join(destinationPath, rel)
      if (!existsSync(dest)) continue
      const sourceAbs = join(sourcePath, rel)
      try {
        if (sha256(readFileSync(sourceAbs) as unknown as string) !== sha256(readFileSync(dest) as unknown as string)) {
          conflicts.push({ path: rel })
        }
      } catch {
        conflicts.push({ path: rel })
      }
    }
    return conflicts
  }

  private async branchOccupied(repositoryRoot: string, branch: string): Promise<boolean> {
    const ref = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd: repositoryRoot,
      okExitCodes: [1, 128],
    })
    if (ref.exitCode === 0) return true
    const worktrees = await runGit(['worktree', 'list', '--porcelain'], { cwd: repositoryRoot })
    return branchCheckedOutInWorktree(worktrees.stdout, branch)
  }

  private lastReturnRefFor(sessionId: string, managedWorktreeId: string): WorktreeHandoffReturnRef | undefined {
    for (const txn of this.transactions.values()) {
      if (txn.sessionId === sessionId && txn.managedWorktreeId === managedWorktreeId && txn.returnRef) {
        return txn.returnRef
      }
    }
    // A restart must not make a valid hand-back unreachable. Return-ref is
    // persisted in the handoff journal metadata by managed-to-current.
    for (const entry of this.deps.journal.entries().reverse()) {
      if (entry.op !== 'handoff' || !entry.metadata) continue
      if (entry.sessionIds[0] !== sessionId || entry.metadata.managedWorktreeId !== managedWorktreeId) continue
      const value = entry.metadata.returnRef
      if (
        value && typeof value === 'object' &&
        typeof (value as { branch?: unknown }).branch === 'string' &&
        typeof (value as { headSha?: unknown }).headSha === 'string'
      ) return value as WorktreeHandoffReturnRef
    }
    return undefined
  }

  private async computeFingerprint(
    sessionId: string,
    direction: WorktreeHandoffDirection,
    session: HandoffSessionInfo,
    facts: Awaited<ReturnType<WorktreeHandoffService['gatherFacts']>>,
    capability: WorktreeHandoffProviderCapability,
    transactionId: string,
  ): Promise<string> {
    const hash = createHash('sha256')
    hash.update('kata-worktree-handoff-v1\0')
    // Source side: reuse the lifecycle fingerprint — it binds repository
    // identity, HEAD, branch, index, working tree, untracked/included state,
    // owner set, and policy version.
    hash.update(
      await computeWorktreeFingerprint({
        managedWorktreeId: `handoff:${session.checkout?.checkoutPath ?? ''}`,
        checkoutPath: facts.source.checkoutPath,
        gitCommonDir: facts.gitCommonDir,
        expectedBranch: facts.source.branch ?? '',
        baseRef: null,
        ownerSessionIds: [sessionId],
        policyVersion: this.deps.settings.getSnapshot(this.deps.serverId).version,
        archivedOwnerSessionIds: [],
      }),
    )
    hash.update('\0')
    // Destination side: identity + occupancy + live state (when present).
    const destination = facts.destination
    hash.update(
      JSON.stringify({
        direction,
        destination: {
          serverId: destination.serverId,
          repositoryRoot: destination.repositoryRoot,
          branch: destination.branch,
          checkoutPath: destination.checkoutPath,
          exists: destination.exists,
          leases: [...destination.leases].sort(),
        },
        cleanup: facts.cleanup,
        includeConflicts: facts.includeConflicts,
        returnRef: facts.returnRef ?? null,
        recoveryBehavior: facts.recoveryBehavior,
        capability,
        transcriptCwd: session.transcriptCwd,
        allPathLeases: [...this.deps.leases.allLeases().entries()]
          .map(([owner, paths]) => [owner, [...paths].sort()])
          .sort(([a], [b]) => String(a).localeCompare(String(b))),
      }),
    )
    if (destination.exists) {
      const status = await runGit(['status', '--porcelain=v2', '-z'], { cwd: destination.checkoutPath })
      const head = await runGit(['rev-parse', 'HEAD'], { cwd: destination.checkoutPath })
      hash.update(status.stdout)
      hash.update(head.stdout)
    }
    hash.update('\0')
    return hash.digest('hex')
  }
}
