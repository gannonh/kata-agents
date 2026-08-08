import { describe, expect, it } from 'bun:test'
import type {
  ConversationForkPreview,
  ConversationForkResult,
  ConversationForkStatus,
} from '@kata-sh/shared/protocol'
import {
  canConfirmFork,
  canConfirmForkForName,
  canRecoverFork,
  finalizeForkName,
  forkCommittedChildSessionId,
  forkIsolatedDisabledReason,
  forkIsolatedEligible,
  forkStrategyDefault,
  initialForkDialogState,
  normalizeForkNameInput,
  recoveryResultFromForkStatus,
  reduceForkDialog,
} from '../input/fork-controls'

function committedResult(): Extract<ConversationForkResult, { outcome: 'committed' }> {
  return {
    outcome: 'committed',
    transactionId: 'txn-abc',
    summary: {
      sessionId: 'child-1',
      strategy: 'isolated-worktree',
      checkout: {
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
      },
      executionCwd: '/srv/worktrees/repo/ab12cd34',
      transcriptCwd: '/repo/.kata/sessions/s1',
      childProviderIdPresent: false,
      committedAt: 1,
    },
  }
}

function previewFor(overrides: Partial<ConversationForkPreview> = {}): ConversationForkPreview {
  return {
    transactionId: 'txn-abc',
    previewFingerprint: 'f'.repeat(64),
    strategy: 'isolated-worktree',
    providerCapability: { adapterId: 'pi', strictCrossCwdNativeFork: true },
    source: {
      serverId: 'local',
      sessionId: 's1',
      conversationHeadMessageId: 'msg-9',
      conversationHeadTurnId: 'turn-9',
      checkout: { mode: 'current' },
      branch: 'main',
      headSha: 'a'.repeat(40),
      gitState: {
        state: 'clean',
        stagedFileCount: 0,
        unstagedFileCount: 0,
        untrackedFileCount: 0,
        includedIgnoredFileCount: 0,
      },
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
    excludedIgnoredPolicy: { includeOnly: true, includeFileCount: 0 },
    currentHead: true,
    ...overrides,
  }
}

describe('fork strategy default + eligibility', () => {
  it('defaults to the shared-worktree strategy', () => {
    expect(forkStrategyDefault()).toBe('shared-worktree')
  })

  it('offers isolated only when the provider is capable AND the branch point is the current head', () => {
    expect(forkIsolatedEligible({ isolatedCapable: true, atConversationHead: true })).toBe(true)
    expect(forkIsolatedEligible({ isolatedCapable: false, atConversationHead: true })).toBe(false)
    expect(forkIsolatedEligible({ isolatedCapable: true, atConversationHead: false })).toBe(false)
    expect(forkIsolatedEligible({ isolatedCapable: false, atConversationHead: false })).toBe(false)
  })

  it('normalizes names like the checkout controls', () => {
    expect(normalizeForkNameInput('Auth Refresh')).toBe('auth-refresh')
    expect(finalizeForkName('auth-refresh/')).toBe('auth-refresh')
  })
})

describe('fork preview helpers', () => {
  it('confirms only a non-blocked preview', () => {
    expect(canConfirmFork('preview', previewFor())).toBe(true)
    expect(canConfirmFork('loading', previewFor())).toBe(false)
    expect(
      canConfirmFork('preview', previewFor({ blocked: { blocked: true, code: 'non-head-source', reason: 'older point' } })),
    ).toBe(false)
    expect(canConfirmFork('preview', null)).toBe(false)
  })

  it('recovers only from a recovery-required result', () => {
    const recovery: ConversationForkResult = {
      outcome: 'recovery-required',
      transactionId: 'txn',
      recovery: 'binding-committed',
      retainedSnapshotId: 'abcd1234abcd1234',
      reason: 'interrupted',
    }
    expect(canRecoverFork('recovery-required', recovery)).toBe(true)
    expect(canRecoverFork('preview', recovery)).toBe(false)
    expect(canRecoverFork('recovery-required', null)).toBe(false)
  })

  it('synthesizes a recovery-required result from an active status', () => {
    const status: Extract<ConversationForkStatus, { active: true }> = {
      active: true,
      transactionId: 'txn-status',
      strategy: 'isolated-worktree',
      state: 'binding-committed',
      retainedSnapshotId: 'abcd1234abcd1234',
      since: 123,
      providerIdentity: { status: 'pending' },
    }
    const result = recoveryResultFromForkStatus(status, 'The fork was interrupted.')
    expect(result).toEqual({
      outcome: 'recovery-required',
      transactionId: 'txn-status',
      recovery: 'binding-committed',
      retainedSnapshotId: 'abcd1234abcd1234',
      reason: 'The fork was interrupted.',
    })
  })

  it('omits retainedSnapshotId when the active status does not carry one', () => {
    const result = recoveryResultFromForkStatus(
      {
        active: true,
        transactionId: 'txn-status',
        strategy: 'shared-worktree',
        state: 'pending',
        since: 123,
        providerIdentity: { status: 'pending' },
      },
      'interrupted',
    )
    expect(result.outcome).toBe('recovery-required')
    expect('retainedSnapshotId' in result).toBe(false)
  })
})

describe('fork isolated disable reason', () => {
  it('stays empty when the strategy may be selected', () => {
    expect(
      forkIsolatedDisabledReason({
        phase: 'preview',
        strategy: 'isolated-worktree',
        atConversationHead: true,
        isolatedCapable: true,
        blockedMessage: '',
      }),
    ).toBe('')
  })

  it('reports a typed reason for an unsupported provider', () => {
    expect(
      forkIsolatedDisabledReason({
        phase: 'preview',
        strategy: 'shared-worktree',
        atConversationHead: true,
        isolatedCapable: false,
        blockedMessage: '',
      }),
    ).toBe('git.fork.unsupportedProviderDisabled')
  })

  it('reports a typed reason for a non-head source turn', () => {
    expect(
      forkIsolatedDisabledReason({
        phase: 'preview',
        strategy: 'shared-worktree',
        atConversationHead: false,
        isolatedCapable: true,
        blockedMessage: '',
      }),
    ).toBe('git.fork.nonHeadDisabled')
  })

  it('prefers the current blocked preview reason for the isolated strategy', () => {
    expect(
      forkIsolatedDisabledReason({
        phase: 'preview-blocked',
        strategy: 'isolated-worktree',
        atConversationHead: true,
        isolatedCapable: true,
        blockedMessage: 'The requested worktree name is not a valid Git branch suffix.',
      }),
    ).toBe('The requested worktree name is not a valid Git branch suffix.')
  })

  it('does not leak a blocked shared preview reason into the isolated row', () => {
    expect(
      forkIsolatedDisabledReason({
        phase: 'preview-blocked',
        strategy: 'shared-worktree',
        atConversationHead: true,
        isolatedCapable: true,
        blockedMessage: 'source is missing',
      }),
    ).toBe('')
  })
})

describe('fork committed child session id', () => {
  it('returns the child session id from a committed result (navigation target)', () => {
    expect(forkCommittedChildSessionId(committedResult())).toBe('child-1')
  })

  it('returns null for blocked and recovery-required outcomes', () => {
    expect(
      forkCommittedChildSessionId({
        outcome: 'blocked',
        transactionId: 'txn-abc',
        code: 'identity-drift',
        reason: 'drift',
      }),
    ).toBeNull()
    expect(
      forkCommittedChildSessionId({
        outcome: 'recovery-required',
        transactionId: 'txn-abc',
        recovery: 'binding-committed',
        reason: 'interrupted',
      }),
    ).toBeNull()
    expect(forkCommittedChildSessionId(null)).toBeNull()
  })
})

describe('fork dialog state machine', () => {
  it('opens into a loading phase with the default strategy', () => {
    const next = reduceForkDialog(initialForkDialogState(), { type: 'open' })
    expect(next.phase).toBe('loading')
    expect(next.strategy).toBe('shared-worktree')
  })

  it('seeds a default isolated name when opened directly into isolated', () => {
    const next = reduceForkDialog(initialForkDialogState(), {
      type: 'open',
      strategy: 'isolated-worktree',
    })
    expect(next.phase).toBe('loading')
    expect(next.strategy).toBe('isolated-worktree')
    expect(next.nameInput).toMatch(/^[0-9a-f]{8}$/)
  })

  it('keeps name keystrokes while the initial preview is loading', () => {
    let state = reduceForkDialog(initialForkDialogState(), {
      type: 'open',
      strategy: 'isolated-worktree',
      initialName: 'initial',
    })

    state = reduceForkDialog(state, { type: 'name-changed', value: 'initial-a' })
    expect(state.phase).toBe('loading')
    expect(state.nameInput).toBe('initial-a')
  })

  it('shows the preview and keeps the server fingerprint for confirm', () => {
    let state = reduceForkDialog(initialForkDialogState(), {
      type: 'open',
      strategy: 'isolated-worktree',
    })
    state = reduceForkDialog(state, { type: 'preview-ready', preview: previewFor() })
    expect(state.phase).toBe('preview')
    expect(state.preview?.previewFingerprint).toBe('f'.repeat(64))

    state = reduceForkDialog(state, { type: 'confirm' })
    expect(state.phase).toBe('confirming')
  })

  it('carries every preview fact the dialog renders (source/destination/capability/policy)', () => {
    const preview = previewFor({
      source: {
        serverId: 'local',
        sessionId: 's1',
        conversationHeadMessageId: 'msg-9',
        conversationHeadTurnId: 'turn-9',
        checkout: { mode: 'current' },
        branch: 'main',
        headSha: 'a'.repeat(40),
        gitState: {
          state: 'dirty',
          stagedFileCount: 1,
          unstagedFileCount: 2,
          untrackedFileCount: 3,
          includedIgnoredFileCount: 1,
        },
        leases: ['owner-a', 'owner-b'],
      },
      destination: {
        serverId: 'local',
        repositoryRoot: '/repo',
        branch: 'kata-agent/ab12cd34',
        checkoutPath: '/srv/worktrees/repo/ab12cd34',
        exists: false,
        leases: [],
      },
      excludedIgnoredPolicy: { includeOnly: true, includeFileCount: 2 },
      currentHead: true,
    })
    let state = reduceForkDialog(initialForkDialogState(), {
      type: 'open',
      strategy: 'isolated-worktree',
    })
    state = reduceForkDialog(state, { type: 'preview-ready', preview })

    // Source block: conversation head, branch, HEAD, Git-state summary, owners.
    expect(state.preview?.source.conversationHeadMessageId).toBe('msg-9')
    expect(state.preview?.source.branch).toBe('main')
    expect(state.preview?.source.headSha).toBe('a'.repeat(40))
    expect(state.preview?.source.gitState.state).toBe('dirty')
    expect(state.preview?.source.gitState.stagedFileCount).toBe(1)
    expect(state.preview?.source.gitState.unstagedFileCount).toBe(2)
    expect(state.preview?.source.gitState.untrackedFileCount).toBe(3)
    expect(state.preview?.source.gitState.includedIgnoredFileCount).toBe(1)
    expect(state.preview?.source.leases).toEqual(['owner-a', 'owner-b'])
    // Destination block: server, branch, checkout path (server-owned, display only).
    expect(state.preview?.destination.serverId).toBe('local')
    expect(state.preview?.destination.branch).toBe('kata-agent/ab12cd34')
    expect(state.preview?.destination.checkoutPath).toBe('/srv/worktrees/repo/ab12cd34')
    // Provider capability + ignored-file policy.
    expect(state.preview?.providerCapability).toEqual({ adapterId: 'pi', strictCrossCwdNativeFork: true })
    expect(state.preview?.excludedIgnoredPolicy).toEqual({ includeOnly: true, includeFileCount: 2 })
    // The previewed branch suffix is what confirm revalidates against.
    expect(state.previewedName).toBe('ab12cd34')
    expect(state.phase).toBe('preview')
  })

  it('surfaces a typed blocker and disables confirm', () => {
    let state = reduceForkDialog(initialForkDialogState(), {
      type: 'open',
      strategy: 'isolated-worktree',
    })
    state = reduceForkDialog(state, {
      type: 'preview-ready',
      preview: previewFor({
        blocked: { blocked: true, code: 'non-head-source', reason: 'Isolated forks are only available at the current conversation head.' },
      }),
    })
    expect(state.phase).toBe('preview-blocked')
    expect(state.message).toBe('Isolated forks are only available at the current conversation head.')
    expect(canConfirmFork(state.phase, state.preview)).toBe(false)
  })

  it('switching strategy re-previews and keeps confirm disabled for the stale preview', () => {
    let state = reduceForkDialog(initialForkDialogState(), { type: 'open' })
    state = reduceForkDialog(state, {
      type: 'preview-ready',
      preview: previewFor({ strategy: 'shared-worktree' }),
    })
    expect(state.phase).toBe('preview')
    expect(canConfirmFork(state.phase, state.preview)).toBe(true)

    state = reduceForkDialog(state, {
      type: 'strategy-changed',
      strategy: 'isolated-worktree',
      nameInput: 'ab12cd34',
    })
    expect(state.phase).toBe('loading')
    expect(state.strategy).toBe('isolated-worktree')
    // The component supplies the exact name it previews so input and previewed
    // branch suffix can never diverge.
    expect(state.nameInput).toBe('ab12cd34')
    // The stale shared preview must not be confirmable during the re-preview.
    expect(canConfirmFork(state.phase, state.preview)).toBe(false)
  })

  it('keeps confirm disabled until an isolated preview matches the edited name', () => {
    let state = reduceForkDialog(initialForkDialogState(), {
      type: 'open',
      strategy: 'isolated-worktree',
    })
    state = reduceForkDialog(state, { type: 'preview-ready', preview: previewFor() })
    // Generated default name does not match the fixed preview branch.
    expect(canConfirmForkForName(state)).toBe(false)
    // Align the input with the previewed branch suffix → confirmable.
    state = reduceForkDialog(state, { type: 'name-changed', value: 'ab12cd34' })
    state = reduceForkDialog(state, { type: 'preview-ready', preview: previewFor() })
    expect(canConfirmForkForName(state)).toBe(true)
    // A name edit re-previews; a stale preview must not be confirmable.
    state = reduceForkDialog(state, { type: 'name-changed', value: 'new-name' })
    state = reduceForkDialog(state, { type: 'preview-ready', preview: previewFor() })
    expect(canConfirmForkForName(state)).toBe(false)
    // The re-preview for the edited name re-enables confirm.
    state = reduceForkDialog(state, {
      type: 'preview-ready',
      preview: previewFor({ destination: { ...previewFor().destination, branch: 'kata-agent/new-name' } }),
    })
    expect(canConfirmForkForName(state)).toBe(true)
  })

  it('treats shared as confirmable without a name', () => {
    let state = reduceForkDialog(initialForkDialogState(), { type: 'open' })
    state = reduceForkDialog(state, {
      type: 'preview-ready',
      preview: previewFor({ strategy: 'shared-worktree' }),
    })
    expect(canConfirmForkForName(state)).toBe(true)
  })

  it('renders the committed summary after a successful confirm', () => {
    const committed: ConversationForkResult = {
      outcome: 'committed',
      transactionId: 'txn-abc',
      summary: {
        sessionId: 'child-1',
        strategy: 'isolated-worktree',
        checkout: {
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
        },
        executionCwd: '/srv/worktrees/repo/ab12cd34',
        transcriptCwd: '/repo/.kata/sessions/s1',
        childProviderIdPresent: false,
        committedAt: 1,
      },
    }
    let state = reduceForkDialog(initialForkDialogState(), {
      type: 'open',
      strategy: 'isolated-worktree',
    })
    state = reduceForkDialog(state, { type: 'preview-ready', preview: previewFor() })
    state = reduceForkDialog(state, { type: 'confirm' })
    state = reduceForkDialog(state, { type: 'confirm-ready', result: committed })
    expect(state.phase).toBe('committed')
    expect(state.result?.outcome).toBe('committed')
    expect(state.message).toBe('')
  })

  it('enters recovery-required on a failed confirm and recovers', () => {
    const recovery: ConversationForkResult = {
      outcome: 'recovery-required',
      transactionId: 'txn-abc',
      recovery: 'binding-committed',
      retainedSnapshotId: 'abcd1234abcd1234',
      reason: 'interrupted before publication',
    }
    let state = reduceForkDialog(initialForkDialogState(), {
      type: 'open',
      strategy: 'isolated-worktree',
    })
    state = reduceForkDialog(state, { type: 'preview-ready', preview: previewFor() })
    state = reduceForkDialog(state, { type: 'confirm' })
    state = reduceForkDialog(state, { type: 'confirm-ready', result: recovery })
    expect(state.phase).toBe('recovery-required')
    expect(state.message).toBe('interrupted before publication')

    state = reduceForkDialog(state, { type: 'recover' })
    expect(state.phase).toBe('recovering')

    const rolledBack: ConversationForkResult = {
      outcome: 'blocked',
      transactionId: 'txn-abc',
      code: 'identity-drift',
      reason: 'The fork preconditions changed; preview again.',
    }
    state = reduceForkDialog(state, { type: 'recover-ready', result: rolledBack })
    expect(state.phase).toBe('blocked')
    expect(state.result?.outcome).toBe('blocked')
  })

  it('opens directly into recovery from a status without preview', () => {
    let state = reduceForkDialog(initialForkDialogState(), { type: 'open' })
    state = reduceForkDialog(state, {
      type: 'recovery-from-status',
      result: {
        outcome: 'recovery-required',
        transactionId: 'txn-status',
        recovery: 'binding-committed',
        retainedSnapshotId: 'abcd1234abcd1234',
        reason: 'interrupted after commit',
      },
    })
    expect(state.phase).toBe('recovery-required')
    expect(state.result?.outcome).toBe('recovery-required')
    expect(canRecoverFork(state.phase, state.result)).toBe(true)
  })

  it('keeps the recovery surface mounted when recover itself fails', () => {
    const recovery: ConversationForkResult = {
      outcome: 'recovery-required',
      transactionId: 'txn-abc',
      recovery: 'target-materialized',
      reason: 'interrupted',
    }
    let state = reduceForkDialog(initialForkDialogState(), {
      type: 'open',
      strategy: 'isolated-worktree',
    })
    state = reduceForkDialog(state, { type: 'preview-ready', preview: previewFor() })
    state = reduceForkDialog(state, { type: 'confirm' })
    state = reduceForkDialog(state, { type: 'confirm-ready', result: recovery })
    state = reduceForkDialog(state, { type: 'recover' })

    state = reduceForkDialog(state, { type: 'recover-error', message: 'IPC unreachable' })
    expect(state.phase).toBe('recovery-required')
    expect(state.message).toBe('IPC unreachable')
    expect(canRecoverFork(state.phase, state.result)).toBe(true)
  })

  it('surfaces preview errors and resets to idle', () => {
    let state = reduceForkDialog(initialForkDialogState(), { type: 'open' })
    state = reduceForkDialog(state, { type: 'preview-error', message: 'server unreachable' })
    expect(state.phase).toBe('error')
    expect(state.message).toBe('server unreachable')

    state = reduceForkDialog(state, { type: 'reset' })
    expect(state).toEqual(initialForkDialogState())
  })

  it('ignores guard-violating actions', () => {
    let state = reduceForkDialog(initialForkDialogState(), { type: 'open' })
    const loadingState = state
    expect(reduceForkDialog(state, { type: 'confirm' })).toBe(loadingState)
    // confirm with a blocked preview.
    state = reduceForkDialog(state, {
      type: 'preview-ready',
      preview: previewFor({
        strategy: 'isolated-worktree',
        blocked: { blocked: true, code: 'unsupported-provider', reason: 'adapter cannot fork' },
      }),
    })
    const blockedState = state
    expect(reduceForkDialog(state, { type: 'confirm' })).toBe(blockedState)
    // name-changed from error.
    state = reduceForkDialog(state, { type: 'preview-error', message: 'server unreachable' })
    expect(reduceForkDialog(state, { type: 'name-changed', value: 'x' })).toBe(state)
    // recover outside recovery-required.
    expect(reduceForkDialog(state, { type: 'recover' })).toBe(state)
    // recovery-from-status with a non-recovery result.
    const committed: ConversationForkResult = {
      outcome: 'committed',
      transactionId: 'txn-abc',
      summary: {
        sessionId: 'child-1',
        strategy: 'isolated-worktree',
        checkout: {
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
        },
        executionCwd: '/srv/worktrees/repo/ab12cd34',
        transcriptCwd: '/repo/.kata/sessions/s1',
        childProviderIdPresent: false,
        committedAt: 1,
      },
    }
    expect(reduceForkDialog(state, { type: 'recovery-from-status', result: committed })).toBe(state)
  })
})
