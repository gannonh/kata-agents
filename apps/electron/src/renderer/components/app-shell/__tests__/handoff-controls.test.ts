import { describe, expect, it } from 'bun:test'
import type {
  SessionCheckout,
  WorktreeHandoffDirection,
  WorktreeHandoffPreview,
  WorktreeHandoffResult,
} from '@kata-sh/shared/protocol'
import {
  canOfferHandoff,
  canConfirmHandoff,
  canRecoverHandoff,
  defaultNameForDirection,
  finalizeHandoffName,
  handoffDirectionsForCheckout,
  initialHandoffDialogState,
  isRemoteOwnedPreview,
  normalizeHandoffNameInput,
  recoveryResultFromStatus,
  reduceHandoffDialog,
  sourceStateKey,
} from '../input/handoff-controls'

function currentCheckout(): SessionCheckout {
  return {
    schemaVersion: 1,
    mode: 'current',
    repositoryRoot: '/repo',
    checkoutPath: '/repo',
    branchAtPreparation: null,
    baseRef: null,
    managedWorktreeId: null,
    expectedBranch: null,
  }
}

function managedCheckout(): SessionCheckout {
  return {
    schemaVersion: 2,
    mode: 'managed-worktree',
    repositoryRoot: '/repo',
    checkoutPath: '/srv/worktrees/repo/ab12cd34',
    branchAtPreparation: 'kata-agent/ab12cd34',
    baseRef: 'main',
    managedWorktreeId: 'repo-ab12cd34',
    displayName: 'ab12cd34',
    expectedBranch: 'kata-agent/ab12cd34',
    materializationRoot: '/srv/worktrees',
  }
}

function previewFor(overrides: Partial<WorktreeHandoffPreview> = {}): WorktreeHandoffPreview {
  return {
    transactionId: 'txn-abc',
    previewFingerprint: 'f'.repeat(64),
    direction: 'current-to-managed',
    providerCapability: { adapterId: 'pi', executionCwdRebindable: true },
    source: {
      serverId: 'local',
      branch: 'main',
      headSha: 'a'.repeat(40),
      state: 'clean',
      checkoutPath: '/repo',
      leases: [],
    },
    destination: {
      serverId: 'local',
      repositoryRoot: '/repo',
      branch: 'kata-agent/ab12cd34',
      checkoutPath: '/srv/worktrees/repo/ab12cd34',
      exists: false,
      leases: [],
    },
    includeCopyConflicts: [],
    excludedIgnoredPolicy: { includeOnly: true, includeFileCount: 0 },
    cleanup: { trackedFileCount: 0, stagedFileCount: 0, eligibleUntrackedFileCount: 0, includedIgnoredFileCount: 0 },
    recoveryBehavior: 'destination-authoritative',
    ...overrides,
  }
}

describe('handoff direction availability', () => {
  it('offers current-to-managed for a legacy session without checkout', () => {
    expect(handoffDirectionsForCheckout(undefined)).toEqual(['current-to-managed'])
  })

  it('offers current-to-managed for a bound current checkout', () => {
    expect(handoffDirectionsForCheckout(currentCheckout())).toEqual(['current-to-managed'])
  })

  it('adds hand-back once a current session completed a prior handoff', () => {
    expect(handoffDirectionsForCheckout(currentCheckout(), 'unverified')).toEqual(['current-to-managed', 'hand-back'])
    expect(handoffDirectionsForCheckout(currentCheckout(), 'recovery-required')).toEqual(['current-to-managed', 'hand-back'])
  })

  it('offers managed-to-current for a managed worktree', () => {
    expect(handoffDirectionsForCheckout(managedCheckout())).toEqual(['managed-to-current'])
  })

  it('canOfferHandoff is false only when no direction applies', () => {
    expect(canOfferHandoff(undefined)).toBe(true)
    expect(canOfferHandoff(currentCheckout())).toBe(true)
    expect(canOfferHandoff(managedCheckout())).toBe(true)
  })

  it('defaults the name only for current-to-managed', () => {
    expect(defaultNameForDirection('current-to-managed')).toMatch(/^[0-9a-f]{8}$/)
    expect(defaultNameForDirection('managed-to-current')).toBe('')
    expect(defaultNameForDirection('hand-back')).toBe('')
  })

  it('normalizes names like the checkout controls', () => {
    expect(normalizeHandoffNameInput('Auth Refresh')).toBe('auth-refresh')
    expect(finalizeHandoffName('auth-refresh/')).toBe('auth-refresh')
  })
})

describe('handoff preview helpers', () => {
  it('labels previews as remote only when the workspace is remote', () => {
    expect(isRemoteOwnedPreview(previewFor(), false)).toBe(false)
    expect(isRemoteOwnedPreview(previewFor(), true)).toBe(true)
  })

  it('maps source states to i18n keys', () => {
    expect(sourceStateKey('clean')).toBe('git.handoff.state.clean')
    expect(sourceStateKey('dirty')).toBe('git.handoff.state.dirty')
    expect(sourceStateKey('detached')).toBe('git.handoff.state.detached')
  })

  it('confirms only a non-blocked preview', () => {
    expect(canConfirmHandoff('preview', previewFor())).toBe(true)
    expect(canConfirmHandoff('loading', previewFor())).toBe(false)
    expect(canConfirmHandoff('preview', previewFor({ blocked: { blocked: true, code: 'destination-dirty', reason: 'occupied' } }))).toBe(false)
    expect(canConfirmHandoff('preview', null)).toBe(false)
  })

  it('recovers only from a recovery-required result', () => {
    const recovery: WorktreeHandoffResult = {
      outcome: 'recovery-required',
      transactionId: 'txn',
      recovery: 'source-released',
      retainedSnapshotId: 'abcd1234abcd1234',
      reason: 'interrupted',
    }
    expect(canRecoverHandoff('recovery-required', recovery)).toBe(true)
    expect(canRecoverHandoff('preview', recovery)).toBe(false)
    expect(canRecoverHandoff('recovery-required', null)).toBe(false)
  })

  it('synthesizes a recovery-required result from an active status', () => {
    const result = recoveryResultFromStatus(
      {
        active: true,
        transactionId: 'txn-status',
        direction: 'managed-to-current',
        state: 'source-released',
        retainedSnapshotId: 'abcd1234abcd1234',
        since: 123,
      },
      'The handoff was interrupted.',
    )
    expect(result).toEqual({
      outcome: 'recovery-required',
      transactionId: 'txn-status',
      recovery: 'source-released',
      retainedSnapshotId: 'abcd1234abcd1234',
      reason: 'The handoff was interrupted.',
    })
  })

  it('opens directly into recovery from a status without preview', () => {
    let state = reduceHandoffDialog(initialHandoffDialogState(), { type: 'open', direction: 'managed-to-current' })
    state = reduceHandoffDialog(state, {
      type: 'recovery-from-status',
      result: {
        outcome: 'recovery-required',
        transactionId: 'txn-status',
        recovery: 'runtime-rebuilding',
        retainedSnapshotId: 'abcd1234abcd1234',
        reason: 'interrupted after release',
      },
    })
    expect(state.phase).toBe('recovery-required')
    expect(state.result?.outcome).toBe('recovery-required')
    expect(state.message).toBe('interrupted after release')
    expect(canRecoverHandoff(state.phase, state.result)).toBe(true)
  })
})

describe('handoff dialog state machine', () => {
  it('opens into a loading phase with a default name for current-to-managed', () => {
    const next = reduceHandoffDialog(initialHandoffDialogState(), { type: 'open', direction: 'current-to-managed' })
    expect(next.phase).toBe('loading')
    expect(next.nameInput).toMatch(/^[0-9a-f]{8}$/)
  })

  it('opens into a loading phase without a name for other directions', () => {
    const next = reduceHandoffDialog(initialHandoffDialogState(), { type: 'open', direction: 'managed-to-current' })
    expect(next.phase).toBe('loading')
    expect(next.nameInput).toBe('')
  })

  it('shows the preview and keeps the server fingerprint for confirm', () => {
    let state = reduceHandoffDialog(initialHandoffDialogState(), { type: 'open', direction: 'current-to-managed' })
    state = reduceHandoffDialog(state, { type: 'preview-ready', preview: previewFor() })
    expect(state.phase).toBe('preview')
    expect(state.preview?.previewFingerprint).toBe('f'.repeat(64))

    state = reduceHandoffDialog(state, { type: 'confirm' })
    expect(state.phase).toBe('confirming')
  })

  it('surfaces a typed blocker and disables confirm', () => {
    let state = reduceHandoffDialog(initialHandoffDialogState(), { type: 'open', direction: 'managed-to-current' })
    state = reduceHandoffDialog(state, {
      type: 'preview-ready',
      preview: previewFor({ blocked: { blocked: true, code: 'destination-dirty', reason: 'The current checkout has tracked state.' } }),
    })
    expect(state.phase).toBe('preview-blocked')
    expect(state.message).toBe('The current checkout has tracked state.')
    expect(canConfirmHandoff(state.phase, state.preview)).toBe(false)
  })

  it('flags an unsupported provider without a confirm path', () => {
    let state = reduceHandoffDialog(initialHandoffDialogState(), { type: 'open', direction: 'current-to-managed' })
    state = reduceHandoffDialog(state, {
      type: 'preview-ready',
      preview: previewFor({ blocked: { blocked: true, code: 'unsupported-provider', reason: 'adapter cannot rebind' } }),
    })
    expect(state.phase).toBe('unsupported')
    expect(canConfirmHandoff(state.phase, state.preview)).toBe(false)
  })

  it('re-previews after a name edit so confirm never uses a stale fingerprint', () => {
    let state = reduceHandoffDialog(initialHandoffDialogState(), { type: 'open', direction: 'current-to-managed' })
    state = reduceHandoffDialog(state, { type: 'preview-ready', preview: previewFor() })
    state = reduceHandoffDialog(state, { type: 'name-changed', value: 'auth-refresh' })
    expect(state.phase).toBe('loading')
    expect(state.nameInput).toBe('auth-refresh')
    expect(canConfirmHandoff(state.phase, state.preview)).toBe(false)
  })

  it('renders the committed summary after a successful confirm', () => {
    const committed: WorktreeHandoffResult = {
      outcome: 'committed',
      transactionId: 'txn-abc',
      summary: {
        sessionId: 's1',
        direction: 'current-to-managed',
        checkout: managedCheckout(),
        executionCwd: '/srv/worktrees/repo/ab12cd34',
        transcriptCwd: '/repo/.kata/sessions/s1',
        committedAt: 1,
      },
    }
    let state = reduceHandoffDialog(initialHandoffDialogState(), { type: 'open', direction: 'current-to-managed' })
    state = reduceHandoffDialog(state, { type: 'preview-ready', preview: previewFor() })
    state = reduceHandoffDialog(state, { type: 'confirm' })
    state = reduceHandoffDialog(state, { type: 'confirm-ready', result: committed })
    expect(state.phase).toBe('committed')
    expect(state.result?.outcome).toBe('committed')
    expect(state.message).toBe('')
  })

  it('enters recovery-required on a failed confirm and recovers via a rolled-back blocker', () => {
    const recovery: WorktreeHandoffResult = {
      outcome: 'recovery-required',
      transactionId: 'txn-abc',
      recovery: 'runtime-rebuilding',
      retainedSnapshotId: 'abcd1234abcd1234',
      reason: 'runtime rebind failed',
    }
    let state = reduceHandoffDialog(initialHandoffDialogState(), { type: 'open', direction: 'current-to-managed' })
    state = reduceHandoffDialog(state, { type: 'preview-ready', preview: previewFor() })
    state = reduceHandoffDialog(state, { type: 'confirm' })
    state = reduceHandoffDialog(state, { type: 'confirm-ready', result: recovery })
    expect(state.phase).toBe('recovery-required')
    expect(state.message).toBe('runtime rebind failed')

    state = reduceHandoffDialog(state, { type: 'recover' })
    expect(state.phase).toBe('recovering')

    const rolledBack: WorktreeHandoffResult = {
      outcome: 'blocked',
      transactionId: 'txn-abc',
      code: 'handoff-rolled-back',
      reason: 'The interrupted handoff was rolled back; preview again to retry.',
    }
    state = reduceHandoffDialog(state, { type: 'recover-ready', result: rolledBack })
    expect(state.phase).toBe('blocked')
    expect(state.result?.outcome).toBe('blocked')
  })

  it('keeps recovery-required when recover cannot finish', () => {
    const recovery: WorktreeHandoffResult = {
      outcome: 'recovery-required',
      transactionId: 'txn-abc',
      recovery: 'source-released',
      reason: 'snapshot authority missing',
    }
    let state = reduceHandoffDialog(initialHandoffDialogState(), { type: 'open', direction: 'hand-back' })
    state = reduceHandoffDialog(state, { type: 'preview-ready', preview: previewFor() })
    state = reduceHandoffDialog(state, { type: 'confirm' })
    state = reduceHandoffDialog(state, { type: 'confirm-ready', result: recovery })
    state = reduceHandoffDialog(state, { type: 'recover' })
    state = reduceHandoffDialog(state, { type: 'recover-ready', result: recovery })
    expect(state.phase).toBe('recovery-required')
  })

  it('surfaces preview errors and resets to idle', () => {
    let state = reduceHandoffDialog(initialHandoffDialogState(), { type: 'open', direction: 'current-to-managed' })
    state = reduceHandoffDialog(state, { type: 'preview-error', message: 'server unreachable' })
    expect(state.phase).toBe('error')
    expect(state.message).toBe('server unreachable')

    state = reduceHandoffDialog(state, { type: 'reset' })
    expect(state).toEqual(initialHandoffDialogState())
  })
})
