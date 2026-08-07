/**
 * Pure helpers for the worktree handoff dialog and action surfaces.
 *
 * Kept free of React so the direction gating, dialog state machine, and
 * preview formatting can be exercised in isolation and shared by the Changes
 * panel surface and the preview/confirm/recovery dialog (spec AC-2/5/7/11).
 *
 * The client never nominates paths: it submits a session ID, a direction, and
 * (for current-to-managed) a worktree name; the server owns every Git mutation
 * and revalidates the exact preview fingerprint under lock before acting.
 */

import type {
  CheckoutMode,
  WorktreeHandoffDirection,
  WorktreeHandoffPreview,
  WorktreeHandoffResult,
  WorktreeHandoffStatus,
} from '@kata-sh/shared/protocol'

import { normalizeWorktreeName, normalizeWorktreeNameInput, generateDefaultWorktreeName } from './checkout-controls'

// ---------------------------------------------------------------------------
// Direction availability
// ---------------------------------------------------------------------------

/**
 * Directions structurally possible for a session, derived from client-visible
 * state only. The server remains authoritative: a preview for a structurally
 * possible direction returns a typed blocker when the provider is unsupported,
 * the checkout is shared, a destination is dirty, etc.
 *
 * - No checkout or a `current` checkout → hand off to a new managed worktree.
 * - A `managed-worktree` checkout → hand off back to the current checkout.
 * - A `current` session that already completed a handoff (the persisted
 *   `handoffRuntimeState` is armed) may hand back to its released worktree.
 */
export function handoffDirectionsForCheckout(
  checkout: { mode: CheckoutMode } | undefined,
  handoffRuntimeState?: string | null,
): WorktreeHandoffDirection[] {
  if (!checkout) return ['current-to-managed']
  if (checkout.mode === 'managed-worktree') return ['managed-to-current']
  const directions: WorktreeHandoffDirection[] = ['current-to-managed']
  if (handoffRuntimeState) directions.push('hand-back')
  return directions
}

/** Initial editable name for a direction (only current-to-managed names a target). */
export function defaultNameForDirection(direction: WorktreeHandoffDirection): string {
  return direction === 'current-to-managed' ? generateDefaultWorktreeName() : ''
}

/**
 * Normalize an in-progress name edit for display (keep separators while typing)
 * and its finalized value for the wire. Delegates to the checkout controls so
 * the client and server agree on a valid branch suffix.
 */
export function normalizeHandoffNameInput(value: string): string {
  return normalizeWorktreeNameInput(value)
}

export function finalizeHandoffName(value: string): string {
  return normalizeWorktreeName(value)
}

// ---------------------------------------------------------------------------
// Preview helpers
// ---------------------------------------------------------------------------

/** True when the session workspace is owned by a remote server. */
export function isRemoteOwnedPreview(isRemoteWorkspace: boolean): boolean {
  return isRemoteWorkspace
}

/** Human-readable source state label key for a preview source state. */
export function sourceStateKey(state: WorktreeHandoffPreview['source']['state']): string {
  return state === 'clean' ? 'git.handoff.state.clean' : state === 'dirty' ? 'git.handoff.state.dirty' : 'git.handoff.state.detached'
}

/** Whether a confirm is safe to dispatch for the current phase. */
export function canConfirmHandoff(phase: HandoffDialogPhase, preview: WorktreeHandoffPreview | null): boolean {
  return phase === 'preview' && preview !== null && preview.blocked === undefined
}

/**
 * Whether confirm is safe for the currently edited name: the preview must have
 * been issued for exactly the suffix in the input, otherwise a stale preview
 * (name edit's re-preview still in flight) could confirm the previous name.
 */
export function canConfirmHandoffForName(
  state: HandoffDialogState,
): boolean {
  if (!canConfirmHandoff(state.phase, state.preview)) return false
  if (state.preview?.direction !== 'current-to-managed') return true
  return finalizeHandoffName(state.nameInput) === state.previewedName
}

/** Whether recovery can be attempted for the current phase. */
export function canRecoverHandoff(phase: HandoffDialogPhase, result: WorktreeHandoffResult | null): boolean {
  return phase === 'recovery-required' && result?.outcome === 'recovery-required'
}

/**
 * Synthesize a recovery-required result from an active handoff status so the
 * recovery surface can open directly from a pending/failed transaction
 * (e.g. discovered by HANDOFF_STATUS polling after a restart).
 */
export function recoveryResultFromStatus(
  status: Extract<WorktreeHandoffStatus, { active: true }>,
  reason: string,
): Extract<WorktreeHandoffResult, { outcome: 'recovery-required' }> {
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

export type HandoffDialogPhase =
  | 'idle'
  | 'loading'
  | 'unsupported'
  | 'preview'
  | 'preview-blocked'
  | 'confirming'
  | 'committed'
  | 'blocked'
  | 'recovery-required'
  | 'recovering'
  | 'error'

export interface HandoffDialogState {
  phase: HandoffDialogPhase
  /** Server-issued transaction + fingerprint; confirm reuses the exact preview. */
  preview: WorktreeHandoffPreview | null
  /** Branch suffix the current preview was issued for ('' for non-named directions). */
  previewedName: string
  /** Editable suffix for current-to-managed; normalized for the wire. */
  nameInput: string
  /** Sanitized server detail for blocked / error / recovery phases. */
  message: string
  /** Most recent confirm/recover result (committed / blocked / recovery-required). */
  result: WorktreeHandoffResult | null
}

export function initialHandoffDialogState(): HandoffDialogState {
  return { phase: 'idle', preview: null, previewedName: '', nameInput: '', message: '', result: null }
}

export type HandoffDialogAction =
  | { type: 'open'; direction: WorktreeHandoffDirection; initialName?: string }
  | { type: 'preview-ready'; preview: WorktreeHandoffPreview }
  | { type: 'preview-error'; message: string }
  | { type: 'name-changed'; value: string }
  | { type: 'confirm' }
  | { type: 'confirm-ready'; result: WorktreeHandoffResult }
  | { type: 'recovery-from-status'; result: WorktreeHandoffResult }
  | { type: 'recover' }
  | { type: 'recover-ready'; result: WorktreeHandoffResult }
  | { type: 'recover-error'; message: string }
  | { type: 'reset' }

function resultPhase(result: WorktreeHandoffResult): HandoffDialogPhase {
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
export function reduceHandoffDialog(state: HandoffDialogState, action: HandoffDialogAction): HandoffDialogState {
  switch (action.type) {
    case 'open':
      return {
        ...initialHandoffDialogState(),
        phase: 'loading',
        nameInput:
          action.direction === 'current-to-managed' ? (action.initialName ?? generateDefaultWorktreeName()) : '',
      }
    case 'preview-ready': {
      const blocked = action.preview.blocked
      // Track the branch suffix this preview was issued for so confirm stays
      // disabled while a name edit's re-preview is still in flight (a stale
      // preview could otherwise confirm the previous name).
      const previewedName =
        action.preview.direction === 'current-to-managed'
          ? action.preview.destination.branch.replace(/^kata-agent\//, '')
          : ''
      if (blocked?.code === 'unsupported-provider') {
        return { ...state, phase: 'unsupported', preview: action.preview, previewedName, message: blocked.reason, result: null }
      }
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
      return initialHandoffDialogState()
  }
}
