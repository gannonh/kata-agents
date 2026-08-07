/**
 * Worktree V2 Phase 3: conflict-safe checkout handoff DTOs.
 *
 * Handoff moves a single-owner idle session and its exact supported Git work
 * state between a managed worktree and the repository's registered current
 * checkout without overwriting destination work or breaking provider
 * conversation continuity.
 *
 * Clients submit a server-issued opaque `transactionId` plus the exact
 * `previewFingerprint` they were shown — never paths or patches. The server
 * owns every mutation and revalidates the fingerprint under lock before acting
 * (spec: state bound into the preview fingerprint, revalidated under lock).
 *
 * Handoff is exposed only when the session's provider adapter advertises and
 * can prove safe execution-CWD rebinding while preserving its immutable
 * transcript/session identity (`transcriptCwd`). Unsupported adapters yield a
 * typed `unsupported-provider` blocker and preserve V1 behavior.
 */

import type { SessionCheckout } from './git'

// Typed wire errors for handoff RPCs (canonical definitions in ./types).
export {
  WORKTREE_HANDOFF_ERROR_CODE,
  WORKTREE_HANDOFF_BLOCKED_CODE,
  WORKTREE_HANDOFF_PREVIEW_STALE_CODE,
  WORKTREE_HANDOFF_PENDING_CODE,
} from './types'

// ---------------------------------------------------------------------------
// Direction and provider capability
// ---------------------------------------------------------------------------

/** The three supported single-owner, same-repository handoff directions. */
export const WORKTREE_HANDOFF_DIRECTIONS = [
  'current-to-managed',
  'managed-to-current',
  'hand-back',
] as const

/** A supported single-owner, same-repository handoff direction. */
export type WorktreeHandoffDirection = (typeof WORKTREE_HANDOFF_DIRECTIONS)[number]

/**
 * Sanitized provider capability DTO. Never carries secrets, paths beyond the
 * server-owned ones in the preview, or transcript/session identity details.
 */
export interface WorktreeHandoffProviderCapability {
  /** Stable adapter identity, e.g. `pi`. */
  adapterId: string
  /**
   * True only when the adapter can recreate or rebind execution so every
   * file, shell, MCP, and provider tool resolves the destination checkout
   * while the immutable transcript CWD / provider identity is preserved.
   * An adapter that cannot separate transcript storage from execution (e.g.
   * Claude's current use of `sdkCwd` for both) must advertise `false` and
   * remain typed-blocked.
   */
  executionCwdRebindable: boolean
}

// ---------------------------------------------------------------------------
// Blockers
// ---------------------------------------------------------------------------

/**
 * Typed handoff blockers. Most correspond to a precondition the server checks
 * before any mutation; a blocked handoff claims no mutation. The tuple also
 * carries post-recovery outcomes (`handoff-rolled-back` reports a completed
 * rollback after a mutation attempt). The tuple is the single source of
 * truth: the union is derived from it so a code can never be added to the
 * type without being listed here.
 */
export const WORKTREE_HANDOFF_BLOCKER_CODES = [
  /** Provider adapter cannot safely rebind execution CWD (V1 preserved). */
  'unsupported-provider',
  /** Snapshot service cannot capture the current state. */
  'unsupported-snapshot',
  /** Destination checkout has tracked/index/eligible-untracked state. */
  'destination-dirty',
  /** Destination checkout path is not materialized. */
  'destination-missing',
  /** Destination checkout is on a detached HEAD. */
  'destination-detached',
  /** The branch is checked out by another worktree not recorded in the journal. */
  'branch-occupied-outside-journal',
  /** A foreign session/runtime leases either canonical path. */
  'another-path-user',
  /** Handoff requires exactly one owner; the checkout is shared. */
  'shared-owners',
  /** An active turn or unquiesceable runtime occupies the source. */
  'runtime-active',
  /** Lifecycle cleanup is in progress for either path. */
  'cleanup-in-progress',
  /** A Git operation is in progress or the index is unmerged. */
  'git-operation-in-progress',
  /** Captured state exceeds snapshot limits. */
  'oversized-capture',
  /** Live identity/fingerprints drifted from the preview. */
  'identity-drift',
  /** Required feature flags are disabled. */
  'flags-disabled',
  /** A pending/recovery handoff exists for either path. */
  'handoff-in-progress',
  /** The requested generated/display name is not a valid branch suffix. */
  'invalid-name',
  /** Recovery completed a snapshot-backed rollback of an interrupted handoff. */
  'handoff-rolled-back',
] as const

/** A typed handoff blocker code. */
export type WorktreeHandoffBlockerCode = (typeof WORKTREE_HANDOFF_BLOCKER_CODES)[number]

/** Typed blocker payload carried by previews and confirm results. */
export interface WorktreeHandoffBlocked {
  blocked: true
  code: WorktreeHandoffBlockerCode
  /** Sanitized, non-localized server detail retained for diagnostics. */
  reason: string
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/** Exact source cleanup the server will perform on confirmation. */
export interface WorktreeHandoffCleanupSummary {
  /** Files whose tracked contents (index/worktree) transfer out of source. */
  trackedFileCount: number
  /** Staged index entries that transfer out of source. */
  stagedFileCount: number
  /** Eligible untracked files that transfer out of source. */
  eligibleUntrackedFileCount: number
  /** `.worktreeinclude`-matched ignored files that copy (source keeps them). */
  includedIgnoredFileCount: number
}

/** A `.worktreeinclude` match that already exists in the destination. */
export interface WorktreeHandoffIncludeConflict {
  path: string
}

/** Recovery authority advertised before confirmation, per direction. */
export type WorktreeHandoffRecoveryBehavior =
  /** Verified destination precedes source cleanup; rollback is trivial. */
  | 'destination-authoritative'
  /** Retained snapshot is the rollback authority after source release. */
  | 'source-authoritative'
  /** Failure may leave explicit recovery-required state with the snapshot. */
  | 'recovery-required'

/** Return-ref metadata retained for a managed branch (managed-to-current). */
export interface WorktreeHandoffReturnRef {
  branch: string
  headSha: string
}

/**
 * Renderer-safe handoff preview. The server binds every decision-relevant
 * fact (source/destination identity, leases, include conflicts, cleanup) into
 * `previewFingerprint`; confirmation revalidates it under lock. Snapshot
 * payload bytes, manifest hashes, and file contents never cross into clients.
 */
export interface WorktreeHandoffPreview {
  /** Opaque server-issued transaction identity for the confirmation. */
  transactionId: string
  /** Exact server-issued fingerprint the confirmation is checked against. */
  previewFingerprint: string
  direction: WorktreeHandoffDirection
  providerCapability: WorktreeHandoffProviderCapability
  source: {
    /** Server identity that owns the source checkout. */
    serverId: string
    /** Branch name, or null when detached. */
    branch: string | null
    /** HEAD SHA at preview time. */
    headSha: string | null
    /** `clean`, `dirty`, or `detached` at preview time. */
    state: 'clean' | 'dirty' | 'detached'
    checkoutPath: string
    leases: string[]
  }
  destination: {
    serverId: string
    repositoryRoot: string
    branch: string
    checkoutPath: string
    /** Whether the destination checkout is currently materialized. */
    exists: boolean
    /** Live foreign lease owners on the destination path. */
    leases: string[]
  }
  /** `.worktreeinclude` copies that already exist in the destination and differ. */
  includeCopyConflicts: WorktreeHandoffIncludeConflict[]
  /** Ignored-file policy: only include-listed files transfer, by copy. */
  excludedIgnoredPolicy: {
    includeOnly: true
    includeFileCount: number
  }
  /** Exact source cleanup the server will perform on confirmation. */
  cleanup: WorktreeHandoffCleanupSummary
  /** Return-ref metadata retained for hand-back (managed-to-current only). */
  returnRef?: WorktreeHandoffReturnRef
  /** Recovery authority this direction relies on. */
  recoveryBehavior: WorktreeHandoffRecoveryBehavior
  /** Present when the preview is blocked; confirmation must not proceed. */
  blocked?: WorktreeHandoffBlocked
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

/** Server-resolved preview request; clients nominate a name, never a path. */
export interface WorktreeHandoffPreviewInput {
  sessionId: string
  direction: WorktreeHandoffDirection
  /** Editable suffix for a new managed worktree. */
  worktreeNameSuffix?: string
}

/** Confirmation by transaction ID + preview fingerprint only — never paths. */
export interface WorktreeHandoffConfirmInput {
  sessionId: string
  direction: WorktreeHandoffDirection
  /** Opaque transaction ID issued by the preview. */
  transactionId: string
  /** Exact preview fingerprint the user was shown. */
  previewFingerprint: string
}

// ---------------------------------------------------------------------------
// Result and recovery
// ---------------------------------------------------------------------------

/**
 * Handoff transaction state. Pending states fence Send, agent creation, Git
 * mutations, session deletion, auto-cleanup, and another handoff for both
 * paths; `recovery-required` states expose the retained snapshot authority.
 */
export type WorktreeHandoffRecoveryState =
  | 'pending'
  | 'quiesced'
  | 'snapshotted'
  | 'source-released'
  | 'target-created'
  | 'branch-switched'
  | 'binding-committed'
  | 'runtime-rebuilding'
  | 'restore-failed'
  | 'cleanup-failed'
  | 'recovery-required'

/** Durable binding summary recorded at the handoff commit point. */
export interface WorktreeHandoffCommitSummary {
  sessionId: string
  direction: WorktreeHandoffDirection
  /** New durable session checkout binding. */
  checkout: SessionCheckout
  /** Execution CWD the runtime must resolve before Send unlocks. */
  executionCwd: string
  /** Immutable transcript CWD — unchanged by handoff. */
  transcriptCwd: string
  /** Retained snapshot authority when this handoff is snapshot-backed. */
  retainedSnapshotId?: string
  committedAt: number
}

export type WorktreeHandoffResult =
  | {
      outcome: 'committed'
      transactionId: string
      summary: WorktreeHandoffCommitSummary
    }
  | {
      outcome: 'blocked'
      transactionId: string
      code: WorktreeHandoffBlockerCode
      reason: string
    }
  | {
      outcome: 'recovery-required'
      transactionId: string
      recovery: WorktreeHandoffRecoveryState
      /** Retained snapshot that backs rollback/recovery. */
      retainedSnapshotId?: string
      reason: string
    }

// ---------------------------------------------------------------------------
// Status and recovery
// ---------------------------------------------------------------------------

/** Status query for one session's handoff transaction. */
export interface WorktreeHandoffStatusInput {
  sessionId: string
}

export type WorktreeHandoffStatus =
  | { active: false }
  | {
      active: true
      transactionId: string
      direction: WorktreeHandoffDirection
      state: WorktreeHandoffRecoveryState
      retainedSnapshotId?: string
      /** Server timestamp of the last state transition. */
      since: number
    }

/** Continue an interrupted handoff transaction (idempotent steps). */
export interface WorktreeHandoffRecoverInput {
  sessionId: string
  transactionId: string
}

export type WorktreeHandoffRecoverResult = WorktreeHandoffResult

/** Cancel a pending preview transaction (dialog dismissed without confirming). */
export interface WorktreeHandoffCancelInput {
  sessionId: string
  transactionId: string
}

export type WorktreeHandoffCancelResult = WorktreeHandoffStatus
