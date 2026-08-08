/**
 * Pure helpers for the isolated conversation-fork dialog and action surfaces.
 *
 * Kept free of React so the strategy eligibility, dialog state machine, and
 * preview formatting can be exercised in isolation and shared by the Branch
 * action surface and the preview/confirm/recovery dialog (Phase 4 spec).
 *
 * The client never nominates paths: it submits a session ID, a strategy, and
 * (for isolated) an editable worktree name suffix; the server owns every Git
 * mutation and revalidates the exact preview fingerprint under lock before
 * acting. The shared-worktree strategy keeps the pre-existing branch flow
 * (the server throws FORK_NOT_IMPLEMENTED for shared confirmation, so the
 * dialog falls back to the existing onCreateSession branch path).
 */

import type {
  ConversationForkPreview,
  ConversationForkResult,
  ConversationForkStatus,
  ConversationForkStrategy,
} from '@kata-sh/shared/protocol'

import { normalizeWorktreeName, normalizeWorktreeNameInput, generateDefaultWorktreeName } from './checkout-controls'

// ---------------------------------------------------------------------------
// Strategy availability
// ---------------------------------------------------------------------------

/** The pre-existing branch behavior remains the default choice. */
export function forkStrategyDefault(): ConversationForkStrategy {
  return 'shared-worktree'
}

export interface ForkStrategyEligibility {
  /** True when the session's provider advertises a strict cross-CWD native fork. */
  isolatedCapable: boolean
  /** True when the branch point is the current conversation head. */
  atConversationHead: boolean
}

/**
 * Whether the isolated-worktree strategy may be offered. Both conditions are
 * required: an unsupported provider and an older (non-head) source turn each
 * disable isolated with a typed reason. The server's preview remains the
 * authoritative backstop (typed blockers come back as normal preview results).
 */
export function forkIsolatedEligible({ isolatedCapable, atConversationHead }: ForkStrategyEligibility): boolean {
  return isolatedCapable && atConversationHead
}

// ---------------------------------------------------------------------------
// Name normalization
// ---------------------------------------------------------------------------

/** Normalize an in-progress name edit for display (keep separators while typing). */
export function normalizeForkNameInput(value: string): string {
  return normalizeWorktreeNameInput(value)
}

/** Normalize the finalized name for the wire (canonical branch suffix). */
export function finalizeForkName(value: string): string {
  return normalizeWorktreeName(value)
}

/** Human-readable source git-state label key for a preview source state. */
export function forkSourceStateKey(state: ConversationForkPreview['source']['gitState']['state']): string {
  return state === 'clean'
    ? 'git.fork.state.clean'
    : state === 'dirty'
      ? 'git.fork.state.dirty'
      : 'git.fork.state.detached'
}

// ---------------------------------------------------------------------------
// Preview helpers
// ---------------------------------------------------------------------------

/** Whether a confirm is safe to dispatch for the current phase. */
export function canConfirmFork(phase: ForkDialogPhase, preview: ConversationForkPreview | null): boolean {
  return phase === 'preview' && preview !== null && preview.blocked === undefined
}

/**
 * Whether confirm is safe for the currently edited name: the preview must have
 * been issued for exactly the suffix in the input, otherwise a stale preview
 * (name edit's re-preview still in flight) could confirm the previous name.
 * The shared strategy has no editable name and confirms on any preview.
 */
export function canConfirmForkForName(state: ForkDialogState): boolean {
  if (!canConfirmFork(state.phase, state.preview)) return false
  if (state.strategy !== 'isolated-worktree') return true
  return finalizeForkName(state.nameInput) === state.previewedName
}

/** Whether recovery can be attempted for the current phase. */
export function canRecoverFork(phase: ForkDialogPhase, result: ConversationForkResult | null): boolean {
  return phase === 'recovery-required' && result?.outcome === 'recovery-required'
}

/**
 * Client-side disable reason (i18n key) for the isolated strategy row. Empty
 * when the strategy may be selected. A blocked isolated preview's server
 * reason takes precedence; otherwise the two eligibility gates each carry a
 * typed reason (unsupported provider / non-head source).
 */
export function forkIsolatedDisabledReason(input: {
  phase: ForkDialogPhase
  strategy: ConversationForkStrategy
  atConversationHead: boolean
  isolatedCapable: boolean
  /** Current preview blocker message when the isolated preview is blocked. */
  blockedMessage: string
}): string {
  if (input.phase === 'preview-blocked' && input.strategy === 'isolated-worktree') return input.blockedMessage
  if (!input.atConversationHead) return 'git.fork.nonHeadDisabled'
  if (!input.isolatedCapable) return 'git.fork.unsupportedProviderDisabled'
  return ''
}

/**
 * Child session ID of a committed fork result; null for any other outcome.
 * The dialog navigates to this child once the isolated confirm commits.
 */
export function forkCommittedChildSessionId(result: ConversationForkResult | null): string | null {
  return result?.outcome === 'committed' ? result.summary.sessionId : null
}

/**
 * Synthesize a recovery-required result from an active fork status so the
 * recovery surface can open directly from a pending/failed transaction
 * (e.g. discovered by FORK_STATUS polling after a restart).
 */
export function recoveryResultFromForkStatus(
  status: Extract<ConversationForkStatus, { active: true }>,
  reason: string,
): Extract<ConversationForkResult, { outcome: 'recovery-required' }> {
  return {
    outcome: 'recovery-required',
    transactionId: status.transactionId,
    recovery: status.state,
    ...(status.retainedSnapshotId ? { retainedSnapshotId: status.retainedSnapshotId } : {}),
    reason,
  }
}

// ---------------------------------------------------------------------------
// Dialog state machine
// ---------------------------------------------------------------------------

export type ForkDialogPhase =
  | 'idle'
  | 'loading'
  | 'preview'
  | 'preview-blocked'
  | 'confirming'
  | 'committed'
  | 'blocked'
  | 'recovery-required'
  | 'recovering'
  | 'error'

export interface ForkDialogState {
  phase: ForkDialogPhase
  /** Strategy the current preview was issued for. */
  strategy: ConversationForkStrategy
  /** Server-issued transaction + fingerprint; confirm reuses the exact preview. */
  preview: ConversationForkPreview | null
  /** Branch suffix the current preview was issued for ('' for shared). */
  previewedName: string
  /** Editable suffix for isolated; normalized for the wire. */
  nameInput: string
  /** Sanitized server detail for blocked / error / recovery phases. */
  message: string
  /** Most recent confirm/recover result (committed / blocked / recovery-required). */
  result: ConversationForkResult | null
}

export function initialForkDialogState(): ForkDialogState {
  return { phase: 'idle', strategy: forkStrategyDefault(), preview: null, previewedName: '', nameInput: '', message: '', result: null }
}

export type ForkDialogAction =
  | { type: 'open'; strategy?: ConversationForkStrategy; initialName?: string }
  | { type: 'strategy-changed'; strategy: ConversationForkStrategy; nameInput?: string }
  | { type: 'preview-ready'; preview: ConversationForkPreview }
  | { type: 'preview-error'; message: string }
  | { type: 'name-changed'; value: string }
  | { type: 'confirm' }
  | { type: 'confirm-ready'; result: ConversationForkResult }
  | { type: 'recovery-from-status'; result: ConversationForkResult }
  | { type: 'recover' }
  | { type: 'recover-ready'; result: ConversationForkResult }
  | { type: 'recover-error'; message: string }
  | { type: 'reset' }

function resultPhase(result: ConversationForkResult): ForkDialogPhase {
  switch (result.outcome) {
    case 'committed':
      return 'committed'
    case 'blocked':
      return 'blocked'
    case 'recovery-required':
      return 'recovery-required'
  }
}

/**
 * Pure dialog state machine. The React component wires RPC calls and feeds
 * the results in; every branch is unit-tested here.
 */
export function reduceForkDialog(state: ForkDialogState, action: ForkDialogAction): ForkDialogState {
  switch (action.type) {
    case 'open': {
      const strategy = action.strategy ?? forkStrategyDefault()
      return {
        ...initialForkDialogState(),
        phase: 'loading',
        strategy,
        nameInput:
          strategy === 'isolated-worktree' ? (action.initialName ?? generateDefaultWorktreeName()) : '',
      }
    }
    case 'strategy-changed': {
      if (action.strategy === state.strategy) return state
      if (state.phase !== 'loading' && state.phase !== 'preview' && state.phase !== 'preview-blocked') return state
      // Switching strategy invalidates the previous fingerprint; the component
      // re-previews for the new strategy before confirm is re-enabled. The
      // component supplies the exact name it previews so the input and the
      // previewed branch suffix can never diverge.
      return {
        ...initialForkDialogState(),
        phase: 'loading',
        strategy: action.strategy,
        nameInput:
          action.strategy === 'isolated-worktree'
            ? (action.nameInput ?? state.nameInput ?? generateDefaultWorktreeName())
            : '',
      }
    }
    case 'preview-ready': {
      const blocked = action.preview.blocked
      // Track the branch suffix this preview was issued for so confirm stays
      // disabled while a name edit's re-preview is still in flight.
      const previewedName =
        action.preview.strategy === 'isolated-worktree'
          ? action.preview.destination.branch.replace(/^kata-agent\//, '')
          : ''
      if (blocked) {
        return { ...state, phase: 'preview-blocked', preview: action.preview, previewedName, message: blocked.reason, result: null }
      }
      return { ...state, phase: 'preview', preview: action.preview, previewedName, message: '', result: null }
    }
    case 'preview-error':
      return { ...state, phase: 'error', message: action.message, result: null }
    case 'name-changed': {
      // Editing the name invalidates the fingerprint; the component re-previews
      // with the new suffix before confirm is re-enabled. Allowed while a
      // blocker (e.g. invalid-name or a destination collision) keeps the
      // preview unusable so the user can fix the name inline.
      if (state.phase !== 'preview' && state.phase !== 'preview-blocked') return state
      return { ...state, phase: 'loading', nameInput: action.value }
    }
    case 'confirm':
      if (state.phase !== 'preview' || !state.preview || state.preview.blocked) return state
      return { ...state, phase: 'confirming' }
    case 'confirm-ready':
      return {
        ...state,
        phase: resultPhase(action.result),
        result: action.result,
        message: action.result.outcome === 'committed' ? '' : action.result.reason,
      }
    case 'recovery-from-status':
      if (action.result.outcome !== 'recovery-required') return state
      return {
        ...state,
        phase: 'recovery-required',
        result: action.result,
        message: action.result.reason,
      }
    case 'recover':
      if (state.phase !== 'recovery-required' || state.result?.outcome !== 'recovery-required') return state
      return { ...state, phase: 'recovering' }
    case 'recover-ready':
      return {
        ...state,
        phase: resultPhase(action.result),
        result: action.result,
        message: action.result.outcome === 'committed' ? '' : action.result.reason,
      }
    case 'recover-error':
      // Keep the recovery surface mounted so a transient IPC/network failure
      // cannot strand the interrupted transaction unrecoverable from the
      // open dialog; the Recover control stays available to retry.
      return { ...state, phase: 'recovery-required', message: action.message }
    case 'reset':
      return initialForkDialogState()
  }
}
