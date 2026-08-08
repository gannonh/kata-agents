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
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import type {
  ConversationForkBlockerCode,
  ConversationForkCancelInput,
  ConversationForkCommitSummary,
  ConversationForkConfirmInput,
  ConversationForkPreview,
  ConversationForkPreviewInput,
  ConversationForkProviderCapability,
  ConversationForkRecoverInput,
  ConversationForkRecoveryState,
  ConversationForkResult,
  ConversationForkStatus,
  ConversationForkStatusInput,
  ConversationForkStrategy,
  ManagedWorktreeRecordV2,
  ManagedWorktreeSnapshotMeta,
  SessionCheckout,
  SessionCheckoutV2,
} from '@kata-sh/shared/protocol'
import { CONVERSATION_FORK_RECOVERY_STATES } from '@kata-sh/shared/protocol'
import { isGitWorkspaceV1Enabled, isWorktreeV2Enabled } from '@kata-sh/shared/feature-flags'
import type { StrictConversationForkCapability } from '@kata-sh/shared/agent/backend'
import { runGit, runGitBuffer, splitNul } from './command-runner'
import { removeCheckoutFiles } from './managed-worktree-service'
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
import type { WorktreeJournal, WorktreeJournalEntry } from './worktree-journal'
import type { WorktreeLifecycleService } from './worktree-lifecycle-service'
import type { RepositoryService } from './repository-service'
import type { WorktreeRegistry } from './worktree-registry'
import type { WorktreeSettingsService } from './worktree-settings-service'

export type ConversationForkErrorCode =
  | 'FORK_SESSION_UNKNOWN'
  | 'FORK_TRANSACTION_UNKNOWN'
  | 'FORK_STRATEGY_MISMATCH'
  | 'FORK_NOT_IMPLEMENTED'
  | 'FORK_HOOK_NOT_WIRED'
  | 'FORK_TARGET_FAILED'
  | 'FORK_COMPENSATION_FAILED'
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

/** True when `child` is contained within `parent` (both resolved, non-empty). */
function isContainedPath(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** Resolve a path, following symlinks when possible (tolerant of absence). */
function realpathSafe(path: string): string {
  try {
    return resolvePath(realpathSync(path))
  } catch {
    return resolvePath(path)
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

/** Host input for durable child-session creation of an isolated fork. */
export interface ConversationForkChildSessionInput {
  transactionId: string
  /** Source Kata session the fork is created from. */
  parentSessionId: string
  /** Parent provider SDK session identity (anchor lineage). */
  parentSdkSessionId: string | undefined
  /** Parent provider turn anchor at the branch point. */
  parentSdkTurnId: string | undefined
  /** Immutable transcript lookup identity — never rewritten by the fork. */
  transcriptCwd: string
  /** Destination execution CWD every runtime must resolve to. */
  executionCwd: string
  /** Durable checkout binding for the isolated target (always a V2 managed worktree). */
  checkout: SessionCheckoutV2
  /** Generated/edited name suffix of the target worktree. */
  nameSuffix: string
  /** Source message ID at the current conversation head (the branch point). */
  sourceMessageId: string
  workspaceId: string
  /** Requested fork point message ID (the current conversation head for isolated). */
  forkPointMessageId: string
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
  /**
   * Create the durable child Kata session for an isolated fork target. The
   * service journals the returned child session id after the hook returns;
   * the child must not be visible to the client until the commit marker is
   * durable. Absent hook → typed hook-not-wired error, never a fabricated
   * child. SessionManager implements this in a later phase.
   */
  createForkChildSession?: (input: ConversationForkChildSessionInput) => Promise<string>
  /**
   * Remove a child Kata session created by a rolled-back fork transaction
   * (compensation). Absent hook → the compensation fails closed and the
   * transaction stays recovery-required.
   */
  deleteForkChildSession?: (childSessionId: string) => Promise<void>
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

/** One in-flight fork transaction (preview → confirm → recover/cancel). */
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
  /** Source HEAD OID pinned by the captured seed (journaled before capture). */
  headOid?: string
  /** Seed snapshot id captured by this transaction (GC-retained until commit). */
  seedSnapshotId?: string
  /** Managed worktree record id of the materialized target. */
  managedWorktreeId?: string
  /** Child session id returned by the host hook (journaled after creation). */
  childSessionId?: string
  /** Child checkout binding built from the materialized target. */
  childCheckout?: SessionCheckoutV2
  /** Commit timestamp, set when the binding commits. */
  committedAt?: number
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
  // Status
  // -------------------------------------------------------------------------

  /**
   * Status of the session's fork transaction: the live in-memory transaction
   * when one exists, otherwise a durable in-progress journal transaction
   * (restart). The reported state prefers the durable journal metadata state
   * (the authoritative "how far did we get" signal) over the in-memory one.
   */
  async status(input: ConversationForkStatusInput): Promise<ConversationForkStatus> {
    const sessionId = input.sessionId
    const txn = this.transactions.get(sessionId)
    if (txn) {
      const entry = this.deps.journal.entries().find((candidate) => candidate.journalId === txn.journalId)
      return this.statusFor(txn, entry)
    }
    const entry = this.deps.journal.entries().find(
      (candidate) =>
        candidate.op === 'fork' && candidate.sessionIds.includes(sessionId) && candidate.status === 'in-progress',
    )
    if (!entry) return { active: false }
    const rehydrated = this.rehydrateTransaction(entry, sessionId)
    if (!rehydrated) return { active: false }
    return this.statusFor(rehydrated, entry)
  }

  /** Build the active status payload for a transaction (optionally with its journal entry). */
  private statusFor(txn: ForkTransaction, entry?: WorktreeJournalEntry): ConversationForkStatus {
    // Prefer the durable journal metadata state over the in-memory one for any
    // unresolved entry (in-progress AND failed/recovery-required): the journal
    // is the authoritative "how far did we get" signal, and a compensation
    // failure must surface as recovery-required, not as the stale in-memory
    // step state the transaction had when the confirm threw. Journal-internal
    // markers outside the protocol union (preview-cancelled, rolled-back) are
    // never surfaced: a corrupted journal cannot leak a non-union wire value.
    const durableState = entry?.metadata?.state
    const state: ConversationForkRecoveryState =
      entry && entry.status !== 'committed' && typeof durableState === 'string'
        ? CONVERSATION_FORK_RECOVERY_STATES.includes(durableState as ConversationForkRecoveryState)
          ? (durableState as ConversationForkRecoveryState)
          : txn.state
        : txn.state
    return {
      active: true,
      transactionId: txn.transactionId,
      strategy: txn.strategy,
      state,
      // The fork seed is the retained snapshot authority backing rollback/recovery.
      ...(txn.seedSnapshotId ? { retainedSnapshotId: txn.seedSnapshotId } : {}),
      since: txn.startedAt,
      // Before the first Send the child provider identity is always pending.
      providerIdentity: { status: 'pending' },
    }
  }

  // -------------------------------------------------------------------------
  // Establishment
  // -------------------------------------------------------------------------

  /**
   * Record the child's first-Send provider establishment on the committed
   * fork journal entry (metadata-only; the entry status stays 'committed').
   * The child session record is authoritative: returns false when the
   * committed entry is missing (the caller logs-and-continues, never fails
   * Send for a bookkeeping miss).
   */
  markEstablished(transactionId: string, childSdkSessionId: string): boolean {
    const entry = this.deps.journal.entries().find(
      (candidate) => candidate.op === 'fork' && candidate.recordId === transactionId,
    )
    if (!entry || entry.status !== 'committed') {
      // Missing/not-yet-committed journal entry: the durable child session
      // record is authoritative; skip without failing the establishment.
      return false
    }
    this.deps.journal.updateMetadata(entry.journalId, {
      state: 'established',
      childSdkSessionId,
      establishedAt: Date.now(),
    })
    return true
  }

  // -------------------------------------------------------------------------
  // Cancel
  // -------------------------------------------------------------------------

  /**
   * Cancel a pending preview transaction (dialog dismissed without confirming).
   * Only a transaction whose durable journal entry is still a pure PENDING
   * preview may be cancelled: any journaled confirm step (quiescence, seed
   * capture, materialization, …) means the confirm is in flight and must not
   * be discarded — recovery continues through recover(). The durable entry is
   * recovered with a `preview-cancelled` marker so a restarted server never
   * treats the dismissed preview as an in-progress fork (re-preview stays
   * possible). Returns the post-cancel status.
   */
  async cancel(input: ConversationForkCancelInput): Promise<ConversationForkStatus> {
    const sessionId = input.sessionId
    const inMemory = this.transactions.get(sessionId)
    if (inMemory && inMemory.transactionId !== input.transactionId) return this.status(input)
    const entry = this.deps.journal.entries().find(
      (candidate) =>
        candidate.op === 'fork' &&
        candidate.recordId === input.transactionId &&
        candidate.sessionIds.includes(sessionId),
    )
    if (!entry) return this.status(input)
    const gitCommonDir =
      typeof entry.metadata?.gitCommonDir === 'string' ? entry.metadata.gitCommonDir : undefined
    // Serialize with confirm: a confirm may be revalidating before its first
    // journal step, during which the durable entry still looks like a pure
    // pending preview. Without the lock, a cancel in that window would mark
    // the entry preview-cancelled while the in-flight confirm durably commits
    // a child the journal no longer records. Taking the same common-directory
    // mutation lock makes the guard below effective: once confirm has started
    // (or finished), its first journal step (or commit marker) is durable and
    // the cancel is refused.
    if (!gitCommonDir) return this.status(input)
    return this.deps.mutationLock.withLock(gitCommonDir, async () => {
      const latest = this.deps.journal.entries().find(
        (candidate) =>
          candidate.op === 'fork' &&
          candidate.recordId === input.transactionId &&
          candidate.sessionIds.includes(sessionId),
      )
      if (
        !latest ||
        latest.status !== 'in-progress' ||
        latest.steps.length > 0 ||
        latest.metadata?.state !== 'pending'
      ) {
        return this.status(input)
      }
      this.deps.journal.updateMetadata(latest.journalId, { state: 'preview-cancelled', cancelledAt: Date.now() })
      this.deps.journal.recover(latest.journalId, 'preview-cancelled')
      this.transactions.delete(sessionId)
      return { active: false }
    })
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
    recordLookup?: (id: string) => ManagedWorktreeRecordV2 | undefined,
    options?: { allowOwnedDestination?: boolean; ownedLeaseId?: string },
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
      (entry) => entry.op === 'fork' && entry.sessionIds.includes(input.sessionId) && entry.recordId !== transactionIdToAllow,
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
      const record = (recordLookup ?? ((id: string) => this.deps.registry.get(id)))(session.checkout.managedWorktreeId)
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

    if (isIsolated && sourceCtx.detached) {
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
      // An interrupted-transaction replay treats the transaction's own
      // materialized destination as the as-of-preview value: the collision
      // checks and the fingerprint then revalidate the ORIGINAL preview facts
      // instead of the transaction's own effects, so a crash after target
      // materialization stays resumable (name-collision would otherwise block
      // the transaction's own destination forever).
      const ownedDestination = options?.allowOwnedDestination === true
      destination = {
        serverId: this.deps.serverId,
        repositoryRoot: sourceCtx.repositoryRoot ?? sourcePath,
        branch: expectedBranch,
        checkoutPath: destinationPath,
        exists: ownedDestination ? false : existsSync(destinationPath),
        leases: this.deps.leases
          .leasedBy(destinationPath)
          .filter((owner) => owner !== options?.ownedLeaseId),
      }
      const nameValid = nameSuffix.trim() === nameSuffix && nameSuffix.length > 0 && !nameSuffix.includes('\0')
      const refCheck = nameValid
        ? await runGit(['check-ref-format', '--branch', expectedBranch], { cwd: sourcePath, okExitCodes: [1, 128] })
        : null
      if (!nameValid || !refCheck || refCheck.exitCode !== 0) {
        return { ...fail('invalid-name', 'The requested worktree name is not a valid Git branch suffix.'), destination, expectedBranch, nameSuffix, pathToken }
      }
      if (!ownedDestination && (destination.exists || lstatSyncSafe(destinationPath) === 'symlink')) {
        return { ...fail('name-collision', 'The requested worktree name resolves to an occupied destination.'), destination, expectedBranch, nameSuffix, pathToken }
      }
      if (!ownedDestination && (await this.branchOccupied(repositoryRoot, expectedBranch))) {
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

    // Seed-capture feasibility (isolated only — shared forks capture no seed):
    // unsupported state or oversize are typed blockers at preview time
    // (authoritative enforcement stays at capture).
    if (isIsolated) {
      try {
        await this.deps.snapshots.assertSupportedState(sourcePath)
      } catch (error) {
        if (error instanceof WorktreeSnapshotError) {
          return { ...fail('unsupported-snapshot', sanitizeError(error)), destination, expectedBranch, nameSuffix, pathToken, currentHead }
        }
        throw error
      }
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

  // -------------------------------------------------------------------------
  // Confirm (durable target/child transaction core)
  // -------------------------------------------------------------------------

  /**
   * Commit the isolated target + child session through the durable fork
   * journal. Revalidates every preview-bound fact under the common-directory
   * mutation lock + registry lock, captures the fingerprinted seed, materializes
   * and restores the target, creates the child session through the host hook,
   * and commits the registry owner + journal marker before the child is
   * visible. Pre-publication failures compensate only transaction-owned
   * artifacts with CAS proof. A repeated confirm with the same transactionId
   * after an interrupt continues from the journal without double-creating
   * target/child/owner.
   */
  async confirm(input: ConversationForkConfirmInput): Promise<ConversationForkResult> {
    if (input.strategy !== 'isolated-worktree') {
      // Shared-worktree forks own no transaction and reuse the existing
      // branch/shared-checkout path; their confirmation is a later task.
      throw new ConversationForkError('FORK_NOT_IMPLEMENTED', 'Shared-worktree fork confirmation is not implemented by the isolated transaction core.')
    }
    const resolved = this.resolveConfirmTransaction(input)
    if (!resolved) {
      throw new ConversationForkError('FORK_TRANSACTION_UNKNOWN', 'Unknown fork transaction.')
    }
    const txn = resolved.txn
    if (txn.strategy !== input.strategy) {
      throw new ConversationForkError('FORK_STRATEGY_MISMATCH', 'Fork strategy does not match the transaction.')
    }
    if (!input.worktreeNameSuffix) {
      throw new ConversationForkError('FORK_STRATEGY_MISMATCH', 'An isolated fork confirmation requires the worktree name suffix from the preview.')
    }
    return this.enterLockedResume(input, txn, resolved.committedSummary)
  }

  /**
   * Recover an interrupted fork transaction by re-entering the locked
   * confirm/resume machinery. The recover input carries only sessionId +
   * transactionId, so the resume validates against the transaction's OWN
   * journaled fingerprint and name (recover never accepts a client-supplied
   * fingerprint). A committed journal entry returns its summary idempotently;
   * a rolled-back entry starts a fresh attempt through the same resolution
   * confirm uses.
   */
  async recover(input: ConversationForkRecoverInput): Promise<ConversationForkResult> {
    const resolved = this.resolveConfirmTransaction(input)
    if (!resolved) {
      throw new ConversationForkError('FORK_TRANSACTION_UNKNOWN', 'Unknown fork transaction.')
    }
    return this.enterLockedResume(
      this.confirmInputFromTxn(resolved.txn, input.sessionId),
      resolved.txn,
      resolved.committedSummary,
    )
  }

  /** Rebuild the confirm input a resume uses from the transaction's journaled facts. */
  private confirmInputFromTxn(txn: ForkTransaction, sessionId: string): ConversationForkConfirmInput {
    return {
      sessionId,
      strategy: txn.strategy,
      transactionId: txn.transactionId,
      previewFingerprint: txn.fingerprint,
      worktreeNameSuffix: txn.nameSuffix,
    }
  }

  /**
   * Shared preamble of confirm and recover: resolve hooks, validate capability
   * wiring, then re-enter the locked confirm/resume core. A committed
   * transaction returns its durable summary instead of re-running. Recovery
   * re-enters with the transaction's journaled fingerprint; confirm with the
   * client's preview fingerprint (both revalidated inside confirmLocked).
   */
  private async enterLockedResume(
    input: ConversationForkConfirmInput,
    txn: ForkTransaction,
    committedSummary?: ConversationForkCommitSummary,
  ): Promise<ConversationForkResult> {
    if (committedSummary) {
      // A repeated confirm/recover after the durable commit returns the
      // committed summary instead of double-creating a target/child/owner.
      return { outcome: 'committed', transactionId: txn.transactionId, summary: committedSummary }
    }
    const session = this.hooks.resolveSession?.(input.sessionId)
    if (!session) throw new ConversationForkError('FORK_SESSION_UNKNOWN', 'Unknown session for fork confirmation.')
    const capability = this.hooks.resolveCapability?.(input.sessionId) ?? null
    if (!capability || capability.strictCrossCwdNativeFork !== true) {
      this.deps.journal.fail(txn.journalId, 'The provider adapter cannot establish a strict cross-CWD native fork.')
      this.transactions.delete(input.sessionId)
      return this.blockedResult(txn, 'unsupported-provider', 'The provider adapter cannot establish a strict cross-CWD native fork.')
    }
    if (!this.hooks.createForkChildSession || !this.hooks.deleteForkChildSession) {
      this.deps.journal.fail(txn.journalId, 'Fork child-session hooks are not wired.')
      this.transactions.delete(input.sessionId)
      throw new ConversationForkError(
        'FORK_HOOK_NOT_WIRED',
        'Isolated fork confirmation requires a wired child-session creation hook.',
      )
    }

    return this.deps.mutationLock.withLock<ConversationForkResult>(txn.gitCommonDir, async () => {
      return this.confirmLocked(txn, input, session, capability)
    })
  }

  /**
   * Revalidation + mutation core of confirm, running under the git lock.
   * Re-entrant for an interrupted transaction: completed journal steps are
   * skipped, so a repeated confirm never double-creates target/child/owner.
   */
  private async confirmLocked(
    txn: ForkTransaction,
    input: ConversationForkConfirmInput,
    session: ForkSessionInfo,
    capability: ConversationForkProviderCapability,
  ): Promise<ConversationForkResult> {
    // Durability guard under the mutation lock: cancel() serializes on this
    // same lock, so by the time we hold it either a queued cancel already
    // recovered the entry as `preview-cancelled` (or a new preview superseded
    // it) — the journal is authoritative and a cancelled entry must never
    // receive a child commit. If the entry is no longer in-progress, abort
    // with the typed transaction-unknown error instead of mutating.
    const durableEntry = this.deps.journal.entries().find(
      (candidate) =>
        candidate.op === 'fork' &&
        candidate.journalId === txn.journalId &&
        candidate.sessionIds.includes(txn.sessionId),
    )
    if (!durableEntry || durableEntry.status !== 'in-progress') {
      throw new ConversationForkError(
        'FORK_TRANSACTION_UNKNOWN',
        'The fork transaction is no longer in progress (cancelled or superseded).',
      )
    }
    // Re-gather facts + revalidate every preview-bound fact under the registry
    // lock so a concurrent owner bind / lifecycle decision cannot interleave
    // between the revalidation and the capture.
    const revalidation = await this.deps.registry.runExclusive(async (tx) => {
      const gathered = await this.gatherFacts(
        {
          sessionId: input.sessionId,
          strategy: txn.strategy,
          worktreeNameSuffix: input.worktreeNameSuffix,
        },
        session,
        capability,
        txn.transactionId,
        (id: string) => tx.get(id),
        {
          // A transaction that already materialized its target must not be
          // blocked by its own destination when resuming after a crash.
          allowOwnedDestination: txn.steps.includes('target-materialized'),
          ownedLeaseId: `fork:${txn.transactionId}`,
        },
      )
      if (gathered.blocker) {
        this.deps.journal.fail(txn.journalId, gathered.blockerReason ?? 'Fork precondition failed.')
        this.transactions.delete(input.sessionId)
        return { blocked: this.blockedResult(txn, gathered.blocker, gathered.blockerReason ?? 'Fork precondition failed.') }
      }
      // Path-unleased at confirm: EVERY source owner must now hold a stable
      // lease on the canonical source path (the preview only blocked foreign
      // leases).
      const sourceLeases = this.deps.leases.leasedBy(gathered.sourceCheckoutPath)
      const unleasedOwners = gathered.ownerSessionIds.filter((owner) => !sourceLeases.includes(owner))
      if (unleasedOwners.length > 0 || sourceLeases.some((owner) => !gathered.ownerSessionIds.includes(owner))) {
        this.deps.journal.fail(txn.journalId, 'A source path owner or lease is missing at confirm.')
        this.transactions.delete(input.sessionId)
        return {
          blocked: this.blockedResult(
            txn,
            'path-unleased',
            unleasedOwners.length > 0
              ? `Source owner ${unleasedOwners[0]} does not hold a stable lease on the source path.`
              : 'A foreign session or runtime leases the source path.',
          ),
        }
      }
      // Fork-in-progress re-check: no other pending fork may own the source or
      // the target paths.
      if (this.isForkInProgressFor(txn)) {
        this.deps.journal.fail(txn.journalId, 'Another fork transaction is in progress for the source or target.')
        this.transactions.delete(input.sessionId)
        return { blocked: this.blockedResult(txn, 'fork-in-progress', 'Another fork transaction is in progress for the source or target.') }
      }
      const freshFingerprint = await this.computeFingerprint(
        { sessionId: input.sessionId, strategy: txn.strategy, worktreeNameSuffix: input.worktreeNameSuffix },
        session,
        gathered,
        capability,
        txn.transactionId,
        // Exclude this transaction's own destination lease (if held) so the
        // revalidation fingerprint matches the preview, not the txn's effects.
        `fork:${txn.transactionId}`,
      )
      if (freshFingerprint !== txn.fingerprint || input.previewFingerprint !== txn.fingerprint) {
        this.deps.journal.fail(txn.journalId, 'The fork facts changed after the preview.')
        this.transactions.delete(input.sessionId)
        return { blocked: this.blockedResult(txn, 'identity-drift', 'The fork facts changed after the preview; inspect it again.') }
      }
      return { facts: gathered }
    })
    if (revalidation.blocked) return revalidation.blocked
    const facts = revalidation.facts
    if (!facts) throw new ConversationForkError('FORK_TARGET_FAILED', 'Fork facts could not be gathered.')

    this.journalStep(txn, 'locks-acquired')

    // Source quiescence: every owner must be idle, then quiesced through the
    // host hook (the harness quiesce removes processing runtimes).
    const activeOwner = facts.ownerSessionIds.find((owner) => this.hooks.isSessionActive?.(owner))
    if (activeOwner) {
      this.deps.journal.fail(txn.journalId, `Source owner ${activeOwner} has an active turn.`)
      this.transactions.delete(input.sessionId)
      return this.blockedResult(txn, 'source-active', `Source owner ${activeOwner} has an active turn; forking requires idle runtimes.`)
    }
    const quiesced = this.hooks.quiesceRuntimes ? await this.hooks.quiesceRuntimes(facts.ownerSessionIds) : true
    if (!quiesced) {
      this.deps.journal.fail(txn.journalId, 'A source runtime could not be quiesced.')
      this.transactions.delete(input.sessionId)
      return this.blockedResult(txn, 'source-active', 'A source runtime could not be quiesced; forking requires idle runtimes.')
    }
    this.journalStep(txn, 'source-quiesced')

    let transactionLeaseId: string | null = null
    try {
      // Target reservation, journaled BEFORE the seed capture: nameSuffix,
      // pathToken, expectedBranch, and the source HEAD OID the target must pin.
      txn.headOid = facts.source.headSha ?? ''
      if (!txn.headOid) throw new Error('The source HEAD could not be resolved for the fork target.')
      this.deps.journal.updateMetadata(txn.journalId, {
        state: 'target-reserved',
        nameSuffix: txn.nameSuffix ?? null,
        pathToken: txn.pathToken ?? null,
        expectedBranch: txn.expectedBranch,
        headOid: txn.headOid,
      })

      // Stable-lease guard: the source fingerprint must not change under our
      // own capture (the seed is read-only on the checkout).
      const settings = this.deps.settings.getSnapshot(this.deps.serverId)
      const sourceFingerprintBeforeCapture = await computeWorktreeFingerprint({
        managedWorktreeId: `fork:${facts.sourceCheckoutPath}`,
        checkoutPath: facts.sourceCheckoutPath,
        gitCommonDir: txn.gitCommonDir,
        expectedBranch: facts.source.branch ?? '',
        baseRef: null,
        ownerSessionIds: facts.ownerSessionIds,
        policyVersion: settings.version,
        archivedOwnerSessionIds: [],
      })

      // Seed capture (skipped on replay: the seed id is journaled). The seed
      // pins the SOURCE checkout, so it records the source branch — the target
      // branch is applied by the restore projection.
      if (!txn.steps.includes('seed-captured')) {
        const captured = await this.captureForkSeed({
          checkoutPath: facts.sourceCheckoutPath,
          repositoryRoot: txn.repositoryRoot,
          gitCommonDir: txn.gitCommonDir,
          expectedBranch: facts.source.branch ?? '',
          baseRef: txn.headOid,
          ownerSessionIds: facts.ownerSessionIds,
          policyVersion: settings.version,
          previewFingerprint: txn.fingerprint,
        })
        txn.seedSnapshotId = captured.snapshotId
        // The seed is journaled immediately after capture so an in-progress
        // fork entry's seed is GC-retained until the commit marker.
        this.deps.journal.updateMetadata(txn.journalId, {
          state: 'seed-captured',
          seedSnapshotId: captured.snapshotId,
          seedFingerprint: captured.fingerprint,
        })
        this.journalStep(txn, 'seed-captured')
        txn.state = 'seed-captured'
      } else if (!txn.seedSnapshotId) {
        throw new Error('The interrupted fork journal has no recorded seed.')
      }

      const afterCaptureFingerprint = await computeWorktreeFingerprint({
        managedWorktreeId: `fork:${facts.sourceCheckoutPath}`,
        checkoutPath: facts.sourceCheckoutPath,
        gitCommonDir: txn.gitCommonDir,
        expectedBranch: facts.source.branch ?? '',
        baseRef: null,
        ownerSessionIds: facts.ownerSessionIds,
        policyVersion: settings.version,
        archivedOwnerSessionIds: [],
      })
      if (afterCaptureFingerprint !== sourceFingerprintBeforeCapture) {
        throw new Error('The source checkout changed during seed capture.')
      }

      // Destination lease fences the target path against other runtimes.
      transactionLeaseId = `fork:${txn.transactionId}`
      this.deps.leases.lease(transactionLeaseId, txn.destinationPath)
      this.journalStep(txn, 'destination-leased')

      // Materialize the target (skipped on replay when the journal records it).
      if (!txn.steps.includes('target-materialized')) {
        const created = await this.deps.worktrees.createWorktree({
          workspaceId: session.workspaceId,
          sessionId: input.sessionId,
          repositoryRoot: txn.repositoryRoot,
          gitCommonDir: txn.gitCommonDir,
          baseRef: txn.headOid,
          worktreeNameSuffix: txn.nameSuffix,
          pathToken: txn.pathToken,
          lockAlreadyHeld: true,
        })
        if (created.record.schemaVersion !== 2) {
          throw new Error('Named fork creation did not produce a V2 worktree record.')
        }
        txn.managedWorktreeId = created.record.managedWorktreeId
        this.deps.journal.updateMetadata(txn.journalId, {
          state: 'target-materialized',
          managedWorktreeId: created.record.managedWorktreeId,
        })
        this.journalStep(txn, 'target-materialized')
        txn.state = 'target-materialized'
      }
      const targetRecord = txn.managedWorktreeId ? this.deps.registry.get(txn.managedWorktreeId) : undefined
      if (!targetRecord || targetRecord.schemaVersion !== 2 || targetRecord.state !== 'ready') {
        throw new Error('The materialized fork target record is missing or not ready.')
      }
      if (realpathSafe(targetRecord.checkoutPath) !== realpathSafe(txn.destinationPath)) {
        throw new Error('The materialized fork target is not at the reserved destination.')
      }

      const seedMeta = this.deps.snapshots.loadSnapshotMeta(txn.seedSnapshotId)
      if (!seedMeta) throw new Error('The fork seed is missing; it cannot restore the target.')

      // Restore the seed into the target (skipped on replay when recorded).
      if (!txn.steps.includes('target-restored')) {
        await this.deps.snapshots.applySnapshotToCheckout({
          meta: seedMeta,
          checkoutPath: targetRecord.checkoutPath,
        })
        this.journalStep(txn, 'target-restored')
      }

      // Verify: the restored target must reproduce the seed content exactly
      // (staged/unstaged/untracked/.worktreeinclude byte-for-byte) and sit at
      // the captured HEAD on the reserved branch.
      if (!txn.steps.includes('target-verified')) {
        const targetContext = await this.deps.repository.getContext(targetRecord.checkoutPath)
        if (
          !targetContext.isGitRepository ||
          !targetContext.gitCommonDir ||
          resolvePath(targetContext.gitCommonDir) !== resolvePath(txn.gitCommonDir) ||
          targetContext.currentBranch !== targetRecord.expectedBranch ||
          targetContext.headSha !== seedMeta.headOid
        ) {
          throw new Error('The fork target failed identity verification after restore.')
        }
        await this.assertTargetMatchesSeed(txn, seedMeta, targetRecord.checkoutPath)
        this.journalStep(txn, 'target-verified')
        txn.state = 'target-verified'
      }

      // Child session through the host hook (skipped on replay: the child id
      // is journaled). The child is invisible until the journal commit marker.
      if (!txn.steps.includes('child-created')) {
        const childSessionId = await this.hooks.createForkChildSession!({
          transactionId: txn.transactionId,
          parentSessionId: input.sessionId,
          parentSdkSessionId: session.sdkSessionId,
          parentSdkTurnId: session.forkPointTurnId ?? session.conversationHead.turnId,
          transcriptCwd: session.transcriptCwd,
          executionCwd: targetRecord.checkoutPath,
          checkout: this.childCheckoutFor(targetRecord),
          nameSuffix: txn.nameSuffix!,
          sourceMessageId: session.conversationHead.messageId,
          workspaceId: session.workspaceId,
          forkPointMessageId: session.forkPointMessageId ?? session.conversationHead.messageId,
        })
        if (!childSessionId || typeof childSessionId !== 'string' || !childSessionId.trim()) {
          throw new Error('The child-session hook did not return a durable child session id.')
        }
        txn.childSessionId = childSessionId
        this.deps.journal.updateMetadata(txn.journalId, { state: 'target-materialized', childSessionId })
        this.journalStep(txn, 'child-created')
      }
      if (!txn.childSessionId) {
        throw new Error('The interrupted fork journal has no recorded child session.')
      }
      txn.childCheckout = this.childCheckoutFor(targetRecord)

      // Registry: the child becomes the SOLE owner of the new record; the
      // source record is never touched.
      if (!txn.steps.includes('owner-committed')) {
        await this.deps.registry.runExclusive(async (tx) => {
          const record = tx.get(txn.managedWorktreeId!)
          if (!record || record.state !== 'ready') {
            throw new Error('The fork target record is missing or not ready before the owner commit.')
          }
          if (record.ownerSessionIds.length !== 1 || record.ownerSessionIds[0] !== input.sessionId) {
            throw new Error('The fork target gained unexpected owners before the commit.')
          }
          record.ownerSessionIds = [txn.childSessionId!]
          record.lastUsedAt = Date.now()
          tx.commit()
        })
        this.journalStep(txn, 'owner-committed')
      }

      // Durable commit marker, then the child is visible through the result.
      txn.state = 'binding-committed'
      txn.committedAt = Date.now()
      this.deps.journal.updateMetadata(txn.journalId, {
        state: 'binding-committed',
        childSessionId: txn.childSessionId,
        childCheckout: txn.childCheckout,
        executionCwd: targetRecord.checkoutPath,
        transcriptCwd: session.transcriptCwd,
        committedAt: txn.committedAt,
      })
      this.deps.journal.commit(txn.journalId, txn.transactionId)
      const committedAt = txn.committedAt
      const childCheckout = txn.childCheckout

      // Post-commit cleanup: remove the seed (best-effort; GC covers stragglers).
      if (txn.seedSnapshotId) {
        try {
          await this.removeSeed(txn.seedSnapshotId, txn.repositoryRoot)
        } catch {
          // The journal is committed; an unreferenced seed is GC-removed.
        }
      }
      if (transactionLeaseId) this.deps.leases.release(transactionLeaseId, txn.destinationPath)
      this.transactions.delete(input.sessionId)
      return {
        outcome: 'committed',
        transactionId: txn.transactionId,
        summary: {
          sessionId: txn.childSessionId!,
          strategy: 'isolated-worktree',
          checkout: childCheckout!,
          executionCwd: targetRecord.checkoutPath,
          transcriptCwd: session.transcriptCwd,
          childProviderIdPresent: false,
          committedAt,
        },
      }
    } catch (error) {
      if (transactionLeaseId) this.deps.leases.release(transactionLeaseId, txn.destinationPath)
      try {
        await this.compensate(txn)
        this.deps.journal.updateMetadata(txn.journalId, { state: 'rolled-back', rolledBackAt: Date.now() })
        this.deps.journal.recover(txn.journalId, 'rolled-back')
        this.transactions.delete(input.sessionId)
      } catch (compensationError) {
        this.deps.journal.updateMetadata(txn.journalId, { state: 'recovery-required', lastError: sanitizeError(error) })
        this.deps.journal.fail(txn.journalId, sanitizeError(error))
        throw new ConversationForkError(
          'FORK_COMPENSATION_FAILED',
          `The fork transaction could not be fully compensated: ${sanitizeError(compensationError)}.`,
        )
      }
      throw new ConversationForkError('FORK_TARGET_FAILED', sanitizeError(error))
    }
  }

  /** Build the V2 child checkout binding from the materialized target record. */
  private childCheckoutFor(record: ManagedWorktreeRecordV2): SessionCheckoutV2 {
    return {
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
  }

  /** Idempotent journal step: append to the in-memory steps only once. */
  private journalStep(txn: ForkTransaction, step: string): void {
    if (txn.steps.includes(step)) return
    txn.steps.push(step)
    this.deps.journal.step(txn.journalId, step)
  }

  private blockedResult(
    txn: ForkTransaction,
    code: ConversationForkBlockerCode,
    reason: string,
  ): ConversationForkResult {
    return { outcome: 'blocked', transactionId: txn.transactionId, code, reason: sanitizeError(reason) }
  }

  /** True when another in-memory/journal fork owns the source or target path. */
  private isForkInProgressFor(txn: ForkTransaction): boolean {
    const source = resolvePath(txn.sourcePath)
    const destination = resolvePath(txn.destinationPath)
    const journalCollision = this.deps.journal.inProgress().some((entry) => {
      if (entry.op !== 'fork' || entry.recordId === txn.transactionId) return false
      const entrySource = entry.metadata?.sourcePath
      const entryDestination = entry.metadata?.destinationPath
      return (
        entry.sessionIds.includes(txn.sessionId) ||
        (typeof entrySource === 'string' &&
          (resolvePath(entrySource) === source || resolvePath(entrySource) === destination)) ||
        (typeof entryDestination === 'string' &&
          (resolvePath(entryDestination) === source || resolvePath(entryDestination) === destination))
      )
    })
    if (journalCollision) return true
    for (const [owner, other] of this.transactions) {
      if (owner === txn.sessionId || other.transactionId === txn.transactionId) continue
      const otherSource = resolvePath(other.sourcePath)
      const otherDestination = resolvePath(other.destinationPath)
      if (
        otherSource === source ||
        otherDestination === source ||
        otherSource === destination ||
        otherDestination === destination
      ) {
        return true
      }
    }
    return false
  }

  /**
   * Compensate ONLY transaction-owned artifacts, each with CAS/containment
   * proof: the branch only while it still points at the journaled OID, the
   * target only beneath the server root with the exact created owner set, the
   * seed only when owned by this transaction, and the child session only when
   * this transaction created it. The source checkout is never touched.
   */
  private async compensate(txn: ForkTransaction): Promise<void> {
    // 1. Child session created by this transaction.
    if (txn.childSessionId && txn.steps.includes('child-created')) {
      const removeChild = this.hooks.deleteForkChildSession
      if (!removeChild) {
        throw new ConversationForkError('FORK_COMPENSATION_FAILED', 'No child-session removal hook is wired for compensation.')
      }
      await removeChild(txn.childSessionId)
    }
    // 2. Target worktree + registry record (only the record this transaction created).
    if (txn.steps.includes('target-materialized')) {
      const record = txn.managedWorktreeId ? this.deps.registry.get(txn.managedWorktreeId) : undefined
      if (record && record.schemaVersion === 2) {
        const ownersAreOurs =
          record.ownerSessionIds.length === 1 && record.ownerSessionIds[0] === txn.sessionId
        const branchIsOurs = record.expectedBranch === txn.expectedBranch
        const rootIsServer = this.deps.worktrees.isUnderWorktreeRoot(record.checkoutPath, record.materializationRoot)
        if (!ownersAreOurs || !branchIsOurs || !rootIsServer) {
          throw new ConversationForkError(
            'FORK_COMPENSATION_FAILED',
            'The interrupted fork target is not provably owned by this transaction.',
          )
        }
        const released = await removeCheckoutFiles(record.repositoryRoot, record.checkoutPath)
        if (!released) {
          throw new ConversationForkError('FORK_COMPENSATION_FAILED', 'The interrupted fork target checkout could not be removed.')
        }
        this.deps.registry.remove(record.managedWorktreeId)
      } else if (existsSync(txn.destinationPath) || lstatSyncSafe(txn.destinationPath) === 'symlink') {
        // Crash between the provisional record and the ready record: remove
        // the reserved path only when it is beneath the server root.
        if (!this.deps.worktrees.isUnderWorktreeRoot(txn.destinationPath)) {
          throw new ConversationForkError('FORK_COMPENSATION_FAILED', 'The interrupted fork target path escapes the server root.')
        }
        const released = await removeCheckoutFiles(txn.repositoryRoot, txn.destinationPath)
        if (!released) {
          throw new ConversationForkError('FORK_COMPENSATION_FAILED', 'The interrupted fork target path could not be removed.')
        }
      }
      // 3. Branch CAS: remove it only while it still points at the OID this
      // transaction created (the journaled head OID). A branch advanced or
      // replaced by external work is never ours to delete.
      if (txn.headOid) {
        const branchOid = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${txn.expectedBranch}`], {
          cwd: txn.repositoryRoot,
          okExitCodes: [1, 128],
        })
        if (branchOid.exitCode === 0 && branchOid.stdout.trim() === txn.headOid) {
          await runGit(['branch', '-D', txn.expectedBranch], { cwd: txn.repositoryRoot, okExitCodes: [1, 128] })
        }
      }
    }
    // 4. Seed owned by this transaction (CAS-deletes only the owned hidden ref).
    if (txn.seedSnapshotId) {
      await this.removeSeed(txn.seedSnapshotId, txn.repositoryRoot)
    }
  }

  /**
   * Content verification: the restored target must reproduce the seed's
   * captured staged/unstaged projections and every untracked/included file
   * byte-for-byte and mode-for-mode.
   */
  private async assertTargetMatchesSeed(
    txn: ForkTransaction,
    meta: ManagedWorktreeSnapshotMeta,
    checkoutPath: string,
  ): Promise<void> {
    const manifest = this.deps.snapshots.verifyPayload(meta)
    const maxBufferBytes = this.deps.snapshots.getMaxBytes() + 16 * 1024
    const staged = (
      await runGitBuffer(['diff', '--cached', '--binary', '--no-color', '--no-ext-diff'], {
        cwd: checkoutPath,
        maxBufferBytes,
      })
    ).stdout
    if (sha256(staged) !== manifest.stagedPatch.sha256) {
      throw new Error('The fork target staged state differs from the captured seed.')
    }
    const unstaged = (
      await runGitBuffer(['diff', '--binary', '--no-color', '--no-ext-diff'], {
        cwd: checkoutPath,
        maxBufferBytes,
      })
    ).stdout
    if (sha256(unstaged) !== manifest.unstagedPatch.sha256) {
      throw new Error('The fork target unstaged state differs from the captured seed.')
    }
    for (const entry of manifest.files) {
      const dest = join(checkoutPath, entry.path)
      const kind = lstatSyncSafe(dest)
      if (kind === null) {
        throw new Error(`The fork target is missing a captured file: ${entry.path}`)
      }
      if (entry.mode === '120000') {
        if (kind !== 'symlink' || readlinkSync(dest) !== entry.linkText) {
          throw new Error(`The fork target symlink differs from the captured seed: ${entry.path}`)
        }
        continue
      }
      if (kind !== 'other' || !statSync(dest).isFile()) {
        throw new Error(`The fork target path is not a regular file: ${entry.path}`)
      }
      const actual = statSync(dest)
      if (
        (actual.mode & 0o777) !== parseInt(entry.mode.slice(-3), 8) ||
        sha256(readFileSync(dest)) !== entry.sha256
      ) {
        throw new Error(`The fork target file differs from the captured seed: ${entry.path}`)
      }
    }
    void txn
  }

  /**
   * Resolve the transaction a confirm/recover refers to: the in-memory preview
   * transaction, a durable in-progress journal transaction (crash replay), a
   * rolled-back journal transaction (fresh re-run after full compensation), or
   * a committed journal transaction (repeat confirm/recover returns the
   * summary). Only `sessionId` + `transactionId` are consulted, so recover
   * resolves through the same path as confirm. In-memory and journal-only
   * resolution decide identically so confirm/recover behave the same before
   * and after a restart: a failed entry (blocked confirm or recovery-required
   * compensation failure) is never resumable.
   */
  private resolveConfirmTransaction(input: { sessionId: string; transactionId: string }): {
    txn: ForkTransaction
    committedSummary?: ConversationForkCommitSummary
  } | null {
    const existing = this.transactions.get(input.sessionId)
    if (existing) {
      if (existing.transactionId !== input.transactionId) return null
      const entry = this.deps.journal.entries().find((candidate) => candidate.journalId === existing.journalId)
      if (entry && entry.status === 'in-progress') {
        existing.steps = [...entry.steps]
        return { txn: existing }
      }
      if (entry) {
        // Mirror the journal-only resolution below: a committed entry returns
        // its summary, a fully compensated (rolled-back) entry starts a fresh
        // attempt, and every other durable terminal state — a failed entry
        // (blocked confirm or recovery-required compensation failure) — is not
        // resumable and yields the typed transaction-unknown error.
        if (entry.status === 'committed') {
          const summary = this.committedSummaryFromMetadata(entry, existing)
          if (summary) return { txn: existing, committedSummary: summary }
          return null
        }
        if (entry.status === 'recovered' && entry.commitMarker === 'rolled-back') {
          return this.beginFreshAttempt(existing)
        }
        return null
      }
      // No durable entry (compacted/lost journal): restart with a fresh journal
      // entry so this confirm/recover can still complete durably.
      return this.beginFreshAttempt(existing)
    }
    const entry = this.deps.journal.entries().find(
      (candidate) => candidate.op === 'fork' && candidate.recordId === input.transactionId && candidate.sessionIds.includes(input.sessionId),
    )
    if (!entry) return null
    const rehydrated = this.rehydrateTransaction(entry, input.sessionId)
    if (!rehydrated) return null
    if (entry.status === 'committed') {
      const summary = this.committedSummaryFromMetadata(entry, rehydrated)
      return { txn: rehydrated, committedSummary: summary }
    }
    if (entry.status === 'recovered') {
      if (entry.commitMarker !== 'rolled-back') return null
      // The previous attempt was fully compensated; start a fresh journal entry
      // for the re-run so the transaction commits exactly once.
      return this.beginFreshAttempt(rehydrated)
    }
    if (entry.status === 'in-progress') {
      this.transactions.set(rehydrated.sessionId, rehydrated)
      return { txn: rehydrated }
    }
    // Failed entries (blocked confirms) are not resumable.
    return null
  }

  /** Reset a transaction for a fresh confirm attempt with a new journal entry. */
  private beginFreshAttempt(txn: ForkTransaction): { txn: ForkTransaction } | null {
    txn.steps = []
    txn.state = 'pending'
    txn.headOid = undefined
    txn.seedSnapshotId = undefined
    txn.managedWorktreeId = undefined
    txn.childSessionId = undefined
    txn.childCheckout = undefined
    txn.committedAt = undefined
    const journal = this.deps.journal.begin({
      op: 'fork',
      recordId: txn.transactionId,
      sessionIds: [txn.sessionId],
      policyVersion: this.deps.settings.getSnapshot(this.deps.serverId).version,
      metadata: this.transactionMetadata(txn),
    })
    txn.journalId = journal.journalId
    this.transactions.set(txn.sessionId, txn)
    return { txn }
  }

  /** Rebuild a transaction from a journal entry's recorded metadata + steps. */
  private rehydrateTransaction(entry: WorktreeJournalEntry, sessionId: string): ForkTransaction | null {
    const metadata = entry.metadata
    if (!metadata) return null
    const stringValue = (key: string): string | undefined =>
      typeof metadata[key] === 'string' ? (metadata[key] as string) : undefined
    const transactionId = stringValue('transactionId')
    const strategy = stringValue('strategy')
    const fingerprint = stringValue('fingerprint')
    const sourcePath = stringValue('sourcePath')
    const destinationPath = stringValue('destinationPath')
    const repositoryRoot = stringValue('repositoryRoot')
    const gitCommonDir = stringValue('gitCommonDir')
    const expectedBranch = stringValue('expectedBranch')
    const nameSuffix = stringValue('nameSuffix')
    const pathToken = stringValue('pathToken')
    const transcriptCwd = stringValue('transcriptCwd')
    if (
      entry.recordId !== transactionId ||
      strategy !== 'isolated-worktree' ||
      !transactionId ||
      !/^[a-f0-9]{16}$/.test(transactionId) ||
      !sessionId ||
      !fingerprint ||
      !/^[a-f0-9]{64}$/.test(fingerprint) ||
      !sourcePath ||
      !destinationPath ||
      !repositoryRoot ||
      !gitCommonDir ||
      !expectedBranch ||
      !transcriptCwd ||
      !nameSuffix ||
      nameSuffix.includes('\0') ||
      !pathToken ||
      !/^[a-f0-9]{8}$/.test(pathToken)
    ) {
      return null
    }
    const absolutePaths = [sourcePath, destinationPath, repositoryRoot, gitCommonDir, transcriptCwd]
    if (absolutePaths.some((path) => !isAbsolute(path) || path.includes('\0'))) return null
    const root = resolvePath(this.deps.settings.getSnapshot(this.deps.serverId).materializationRoot)
    if (!isContainedPath(root, destinationPath)) return null
    const sourceLeases = metadata.sourceLeases
    if (!Array.isArray(sourceLeases) || !sourceLeases.every((value) => typeof value === 'string')) return null
    const providerAdapterId = stringValue('providerAdapterId')
    const capability: ConversationForkProviderCapability | undefined = providerAdapterId
      ? { adapterId: providerAdapterId, strictCrossCwdNativeFork: true }
      : undefined
    return {
      transactionId,
      sessionId,
      strategy: 'isolated-worktree',
      state: (stringValue('state') as ConversationForkRecoveryState) ?? 'pending',
      fingerprint,
      nameSuffix,
      pathToken,
      sourcePath,
      destinationPath,
      repositoryRoot,
      gitCommonDir,
      expectedBranch,
      steps: [...entry.steps],
      journalId: entry.journalId,
      providerCapability: capability,
      transcriptCwd,
      sourceLeases: sourceLeases as string[],
      startedAt: typeof metadata.startedAt === 'number' ? metadata.startedAt : entry.startedAt,
      headOid: stringValue('headOid'),
      seedSnapshotId: stringValue('seedSnapshotId'),
      managedWorktreeId: stringValue('managedWorktreeId'),
      childSessionId: stringValue('childSessionId'),
      committedAt: typeof metadata.committedAt === 'number' ? metadata.committedAt : undefined,
    }
  }

  /** Rebuild the committed summary from a committed journal entry. */
  private committedSummaryFromMetadata(entry: WorktreeJournalEntry, txn: ForkTransaction): ConversationForkCommitSummary | undefined {
    const metadata = entry.metadata
    if (!metadata) return undefined
    const childSessionId = txn.childSessionId
    const checkout = metadata.childCheckout
    const executionCwd = metadata.executionCwd
    const transcriptCwd = typeof metadata.transcriptCwd === 'string' ? metadata.transcriptCwd : txn.transcriptCwd
    const committedAt = txn.committedAt
    if (
      !childSessionId ||
      !checkout ||
      typeof checkout !== 'object' ||
      typeof (checkout as { schemaVersion?: unknown }).schemaVersion !== 'number' ||
      typeof executionCwd !== 'string' ||
      !transcriptCwd ||
      !committedAt
    ) {
      return undefined
    }
    return {
      sessionId: childSessionId,
      strategy: 'isolated-worktree',
      checkout: checkout as SessionCheckoutV2,
      executionCwd,
      transcriptCwd,
      childProviderIdPresent: false,
      committedAt,
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
      fingerprint: txn.fingerprint,
      nameSuffix: txn.nameSuffix ?? null,
      pathToken: txn.pathToken ?? null,
      sourcePath: txn.sourcePath,
      destinationPath: txn.destinationPath,
      repositoryRoot: txn.repositoryRoot,
      gitCommonDir: txn.gitCommonDir,
      expectedBranch: txn.expectedBranch,
      providerAdapterId: txn.providerCapability?.adapterId ?? null,
      sourceLeases: txn.sourceLeases,
      transcriptCwd: txn.transcriptCwd ?? null,
      startedAt: txn.startedAt,
    }
  }

  private async computeFingerprint(
    input: ConversationForkPreviewInput,
    session: ForkSessionInfo,
    facts: ForkFacts,
    capability: ConversationForkProviderCapability | null,
    transactionId: string,
    excludeLeaseId?: string,
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
          .filter(([owner]) => owner !== excludeLeaseId)
          .sort(([a], [b]) => String(a).localeCompare(String(b))),
      }),
    )
    return hash.digest('hex')
  }
}
