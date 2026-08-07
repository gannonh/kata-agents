/**
 * Worktree V2 Phase 4: isolated conversation forks protocol DTOs.
 *
 * Conversation branching keeps the existing **Shared worktree** behavior
 * (a child session shares the parent's managed worktree, preserving #33) and
 * adds an explicit **New isolated worktree** alternative. Isolated forks
 * create a separately named managed worktree, Git branch, Kata session, and
 * execution runtime at the source conversation's current head while leaving
 * the source conversation and checkout unchanged.
 *
 * Isolated is offered only when Worktree V2 is effective, the source session
 * is idle at its current conversation head, Git state is supported, and the
 * provider adapter advertises strict safe cross-CWD native fork. The target
 * branch/worktree/session is prepared and durably committed BEFORE the child
 * is visible; the child stores a *pending* provider-fork intent and does not
 * claim a child provider ID until the provider creates one on the first Send.
 *
 * Clients submit a server-issued opaque `transactionId` plus the exact
 * `previewFingerprint` they were shown — never paths. The server owns every
 * mutation. Unsupported providers receive a typed blocker with no fallback;
 * the existing missing-anchor/full-history fallback is bypassed for the
 * isolated strategy.
 */

import type { SessionCheckout } from './git'

// Typed wire errors for fork RPCs (canonical definitions in ./types).
export {
  WORKTREE_FORK_ERROR_CODE,
  WORKTREE_FORK_BLOCKED_CODE,
  WORKTREE_FORK_PREVIEW_STALE_CODE,
  WORKTREE_FORK_PENDING_CODE,
} from './types'

// ---------------------------------------------------------------------------
// Strategy and provider capability
// ---------------------------------------------------------------------------

/**
 * The two conversation-fork strategies. `shared-worktree` remains the default
 * (the pre-existing branch behavior sharing the source managed worktree);
 * `isolated-worktree` is the new explicit alternative added by Worktree V2
 * Phase 4. The order pins `shared-worktree` as the default choice.
 */
export const CONVERSATION_FORK_STRATEGIES = ['shared-worktree', 'isolated-worktree'] as const

/** A supported conversation-fork strategy. */
export type ConversationForkStrategy = (typeof CONVERSATION_FORK_STRATEGIES)[number]

/**
 * Sanitized provider capability DTO. Never carries secrets, paths beyond the
 * server-owned ones in the preview, or transcript/session identity details.
 */
export interface ConversationForkProviderCapability {
  /** Stable adapter identity, e.g. `pi`. */
  adapterId: string
  /**
   * True only when the adapter can establish a provider-native fork at the
   * recorded source conversation head while guaranteeing every file, shell,
   * MCP, and provider tool executes in the destination execution CWD and the
   * immutable transcript lookup identity (transcript CWD) is preserved. An
   * adapter that cannot separate transcript storage from execution (e.g.
   * Claude's current use of `sdkCwd` for both) or cannot prove destination
   * tool CWD must advertise `false` and remain typed-blocked.
   */
  strictCrossCwdNativeFork: boolean
}

// ---------------------------------------------------------------------------
// Blockers
// ---------------------------------------------------------------------------

/**
 * Typed conversation-fork blockers: every entry corresponds to a precondition
 * the server checks before any mutation, and a blocked fork claims no
 * mutation. Post-recovery outcomes are NOT blockers and stay out of this
 * tuple — they report the completed result of explicit recovery. Each tuple
 * is the single source of truth: its union is derived from it so a code can
 * never be added to the type without being listed here.
 */
export const CONVERSATION_FORK_BLOCKER_CODES = [
  /** Provider adapter cannot establish a strict cross-CWD native fork. */
  'unsupported-provider',
  /** Forking from an older conversation point; isolated requires current head. */
  'non-head-source',
  /** Source has an active turn or an unquiesceable runtime. */
  'source-active',
  /** A source path owner/lease cannot be established (stable lease + fingerprint). */
  'path-unleased',
  /** The requested `kata-agent/<name>` branch or display name already exists. */
  'name-collision',
  /** Conversation head or Git fingerprint changed between preview and confirm. */
  'identity-drift',
  /** Source session or checkout is missing/snapshotted; restore is required. */
  'missing-source',
  /** The snapshot service cannot capture the supported source state. */
  'unsupported-snapshot',
  /** Captured seed exceeds Phase 2 snapshot limits (10,000 files / 100 MiB). */
  'oversized-capture',
  /** A Git operation is in progress or the index is unmerged. */
  'git-operation-in-progress',
  /** Lifecycle cleanup is in progress for either path. */
  'cleanup-in-progress',
  /** Required feature flags are disabled (Worktree V2 not effective). */
  'flags-disabled',
  /** The requested generated/display name is not a valid branch suffix. */
  'invalid-name',
  /** A pending/recovery fork transaction exists for the source or target. */
  'fork-in-progress',
] as const

/** A typed conversation-fork blocker code (precondition checks only). */
export type ConversationForkBlockerCode = (typeof CONVERSATION_FORK_BLOCKER_CODES)[number]

/** Typed blocker payload carried by previews and confirm results. */
export interface ConversationForkBlocked {
  blocked: true
  code: ConversationForkBlockerCode
  /** Sanitized, non-localized server detail retained for diagnostics. */
  reason: string
}

// ---------------------------------------------------------------------------
// Pending provider-fork intent
// ---------------------------------------------------------------------------

/**
 * Durable pending provider-fork intent stored by an isolated child before its
 * first Send. Carries strict parent conversation/turn identity, the immutable
 * transcript lookup identity, the destination execution CWD, and an
 * idempotency key — and STRUCTURALLY CANNOT carry a child provider ID: the
 * provider has not created one yet. The child provider ID is persisted only
 * after the strict adapter establishes the native fork on first Send.
 */
export interface ConversationForkPendingIntent {
  /** Source Kata session the fork is created from. */
  parentSessionId: string
  /** Parent provider SDK session identity (anchor lineage). */
  parentSdkSessionId: string
  /** Parent provider turn anchor at the branch point. */
  parentSdkTurnId: string
  /** Source Kata message ID at the branch point (current conversation head). */
  parentMessageId: string
  /** Immutable transcript lookup identity — never rewritten by the fork. */
  transcriptCwd: string
  /** Destination execution CWD every tool must resolve to. */
  executionCwd: string
  /** Idempotency key for the first-Send provider establishment. */
  idempotencyKey: string
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/**
 * Renderer-safe fork preview. The server binds every decision-relevant fact
 * (source conversation head, Git state, owners/leases, destination identity,
 * provider capability, ignored-file policy) into `previewFingerprint`;
 * confirmation revalidates it under lock. Snapshot payload bytes, manifest
 * hashes, and file contents never cross into clients.
 */
export interface ConversationForkPreview {
  /** Opaque server-issued transaction identity for the confirmation. */
  transactionId: string
  /** Exact server-issued fingerprint the confirmation is checked against. */
  previewFingerprint: string
  strategy: ConversationForkStrategy
  providerCapability: ConversationForkProviderCapability
  source: {
    /** Server identity that owns the source checkout. */
    serverId: string
    /** Source Kata session ID. */
    sessionId: string
    /** Source conversation head message ID (current head enforcement). */
    conversationHeadMessageId: string
    /** Source conversation head provider turn ID. */
    conversationHeadTurnId: string
    /** Source session checkout metadata (current or managed). */
    checkout: Pick<SessionCheckout, 'mode'> & { managedWorktreeId?: string | null }
    /** Branch name, or null when detached. */
    branch: string | null
    /** HEAD SHA at preview time. */
    headSha: string | null
    /** Git-state summary at preview time. */
    gitState: {
      /** `clean`, `dirty`, or `detached` at preview time. */
      state: 'clean' | 'dirty' | 'detached'
      stagedFileCount: number
      unstagedFileCount: number
      untrackedFileCount: number
      includedIgnoredFileCount: number
    }
    /** Every path owner / turn blocker the source lease must cover. */
    leases: string[]
  }
  destination: {
    serverId: string
    repositoryRoot: string
    /** `kata-agent/<name>` branch for the isolated target. */
    branch: string
    checkoutPath: string
    /** Whether the destination checkout is currently materialized. */
    exists: boolean
    /** Live foreign lease owners on the destination path. */
    leases: string[]
  }
  /** Ignored-file policy: only `.worktreeinclude`-listed files copy. */
  excludedIgnoredPolicy: {
    includeOnly: true
    includeFileCount: number
  }
  /**
   * Eligibility flag: true only when the source conversation is at its
   * current head. Older conversation points cannot select isolated.
   */
  currentHead: boolean
  /** Present when the preview is blocked; confirmation must not proceed. */
  blocked?: ConversationForkBlocked
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

/** Server-resolved preview request; clients nominate a name, never a path. */
export interface ConversationForkPreviewInput {
  sessionId: string
  strategy: ConversationForkStrategy
  /** Editable suffix for a new managed worktree (isolated only). */
  worktreeNameSuffix?: string
}

/** Confirmation by transaction ID + preview fingerprint only — never paths. */
export interface ConversationForkConfirmInput {
  sessionId: string
  strategy: ConversationForkStrategy
  /** Opaque transaction ID issued by the preview. */
  transactionId: string
  /** Exact preview fingerprint the user was shown. */
  previewFingerprint: string
  /** Editable suffix for a new managed worktree (isolated only). */
  worktreeNameSuffix: string
}

// ---------------------------------------------------------------------------
// Result and recovery
// ---------------------------------------------------------------------------

/**
 * Isolated-fork transaction state. Pending states fence Send, agent creation,
 * Git mutations, session deletion, auto-cleanup, and another fork for both
 * paths; `recovery-required` states expose the retained snapshot authority.
 * `binding-committed` is the durable commit point BEFORE child visibility;
 * `published` makes the child visible with pending provider identity;
 * `establishing`/`established` cover the first-Send native-fork lifecycle.
 */
export type ConversationForkRecoveryState =
  | 'pending'
  | 'source-leased'
  | 'seed-captured'
  | 'target-reserved'
  | 'target-materialized'
  | 'target-verified'
  | 'binding-committed'
  | 'published'
  | 'establishing'
  | 'established'
  | 'restore-failed'
  | 'cleanup-failed'
  | 'recovery-required'

/** Durable binding summary recorded at the fork commit point. */
export interface ConversationForkCommitSummary {
  sessionId: string
  strategy: ConversationForkStrategy
  /** New durable session checkout binding (always a managed worktree). */
  checkout: SessionCheckout
  /** Execution CWD the runtime must resolve before Send unlocks. */
  executionCwd: string
  /** Immutable transcript CWD — unchanged by the fork. */
  transcriptCwd: string
  /**
   * Always `false` at the commit point: the child provider ID is pending
   * until the first-Send native fork succeeds. Kept as an explicit field so
   * a commit can never be mistaken for an established provider identity.
   */
  childProviderIdPresent: false
  committedAt: number
}

export type ConversationForkResult =
  | {
      outcome: 'committed'
      transactionId: string
      summary: ConversationForkCommitSummary
    }
  | {
      outcome: 'blocked'
      transactionId: string
      code: ConversationForkBlockerCode
      reason: string
    }
  | {
      outcome: 'recovery-required'
      transactionId: string
      recovery: ConversationForkRecoveryState
      /** Retained snapshot that backs rollback/recovery. */
      retainedSnapshotId?: string
      reason: string
    }

// ---------------------------------------------------------------------------
// Status and recovery
// ---------------------------------------------------------------------------

/** Status query for one session's fork transaction. */
export interface ConversationForkStatusInput {
  sessionId: string
}

export type ConversationForkStatus =
  | { active: false }
  | {
      active: true
      transactionId: string
      strategy: ConversationForkStrategy
      state: ConversationForkRecoveryState
      /** Retained snapshot authority when the fork is snapshot-backed. */
      retainedSnapshotId?: string
      /** Server timestamp of the last state transition. */
      since: number
      /**
       * Child provider identity display state. Before first Send this must
       * display as PENDING rather than claiming a child provider ID — so the
       * status surface intentionally carries no `childProviderId` field.
       */
      pendingProviderIdentity: true
    }

/** Continue an interrupted fork transaction (idempotent steps). */
export interface ConversationForkRecoverInput {
  sessionId: string
  transactionId: string
}

export type ConversationForkRecoverResult = ConversationForkResult

/** Cancel a pending preview transaction (dialog dismissed without confirming). */
export interface ConversationForkCancelInput {
  sessionId: string
  transactionId: string
}

export type ConversationForkCancelResult = ConversationForkStatus
