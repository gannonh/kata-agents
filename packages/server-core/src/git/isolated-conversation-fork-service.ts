/**
 * IsolatedConversationForkService — Worktree V2 Phase 4 eligibility preview
 * and seed capture for isolated conversation forks.
 *
 * Conversation branching keeps the existing **Shared worktree** behavior and
 * adds an explicit **New isolated worktree** alternative: a separately named
 * managed worktree, Git branch, Kata session, and execution runtime at the
 * source conversation's current head, leaving the source conversation and
 * checkout unchanged.
 *
 * This service owns the eligibility/preview surface (typed blockers, no
 * mutation, no seed written during preview) and the fingerprinted seed
 * capture that pins the source checkout's exact captured HEAD. Git services
 * own target and seed lifecycle; session/provider code owns conversation
 * ancestry and the pending native-fork intent via the host hooks.
 *
 * Isolated is offered only when Worktree V2 is effective, the source session
 * is idle at its current conversation head, Git state is supported, and the
 * provider adapter advertises strict safe cross-CWD native fork. Unsupported
 * providers receive a typed blocker with no fallback. Historical conversation
 * points remain available only through the existing shared branching; this
 * phase does not reconstruct historical Git state.
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, lstatSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import type {
  ConversationForkBlockerCode,
  ConversationForkPreview,
  ConversationForkPreviewInput,
  ConversationForkProviderCapability,
  ConversationForkRecoveryState,
  ConversationForkStrategy,
  ManagedWorktreeRecordV2,
  SessionCheckout,
} from '@kata-sh/shared/protocol'
import { isGitWorkspaceV1Enabled, isWorktreeV2Enabled } from '@kata-sh/shared/feature-flags'
import type { StrictConversationForkCapability } from '@kata-sh/shared/agent/backend'
import { runGit, splitNul } from './command-runner'
import { listWorktreeIncludeFiles } from './worktree-include'
import {
  WORKTREE_SNAPSHOT_MAX_BYTES,
  WORKTREE_SNAPSHOT_MAX_FILES,
  WorktreeSnapshotError,
  computeWorktreeFingerprint,
  type WorktreeSnapshotService,
} from './worktree-snapshot-service'
import type { ManagedWorktreeService } from './managed-worktree-service'
import type { MutationLock } from './mutation-lock'
import type { PathLeaseManager } from './path-leases'
import type { WorktreeJournal } from './worktree-journal'
import type { WorktreeLifecycleService } from './worktree-lifecycle-service'
import type { RepositoryService } from './repository-service'
import type { WorktreeRegistry } from './worktree-registry'
import type { WorktreeSettingsService } from './worktree-settings-service'

export type ConversationForkErrorCode =
  | 'FORK_SESSION_UNKNOWN'
  | 'FORK_TRANSACTION_UNKNOWN'
  | 'FORK_STRATEGY_MISMATCH'
  | 'FORK_NOT_IMPLEMENTED'
  | 'FORK_SEED_LIMIT'
  | 'FORK_SEED_CAPTURE_FAILED'
  | 'FORK_SEED_REMOVE_FAILED'

export class ConversationForkError extends Error {
  readonly code: ConversationForkErrorCode
  constructor(code: ConversationForkErrorCode, message: string) {
    super(message)
    this.name = 'ConversationForkError'
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

/** Session facts the host supplies for one fork evaluation. */
export interface ForkSessionInfo {
  /** The session's active checkout path (never client-nominated). */
  checkoutPath: string
  workspaceId: string
  /** Persisted checkout metadata (null for legacy/current sessions). */
  checkout: SessionCheckout | null
  /** Immutable transcript CWD (session.sdkCwd) — never rewritten by a fork. */
  transcriptCwd: string
  /** Current conversation head of the source session. */
  conversationHead: {
    messageId: string
    turnId: string
  }
  /** Provider SDK session identity of the source (anchor lineage). */
  sdkSessionId?: string
  /**
   * Requested fork point message ID; defaults to the current conversation
   * head. Older points cannot select isolated (non-head-source).
   */
  forkPointMessageId?: string
  /** Provider turn anchor at the requested fork point. */
  forkPointTurnId?: string
}

export interface ConversationForkHooks {
  /** Resolve persisted session facts; null for an unknown session. */
  resolveSession?: (sessionId: string) => ForkSessionInfo | null
  /** Resolve the provider adapter's advertised strict fork capability. */
  resolveCapability?: (sessionId: string) => ConversationForkProviderCapability | null
  /** Resolve the live adapter used for first-Send native-fork establishment. */
  resolveCapabilityAdapter?: (sessionId: string) => StrictConversationForkCapability | null
  /** Whether a session is running an agent turn. */
  isSessionActive?: (sessionId: string) => boolean
  /** Quiesce the session's runtime; false when it cannot quiesce. */
  quiesceRuntimes?: (sessionIds: string[]) => Promise<boolean>
}

export interface ConversationForkDeps {
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
  hooks?: ConversationForkHooks
}

/** One in-flight fork transaction (preview → confirm/recover in later phases). */
interface ForkTransaction {
  transactionId: string
  sessionId: string
  strategy: ConversationForkStrategy
  state: ConversationForkRecoveryState
  fingerprint: string
  /** Generated/edited name for the new managed worktree (isolated only). */
  nameSuffix?: string
  /** Pre-issued path token pinning the destination path from the preview. */
  pathToken?: string
  sourcePath: string
  destinationPath: string
  repositoryRoot: string
  gitCommonDir: string
  /** Branch the isolated target carries, or '' for shared. */
  expectedBranch: string
  /** Idempotent steps completed so far, in order. */
  steps: string[]
  /** Durable journal identity. */
  journalId: string
  providerCapability?: ConversationForkProviderCapability
  transcriptCwd?: string
  sourceLeases: string[]
  startedAt: number
}

/** Facts collected during one fork preview evaluation. */
interface ForkFacts {
  blocker: ConversationForkBlockerCode | null
  blockerReason?: string
  source: ConversationForkPreview['source']
  destination: ConversationForkPreview['destination']
  excludedIgnoredPolicy: { includeOnly: true; includeFileCount: number }
  currentHead: boolean
  /** Internal canonical source checkout path (not part of the wire preview). */
  sourceCheckoutPath: string
  repositoryRoot: string
  gitCommonDir: string
  expectedBranch: string
  nameSuffix?: string
  pathToken?: string
  ownerSessionIds: string[]
}

export class IsolatedConversationForkService {
  private readonly deps: ConversationForkDeps
  private readonly transactions = new Map<string, ForkTransaction>()
  private previewSerial: Promise<void> = Promise.resolve()
  /** Seed snapshotId → source repository root, for Task 3 seed cleanup. */
  private readonly seedRepositoryRoots = new Map<string, string>()

  constructor(deps: ConversationForkDeps) {
    this.deps = deps
  }

  /** Install runtime/session hooks late (the host wires them after construction). */
  setHooks(hooks: ConversationForkHooks): void {
    this.deps.hooks = { ...this.deps.hooks, ...hooks }
  }

  private get hooks(): ConversationForkHooks {
    return this.deps.hooks ?? {}
  }

  // -------------------------------------------------------------------------
  // Fences
  // -------------------------------------------------------------------------

  /** True while a pending/recovery fork owns a session fence. */
  isSessionFenced(sessionId: string): boolean {
    return this.transactions.has(sessionId)
  }

  /** True while a pending/recovery fork owns a canonical path fence. */
  isPathFenced(path: string): boolean {
    const canonical = resolvePath(path)
    for (const txn of this.transactions.values()) {
      if (resolvePath(txn.sourcePath) === canonical || resolvePath(txn.destinationPath) === canonical) return true
    }
    return false
  }

  // -------------------------------------------------------------------------
  // Preview
  // -------------------------------------------------------------------------

  async preview(input: ConversationForkPreviewInput): Promise<ConversationForkPreview> {
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

  private async previewInternal(input: ConversationForkPreviewInput): Promise<ConversationForkPreview> {
    const session = this.hooks.resolveSession?.(input.sessionId)
    if (!session) {
      // Preview never throws for eligibility failures: a missing source is a
      // typed blocker, not an error (confirm/recover own the error surface).
      return this.blockedPreview(input, 'missing-source', 'The source session could not be resolved.', this.sessionFactsFallback(input.sessionId, this.deps.serverId))
    }
    const capability = this.hooks.resolveCapability?.(input.sessionId) ?? null
    const facts = await this.gatherFacts(input, session, capability)

    const blocked = facts.blocker
      ? { blocked: true as const, code: facts.blocker, reason: facts.blockerReason ?? '' }
      : undefined

    let preview: ConversationForkPreview
    if (blocked) {
      preview = {
        transactionId: newTransactionId(),
        previewFingerprint: sha256(JSON.stringify({ blocked: facts.blocker, at: facts.sourceCheckoutPath })),
        strategy: input.strategy,
        providerCapability: capability ?? { adapterId: 'unknown', strictCrossCwdNativeFork: false },
        source: facts.source,
        destination: facts.destination,
        excludedIgnoredPolicy: facts.excludedIgnoredPolicy,
        currentHead: facts.currentHead,
        blocked,
      }
      return preview
    }

    const transactionId = newTransactionId()
    const fingerprint = await this.computeFingerprint(input, session, facts, capability, transactionId)
    preview = {
      transactionId,
      previewFingerprint: fingerprint,
      strategy: input.strategy,
      providerCapability: capability ?? { adapterId: 'unknown', strictCrossCwdNativeFork: false },
      source: facts.source,
      destination: facts.destination,
      excludedIgnoredPolicy: facts.excludedIgnoredPolicy,
      currentHead: facts.currentHead,
    }

    if (input.strategy !== 'isolated-worktree') {
      // Shared-worktree forks reuse the existing branch/shared-checkout path
      // and own no transaction; only the isolated target does.
      return preview
    }

    return this.deps.registry.runExclusive(async () => {
      const existingJournal = this.deps.journal.inProgress().find(
        (entry) => entry.op === 'fork' && entry.sessionIds.includes(input.sessionId),
      )
      if (existingJournal) {
        return {
          ...preview,
          previewFingerprint: sha256(JSON.stringify({ blocked: 'fork-in-progress', sessionId: input.sessionId })),
          blocked: {
            blocked: true,
            code: 'fork-in-progress' as const,
            reason: 'A fork transaction is already in progress for this session.',
          },
        }
      }
      const transaction: ForkTransaction = {
        transactionId,
        sessionId: input.sessionId,
        strategy: input.strategy,
        state: 'pending',
        fingerprint,
        nameSuffix: facts.nameSuffix,
        pathToken: facts.pathToken,
        sourcePath: facts.sourceCheckoutPath,
        destinationPath: facts.destination.checkoutPath,
        repositoryRoot: facts.repositoryRoot,
        gitCommonDir: facts.gitCommonDir,
        expectedBranch: facts.expectedBranch,
        steps: [],
        journalId: '',
        providerCapability: capability ?? undefined,
        transcriptCwd: session.transcriptCwd,
        sourceLeases: [...facts.source.leases],
        startedAt: Date.now(),
      }
      const journal = this.deps.journal.begin({
        op: 'fork',
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
  // Seed capture (used by the confirm transaction in a later phase)
  // -------------------------------------------------------------------------

  /**
   * Capture a fingerprinted Phase 2 fork seed at the source checkout's exact
   * captured HEAD. The snapshot service is read-only on the checkout: it pins
   * the HEAD with a CAS-created hidden ref and copies supported staged,
   * unstaged, eligible untracked, and `.worktreeinclude` state without
   * cleaning or changing the source. Ignored files outside `.worktreeinclude`
   * do not copy. Capture failures map to typed fork errors; the caller decides
   * compensation.
   */
  async captureForkSeed(input: {
    checkoutPath: string
    repositoryRoot: string
    gitCommonDir: string
    expectedBranch: string
    baseRef: string | null
    ownerSessionIds: string[]
    policyVersion: number
    previewFingerprint: string
  }): Promise<{ snapshotId: string; fingerprint: string }> {
    const record: ManagedWorktreeRecordV2 = {
      schemaVersion: 2,
      managedWorktreeId: `fork-seed:${randomBytes(4).toString('hex')}`,
      workspaceId: 'fork',
      repositoryRoot: input.repositoryRoot,
      gitCommonDir: input.gitCommonDir,
      checkoutPath: input.checkoutPath,
      baseRef: input.baseRef,
      expectedBranch: input.expectedBranch,
      displayName: 'fork-seed',
      materializationRoot: '',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      policyVersion: input.policyVersion,
      ownerSessionIds: input.ownerSessionIds,
      state: 'ready',
    }
    const finalFingerprint = await computeWorktreeFingerprint({
      managedWorktreeId: record.managedWorktreeId,
      checkoutPath: input.checkoutPath,
      gitCommonDir: input.gitCommonDir,
      expectedBranch: input.expectedBranch,
      baseRef: input.baseRef,
      ownerSessionIds: input.ownerSessionIds,
      policyVersion: input.policyVersion,
      archivedOwnerSessionIds: [],
    })
    try {
      const { meta } = await this.deps.snapshots.capture({
        record,
        finalFingerprint,
        previewFingerprint: input.previewFingerprint,
        policyVersion: input.policyVersion,
      })
      this.seedRepositoryRoots.set(meta.snapshotId, input.repositoryRoot)
      return { snapshotId: meta.snapshotId, fingerprint: meta.fingerprint }
    } catch (error) {
      if (error instanceof WorktreeSnapshotError) {
        if (error.code === 'SNAPSHOT_LIMIT') {
          throw new ConversationForkError('FORK_SEED_LIMIT', sanitizeError(error))
        }
        throw new ConversationForkError('FORK_SEED_CAPTURE_FAILED', sanitizeError(error))
      }
      throw error
    }
  }

  /** Remove a fork seed: verify, CAS-delete its owned hidden ref, drop the payload. */
  async removeSeed(snapshotId: string, repositoryRoot: string): Promise<void> {
    const meta = this.deps.snapshots.loadSnapshotMeta(snapshotId)
    if (!meta) {
      this.seedRepositoryRoots.delete(snapshotId)
      return
    }
    try {
      await this.deps.snapshots.permanentDelete(repositoryRoot, meta)
    } catch (error) {
      if (error instanceof WorktreeSnapshotError) {
        throw new ConversationForkError('FORK_SEED_REMOVE_FAILED', sanitizeError(error))
      }
      throw error
    }
    this.seedRepositoryRoots.delete(snapshotId)
  }

  /** Repository root recorded for an in-process seed (Task 3 cleanup helper). */
  seedRepositoryRoot(snapshotId: string): string | undefined {
    return this.seedRepositoryRoots.get(snapshotId)
  }

  // -------------------------------------------------------------------------
  // Facts / blockers
  // -------------------------------------------------------------------------

  private async gatherFacts(
    input: ConversationForkPreviewInput,
    session: ForkSessionInfo,
    capability: ConversationForkProviderCapability | null,
    transactionIdToAllow?: string,
  ): Promise<ForkFacts> {
    const fail = (code: ConversationForkBlockerCode, reason: string, overrides: Partial<ForkFacts> = {}): ForkFacts =>
      ({ ...this.fallbackFacts(input.sessionId, session, this.deps.serverId), blocker: code, blockerReason: reason, currentHead, ...overrides })
    const isIsolated = input.strategy === 'isolated-worktree'
    // Current conversation head enforcement (isolated only). Computed up front
    // so blocked previews report the true head state.
    const forkPointMessageId = session.forkPointMessageId ?? session.conversationHead.messageId
    const currentHead = forkPointMessageId === session.conversationHead.messageId

    let sourcePath = resolvePath(session.checkoutPath)
    let repositoryRoot = sourcePath
    let gitCommonDir = ''
    let expectedBranch = ''
    let nameSuffix: string | undefined
    let pathToken: string | undefined

    // Early blockers (no Git inspection needed).
    if (!isGitWorkspaceV1Enabled() || !isWorktreeV2Enabled()) {
      return fail('flags-disabled', 'Required feature flags are disabled.')
    }
    if (isIsolated && (!capability || capability.strictCrossCwdNativeFork !== true)) {
      return fail('unsupported-provider', 'The provider adapter cannot establish a strict cross-CWD native fork.')
    }
    const existingTransaction = this.transactions.get(input.sessionId)
    if (existingTransaction && existingTransaction.transactionId !== transactionIdToAllow) {
      if (existingTransaction.state === 'pending') {
        // A fresh preview supersedes a stale pending preview. A pending
        // transaction has never mutated anything (quiescence and capture
        // happen at confirm), so cancelling it is safe and keeps dialog
        // re-opens from stranding the session with a fenced transaction.
        if (existingTransaction.journalId) {
          this.deps.journal.recover(existingTransaction.journalId, 'preview-superseded')
        }
        this.transactions.delete(input.sessionId)
      } else {
        return fail('fork-in-progress', 'A fork transaction is already in progress for this session.')
      }
    }
    if (isIsolated && this.deps.journal.inProgress().some(
      (entry) => entry.op === 'fork' && entry.sessionIds.includes(input.sessionId),
    )) {
      return fail('fork-in-progress', 'A fork transaction is already in progress for this session.')
    }
    if (this.deps.lifecycle.isCleanupInProgress()) {
      return fail('cleanup-in-progress', 'Worktree lifecycle cleanup is running; try again shortly.')
    }

    if (!existsSync(sourcePath)) {
      return fail('missing-source', 'The source checkout path does not exist.')
    }

    const sourceCtx = await this.deps.repository.getContext(sourcePath)
    if (!sourceCtx.isGitRepository || !sourceCtx.gitCommonDir) {
      return fail('missing-source', 'The source checkout is not a readable Git worktree.')
    }
    gitCommonDir = sourceCtx.gitCommonDir
    repositoryRoot = sourceCtx.repositoryRoot ?? sourcePath
    // Legacy/current sessions may retain a nested working directory. The
    // canonical current checkout is the repository root; snapshots, leases,
    // and fingerprints must all use that root (spec: canonicalized, leased,
    // and fingerprinted through the owning server).
    if (sourceCtx.repositoryRoot) {
      sourcePath = resolvePath(sourceCtx.repositoryRoot)
      repositoryRoot = sourcePath
    }

    // Owner set: a managed source may have multiple owners; every owner must
    // be idle, quiesceable, and covered by a stable path lease during capture.
    let ownerSessionIds = [input.sessionId]
    if (session.checkout?.mode === 'managed-worktree' && session.checkout.managedWorktreeId) {
      const record = this.deps.registry.get(session.checkout.managedWorktreeId)
      if (!record || record.state !== 'ready' || !existsSync(record.checkoutPath)) {
        return fail('missing-source', 'The managed worktree is snapshotted or missing; restore it before forking.')
      }
      if (resolvePath(record.gitCommonDir) !== resolvePath(gitCommonDir)) {
        return fail('missing-source', 'The managed worktree no longer belongs to the recorded repository.')
      }
      sourcePath = resolvePath(record.checkoutPath)
      repositoryRoot = record.repositoryRoot
      ownerSessionIds = [...record.ownerSessionIds]
    }

    // Current conversation head enforcement (isolated only).
    if (isIsolated && !currentHead) {
      return fail('non-head-source', 'Isolated forks are only available at the current conversation head.')
    }

    // Every source owner must be idle.
    for (const owner of ownerSessionIds) {
      if (this.hooks.isSessionActive?.(owner)) {
        return fail('source-active', `Source owner ${owner} has an active turn; forking requires idle runtimes.`)
      }
    }

    // No foreign lease may occupy the source path; every owner must be
    // leaseable. Confirm (later phase) takes the stable leases under lock.
    const foreignLeases = this.deps.leases.leasedBy(sourcePath).filter((id) => !ownerSessionIds.includes(id))
    if (foreignLeases.length > 0) {
      return fail('path-unleased', 'Another session or runtime leases the source path.')
    }

    // Supported Git state: no in-progress operation, no unmerged index.
    const status = await this.deps.repository.getStatus(sourcePath)
    if (status.operationInProgress || status.entries.some((entry) => entry.conflicted)) {
      return fail('git-operation-in-progress', 'A Git operation is in progress or the index is unmerged.')
    }

    if (sourceCtx.detached) {
      return fail('unsupported-snapshot', 'The source checkout is on a detached HEAD; a fork seed cannot be captured.')
    }

    const counts = await this.transferableStateCounts(sourcePath)
    const included = await listWorktreeIncludeFiles(sourcePath)
    const includedIgnored = included.filter((path) => !counts.untracked.includes(path))

    // Destination identity (isolated only).
    let destination: ConversationForkPreview['destination']
    if (isIsolated) {
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
        return { ...fail('invalid-name', 'The requested worktree name is not a valid Git branch suffix.'), destination, expectedBranch, nameSuffix, pathToken }
      }
      if (destination.exists || lstatSyncSafe(destinationPath) === 'symlink') {
        return { ...fail('name-collision', 'The requested worktree name resolves to an occupied destination.'), destination, expectedBranch, nameSuffix, pathToken }
      }
      if (await this.branchOccupied(repositoryRoot, expectedBranch)) {
        return { ...fail('name-collision', `The branch ${expectedBranch} is already in use.`), destination, expectedBranch, nameSuffix, pathToken }
      }
    } else {
      // Shared-worktree destination IS the source checkout (the child shares it).
      destination = {
        serverId: this.deps.serverId,
        repositoryRoot,
        branch: sourceCtx.currentBranch ?? '',
        checkoutPath: sourcePath,
        exists: true,
        leases: this.deps.leases.leasedBy(sourcePath),
      }
    }

    // Seed-capture feasibility: unsupported state or oversize are typed
    // blockers at preview time (authoritative enforcement stays at capture).
    try {
      await this.deps.snapshots.assertSupportedState(sourcePath)
    } catch (error) {
      if (error instanceof WorktreeSnapshotError) {
        return { ...fail('unsupported-snapshot', sanitizeError(error)), destination, expectedBranch, nameSuffix, pathToken, currentHead }
      }
      throw error
    }
    if (isIsolated && await this.estimateSeedOversize(sourcePath, counts, includedIgnored)) {
      return { ...fail('oversized-capture', `The source state exceeds the snapshot limit (${WORKTREE_SNAPSHOT_MAX_FILES} files / ${WORKTREE_SNAPSHOT_MAX_BYTES} bytes).`), destination, expectedBranch, nameSuffix, pathToken, currentHead }
    }

    return {
      blocker: null,
      source: {
        serverId: this.deps.serverId,
        sessionId: input.sessionId,
        conversationHeadMessageId: session.conversationHead.messageId,
        conversationHeadTurnId: session.conversationHead.turnId,
        checkout: {
          mode: session.checkout?.mode ?? 'current',
          ...(session.checkout?.managedWorktreeId ? { managedWorktreeId: session.checkout.managedWorktreeId } : {}),
        },
        branch: sourceCtx.currentBranch ?? null,
        headSha: sourceCtx.headSha,
        gitState: {
          state: sourceCtx.detached
            ? 'detached'
            : counts.staged + counts.unstaged + counts.untracked.length > 0
              ? 'dirty'
              : 'clean',
          stagedFileCount: counts.staged,
          unstagedFileCount: counts.unstaged,
          untrackedFileCount: counts.untracked.length,
          includedIgnoredFileCount: includedIgnored.length,
        },
        leases: this.deps.leases.leasedBy(sourcePath),
      },
      destination,
      excludedIgnoredPolicy: { includeOnly: true, includeFileCount: includedIgnored.length },
      currentHead,
      sourceCheckoutPath: sourcePath,
      repositoryRoot,
      gitCommonDir,
      expectedBranch,
      nameSuffix,
      pathToken,
      ownerSessionIds,
    }
  }

  /** Minimal source/destination facts used by blocked previews. */
  private fallbackFacts(sessionId: string, session: ForkSessionInfo, serverId: string): ForkFacts {
    return {
      blocker: null,
      source: {
        serverId,
        sessionId,
        conversationHeadMessageId: session.conversationHead?.messageId ?? '',
        conversationHeadTurnId: session.conversationHead?.turnId ?? '',
        checkout: { mode: session.checkout?.mode ?? 'current' },
        branch: null,
        headSha: null,
        gitState: { state: 'clean', stagedFileCount: 0, unstagedFileCount: 0, untrackedFileCount: 0, includedIgnoredFileCount: 0 },
        leases: [],
      },
      destination: {
        serverId,
        repositoryRoot: resolvePath(session.checkoutPath),
        branch: '',
        checkoutPath: '',
        exists: false,
        leases: [],
      },
      excludedIgnoredPolicy: { includeOnly: true, includeFileCount: 0 },
      currentHead: true,
      sourceCheckoutPath: resolvePath(session.checkoutPath),
      repositoryRoot: resolvePath(session.checkoutPath),
      gitCommonDir: '',
      expectedBranch: '',
      ownerSessionIds: [],
    }
  }

  /** Blocked preview for a session that could not be resolved at all. */
  private blockedPreview(
    input: ConversationForkPreviewInput,
    code: ConversationForkBlockerCode,
    reason: string,
    facts: ForkFacts,
  ): ConversationForkPreview {
    return {
      transactionId: newTransactionId(),
      previewFingerprint: sha256(JSON.stringify({ blocked: code })),
      strategy: input.strategy,
      providerCapability: { adapterId: 'unknown', strictCrossCwdNativeFork: false },
      source: facts.source,
      destination: facts.destination,
      excludedIgnoredPolicy: facts.excludedIgnoredPolicy,
      currentHead: facts.currentHead,
      blocked: { blocked: true, code, reason },
    }
  }

  /** Session facts helper for the unknown-session fallback. */
  private sessionFactsFallback(sessionId: string, serverId: string): ForkFacts {
    return {
      blocker: null,
      source: {
        serverId,
        sessionId,
        conversationHeadMessageId: '',
        conversationHeadTurnId: '',
        checkout: { mode: 'current' },
        branch: null,
        headSha: null,
        gitState: { state: 'clean', stagedFileCount: 0, unstagedFileCount: 0, untrackedFileCount: 0, includedIgnoredFileCount: 0 },
        leases: [],
      },
      destination: {
        serverId,
        repositoryRoot: '',
        branch: '',
        checkoutPath: '',
        exists: false,
        leases: [],
      },
      excludedIgnoredPolicy: { includeOnly: true, includeFileCount: 0 },
      currentHead: true,
      sourceCheckoutPath: '',
      repositoryRoot: '',
      gitCommonDir: '',
      expectedBranch: '',
      ownerSessionIds: [],
    }
  }

  /** Counts of the exact supported state a fork seed would capture. */
  private async transferableStateCounts(checkoutPath: string): Promise<{
    staged: number
    unstaged: number
    untracked: string[]
  }> {
    const staged = splitNul((await runGit(['diff', '--cached', '--name-only', '-z'], { cwd: checkoutPath })).stdout)
    const unstaged = splitNul((await runGit(['diff', '--name-only', '-z'], { cwd: checkoutPath })).stdout)
    const untracked = splitNul(
      (await runGit(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: checkoutPath })).stdout,
    )
    return { staged: staged.length, unstaged: unstaged.length, untracked }
  }

  /**
   * Dry oversize estimate for the preview (name-only lists + stat sizes).
   * Authoritative enforcement happens inside the snapshot capture; this is a
   * conservative preview-time blocker so the dialog can disable isolated with
   * a typed reason without writing a seed.
   */
  private async estimateSeedOversize(
    checkoutPath: string,
    counts: { staged: number; unstaged: number; untracked: string[] },
    includedIgnored: string[],
  ): Promise<boolean> {
    const fileCount = counts.staged + counts.unstaged + counts.untracked.length + includedIgnored.length
    if (fileCount > WORKTREE_SNAPSHOT_MAX_FILES) return true
    let estimatedBytes = 0
    for (const rel of [...counts.untracked, ...includedIgnored]) {
      if (!rel || rel.includes('\0') || rel.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(rel)) continue
      try {
        const stat = lstatSync(join(checkoutPath, rel))
        if (stat.isSymbolicLink()) continue
        if (!stat.isFile()) continue
        estimatedBytes += stat.size
        if (estimatedBytes > WORKTREE_SNAPSHOT_MAX_BYTES) return true
      } catch {
        // disappeared between listing and estimate — not counted
      }
    }
    return false
  }

  private async branchOccupied(repositoryRoot: string, branch: string): Promise<boolean> {
    const ref = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd: repositoryRoot,
      okExitCodes: [1, 128],
    })
    if (ref.exitCode === 0) return true
    const worktrees = await runGit(['worktree', 'list', '--porcelain'], { cwd: repositoryRoot })
    const expected = `branch refs/heads/${branch}`
    return worktrees.stdout.split('\n').some((line) => line.trim() === expected)
  }

  private transactionMetadata(txn: ForkTransaction): Record<string, unknown> {
    return {
      transactionId: txn.transactionId,
      strategy: txn.strategy,
      state: txn.state,
      nameSuffix: txn.nameSuffix ?? null,
      pathToken: txn.pathToken ?? null,
      sourcePath: txn.sourcePath,
      destinationPath: txn.destinationPath,
      repositoryRoot: txn.repositoryRoot,
      gitCommonDir: txn.gitCommonDir,
      expectedBranch: txn.expectedBranch,
      providerAdapterId: txn.providerCapability?.adapterId ?? null,
      sourceLeases: txn.sourceLeases,
    }
  }

  private async computeFingerprint(
    input: ConversationForkPreviewInput,
    session: ForkSessionInfo,
    facts: ForkFacts,
    capability: ConversationForkProviderCapability | null,
    transactionId: string,
  ): Promise<string> {
    const hash = createHash('sha256')
    hash.update('kata-isolated-conversation-fork-v1\0')
    // Source side: reuse the lifecycle fingerprint — it binds repository
    // identity, HEAD, branch, index, working tree, untracked/included state,
    // owner set, and policy version.
    hash.update(
      await computeWorktreeFingerprint({
        managedWorktreeId: `fork:${facts.sourceCheckoutPath}`,
        checkoutPath: facts.sourceCheckoutPath,
        gitCommonDir: facts.gitCommonDir,
        expectedBranch: facts.source.branch ?? '',
        baseRef: null,
        ownerSessionIds: facts.ownerSessionIds,
        policyVersion: this.deps.settings.getSnapshot(this.deps.serverId).version,
        archivedOwnerSessionIds: [],
      }),
    )
    hash.update('\0')
    hash.update(
      JSON.stringify({
        strategy: input.strategy,
        currentHead: facts.currentHead,
        conversationHead: {
          messageId: session.conversationHead.messageId,
          turnId: session.conversationHead.turnId,
        },
        forkPoint: {
          messageId: session.forkPointMessageId ?? session.conversationHead.messageId,
          turnId: session.forkPointTurnId ?? session.conversationHead.turnId,
        },
        destination: {
          serverId: facts.destination.serverId,
          repositoryRoot: facts.destination.repositoryRoot,
          branch: facts.destination.branch,
          checkoutPath: facts.destination.checkoutPath,
          exists: facts.destination.exists,
          leases: [...facts.destination.leases].sort(),
        },
        nameSuffix: facts.nameSuffix ?? null,
        excludedIgnoredPolicy: facts.excludedIgnoredPolicy,
        capability: capability ?? { adapterId: 'unknown', strictCrossCwdNativeFork: false },
        transcriptCwd: session.transcriptCwd,
        ownerSessionIds: [...facts.ownerSessionIds].sort(),
        allPathLeases: [...this.deps.leases.allLeases().entries()]
          .map(([owner, paths]) => [owner, [...paths].sort()])
          .sort(([a], [b]) => String(a).localeCompare(String(b))),
      }),
    )
    return hash.digest('hex')
  }
}
