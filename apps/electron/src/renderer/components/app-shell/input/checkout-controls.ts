/**
 * Pure helpers for the composer Workspace checkout controls.
 *
 * Kept free of React so the prepare-before-send gate (AC4), resume/restart
 * identity (AC5), and Shared worktree label (AC8) can be exercised in isolation
 * and shared by both the compact and desktop badge surfaces.
 */

import type {
  CheckoutMode,
  CheckoutPrepareIntent,
  SessionCheckoutV1,
} from '@kata-sh/shared/protocol'

// ---------------------------------------------------------------------------
// Prepare-before-send gate (AC4)
// ---------------------------------------------------------------------------

export interface SendGateState {
  /** Currently selected Workspace mode in the composer. */
  mode: CheckoutMode
  /** Selected base ref for a New worktree, when chosen. */
  baseRef: string | null
  /** Active working directory used to resolve repository identity. */
  workingDirectory: string | null
  /** True once a managed worktree has been prepared in this composer mount. */
  prepared: boolean
  /** True when the session already carries a persisted checkout (resumed/locked). */
  hasPersistedCheckout: boolean
  /** Whether the active directory is inside a Git repository. */
  isGitRepository: boolean
  /** False while Git context is still being rediscovered for this session/panel. */
  gitContextResolved?: boolean
}

export type SendGateDecision =
  | { action: 'send' }
  | { action: 'prepare'; intent: CheckoutPrepareIntent }
  | { action: 'wait' }
  | { action: 'block'; reason: 'missing-base-ref' }

/**
 * Decide what must happen when the user hits Send.
 *
 * A pending New worktree intent must be prepared on the workspace-owning server
 * BEFORE the message is accepted — otherwise the message would silently land in
 * the Current checkout. While Git context is unresolved, a pending worktree
 * intent waits rather than being treated as a confirmed non-Git directory.
 * Current checkout, already-prepared worktrees, resumed sessions, and confirmed
 * non-Git directories send directly.
 */
export function resolveSendGate(state: SendGateState): SendGateDecision {
  if (
    state.mode === 'managed-worktree' &&
    !!state.workingDirectory &&
    state.gitContextResolved === false &&
    !state.prepared &&
    !state.hasPersistedCheckout
  ) {
    return { action: 'wait' }
  }

  if (
    !state.isGitRepository ||
    state.prepared ||
    state.hasPersistedCheckout ||
    state.mode === 'current' ||
    !state.workingDirectory
  ) {
    return { action: 'send' }
  }
  // mode === 'managed-worktree' and nothing prepared yet.
  if (!state.baseRef) {
    return { action: 'block', reason: 'missing-base-ref' }
  }
  return {
    action: 'prepare',
    intent: {
      mode: 'managed-worktree',
      workingDirectory: state.workingDirectory,
      baseRef: state.baseRef,
    },
  }
}

// ---------------------------------------------------------------------------
// Checkout identity (AC5 resume/restart + AC8 shared label)
// ---------------------------------------------------------------------------

export type CheckoutIdentityKind =
  | 'none' // not a Git repository — render nothing
  | 'menu' // interactive Workspace/ref menu (empty, unprepared, no checkout)
  | 'current' // locked Current checkout identity
  | 'worktree' // locked managed worktree identity
  | 'shared-worktree' // locked managed worktree shared by >1 owner

export interface CheckoutIdentityState {
  isGitRepository: boolean
  isEmptySession: boolean
  hasSessionId: boolean
  /** Persisted checkout from the session DTO (present after preparation/resume). */
  persistedCheckout: SessionCheckoutV1 | null
  /** Checkout produced by a just-completed local preparation, before the DTO round-trips. */
  locallyPrepared: SessionCheckoutV1 | null
  /** Shared-owner count derived on the server; > 1 means a shared worktree. */
  sharedOwnerCount: number | undefined
}

export interface CheckoutIdentity {
  kind: CheckoutIdentityKind
  /** Branch/identity label to display, when applicable. */
  branch?: string | null
}

/**
 * Resolve which checkout identity the composer badge should present.
 *
 * Preference order:
 * 1. Non-Git directory → nothing.
 * 2. A prepared checkout (local result or persisted DTO) locks the identity —
 *    resume/restart must NOT reset a managed worktree back to Current.
 * 3. Managed worktree with owner count > 1 → Shared worktree (AC8).
 * 4. An empty Git session with no checkout → interactive menu.
 * 5. Otherwise (session already has messages, no checkout) → live Current checkout.
 */
export function resolveCheckoutIdentity(state: CheckoutIdentityState): CheckoutIdentity {
  // A prepared checkout (local result or persisted DTO) locks the identity and
  // is authoritative even before repository context finishes loading on resume —
  // restart/resume must NOT reset a managed worktree back to Current.
  const checkout = state.locallyPrepared ?? state.persistedCheckout
  if (checkout) {
    if (checkout.mode === 'managed-worktree') {
      const branch = checkout.expectedBranch ?? checkout.branchAtPreparation ?? null
      const shared = (state.sharedOwnerCount ?? 0) > 1
      return { kind: shared ? 'shared-worktree' : 'worktree', branch }
    }
    return { kind: 'current', branch: checkout.branchAtPreparation ?? null }
  }

  if (!state.isGitRepository) return { kind: 'none' }
  if (state.isEmptySession && state.hasSessionId) {
    return { kind: 'menu' }
  }
  return { kind: 'current' }
}

// ---------------------------------------------------------------------------
// Live branch label (badge display precedence)
// ---------------------------------------------------------------------------

export interface LiveBranchLabelState {
  detached: boolean
  /** Live current branch from Git context, when known. */
  currentBranch: string | null
  /** Live default ref from Git context, when known. */
  defaultRef: string | null
  /** Persisted branch from the resolved checkout identity, when known. */
  identityBranch: string | null | undefined
}

/**
 * Resolve the branch label shown on the badge.
 *
 * Precedence: live detached state, live current branch, live default ref,
 * the identity's persisted branch, then the generic Current checkout label.
 * The persisted branch matters while live context is still loading (e.g. a
 * resumed Current checkout whose branchAtPreparation is already known), so the
 * badge never degrades to the generic label when it has real identity data.
 */
export function resolveLiveBranchLabel(
  state: LiveBranchLabelState,
  labels: { detached: string; currentCheckout: string },
): string {
  if (state.detached) return labels.detached
  return state.currentBranch ?? state.defaultRef ?? state.identityBranch ?? labels.currentCheckout
}

// ---------------------------------------------------------------------------
// Checkout recovery (AC20 — restart/reconnect/missing/externally changed)
// ---------------------------------------------------------------------------

/** Registry/reconcile lifecycle status for a managed worktree, when known. */
export type WorktreeLifecycleStatus = 'active' | 'missing' | 'blocked'

export interface CheckoutRecoveryState {
  /** Persisted managed-worktree checkout; recovery only applies to these. */
  checkout: SessionCheckoutV1 | null
  /**
   * Whether repository context finished loading. Recovery is suppressed while
   * loading so a resumed/restarted session keeps its locked identity and does
   * not flash a false drift warning before the live branch is known.
   */
  contextLoaded: boolean
  /** Live current branch in the resolved checkout, null when detached/unknown. */
  liveBranch: string | null
  /** Live HEAD is detached. */
  liveDetached: boolean
  /** Whether the checkout path still resolves to a Git repository. */
  checkoutExists: boolean
  /** Registry/reconcile status for the managed worktree, when known. */
  worktreeStatus?: WorktreeLifecycleStatus
}

export type CheckoutRecovery =
  | { kind: 'ok' }
  /** The managed worktree directory/registry entry is gone — must recreate. */
  | { kind: 'missing' }
  /** The worktree was externally switched to another branch or detached. */
  | { kind: 'branch-drift'; expected: string; found: string | null }
  /** The server marked the worktree blocked (e.g. a Git command failed). */
  | { kind: 'blocked'; reason?: string }

/**
 * Decide whether a persisted managed-worktree checkout needs a visible recovery
 * or blocked state (spec: AC20). Mirrors the server-side mutation identity guard
 * (`checkManagedCheckoutIdentity`) so the composer badge surfaces the same drift
 * the server would refuse to mutate on — Kata never silently switches directory.
 *
 * Precedence: blocked → missing → branch-drift. A current checkout, an absent
 * checkout, or an unloaded repository context returns `ok`.
 */
export function resolveCheckoutRecovery(state: CheckoutRecoveryState): CheckoutRecovery {
  const { checkout } = state
  if (!checkout || checkout.mode !== 'managed-worktree') return { kind: 'ok' }
  if (!state.contextLoaded) return { kind: 'ok' }

  if (state.worktreeStatus === 'blocked') return { kind: 'blocked' }
  if (!state.checkoutExists || state.worktreeStatus === 'missing') return { kind: 'missing' }

  if (checkout.expectedBranch) {
    const found = state.liveDetached ? null : state.liveBranch
    if (found !== checkout.expectedBranch) {
      return { kind: 'branch-drift', expected: checkout.expectedBranch, found }
    }
  }
  return { kind: 'ok' }
}
