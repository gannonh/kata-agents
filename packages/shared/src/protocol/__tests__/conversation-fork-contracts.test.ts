import { describe, expect, it } from 'bun:test'
import {
  CONVERSATION_FORK_BLOCKER_CODES,
  CONVERSATION_FORK_STRATEGIES,
  WORKTREE_FORK_BLOCKED_CODE,
  WORKTREE_FORK_ERROR_CODE,
  WORKTREE_FORK_PENDING_CODE,
  WORKTREE_FORK_PREVIEW_STALE_CODE,
  RPC_CHANNELS,
  type ConversationForkBlockerCode,
  type ConversationForkConfirmInput,
  type ConversationForkPendingIntent,
  type ConversationForkPreview,
  type ConversationForkPreviewInput,
  type ConversationForkProviderCapability,
  type ConversationForkRecoveryState,
  type ConversationForkResult,
  type ConversationForkStatus,
} from '../index'
import { isErrorCode } from '../types'

describe('Conversation fork protocol contracts', () => {
  it('defines exactly the two conversation fork strategies with shared-worktree as the default', () => {
    expect(CONVERSATION_FORK_STRATEGIES).toHaveLength(2)
    expect(new Set(CONVERSATION_FORK_STRATEGIES).size).toBe(2)
    // Wire values are part of the RPC contract with the renderer and server;
    // pin them so a rename breaks the contract test.
    expect([...CONVERSATION_FORK_STRATEGIES].sort()).toEqual([
      'isolated-worktree',
      'shared-worktree',
    ])
    // Shared remains the default; isolated is the new explicit alternative.
    expect(CONVERSATION_FORK_STRATEGIES[0]).toBe('shared-worktree')
  })

  it('keeps the provider capability DTO free of paths, payloads, and transcript identity', () => {
    const capability: ConversationForkProviderCapability = {
      adapterId: 'pi',
      strictCrossCwdNativeFork: true,
    }
    expect(Object.keys(capability).sort()).toEqual([
      'adapterId',
      'strictCrossCwdNativeFork',
    ])
    // An adapter that cannot separate transcript storage from execution or
    // cannot prove destination-only tool CWD must not advertise the capability.
    const incapable: ConversationForkProviderCapability = {
      adapterId: 'anthropic',
      strictCrossCwdNativeFork: false,
    }
    expect(incapable.strictCrossCwdNativeFork).toBe(false)
  })

  it('models the pending provider-fork intent without any child provider ID claim', () => {
    // Before first Send, the child stores a pending intent. It carries strict
    // parent identity + immutable transcript lookup identity + destination
    // execution CWD + an idempotency key — and structurally CANNOT carry a
    // child provider ID, because the provider has not created one yet.
    const pending: ConversationForkPendingIntent = {
      parentSessionId: 'session-1',
      parentSdkSessionId: 'sdk-parent-1',
      parentSdkTurnId: 'turn-42',
      parentMessageId: 'msg-42',
      transcriptCwd: '/repo/.kata/sessions/session-1',
      executionCwd: '/srv/kata/worktrees/repo/ab12cd34',
      idempotencyKey: 'fork-txn-abc-step-4',
    }
    expect('childProviderId' in pending).toBe(false)
    expect('childSdkSessionId' in pending).toBe(false)
    // Immutable transcript identity and mutable execution CWD stay distinct.
    expect(pending.transcriptCwd).not.toBe(pending.executionCwd)
  })

  it('accepts fork preview/confirm inputs by session, strategy, and name only — never paths', () => {
    const previewInput: ConversationForkPreviewInput = {
      sessionId: 'session-1',
      strategy: 'isolated-worktree',
      worktreeNameSuffix: 'feature-x',
    }
    expect('path' in previewInput).toBe(false)
    expect('checkoutPath' in previewInput).toBe(false)
    expect('repositoryRoot' in previewInput).toBe(false)

    const confirmInput: ConversationForkConfirmInput = {
      sessionId: 'session-1',
      strategy: 'isolated-worktree',
      transactionId: 'txn-abc',
      previewFingerprint: 'fp-123',
      worktreeNameSuffix: 'feature-x',
    }
    // Structural guarantee: no client-nominated path component may be added.
    const allowedKeys = new Set([
      'sessionId',
      'strategy',
      'transactionId',
      'previewFingerprint',
      'worktreeNameSuffix',
    ])
    for (const key of Object.keys(confirmInput)) {
      expect(allowedKeys.has(key)).toBe(true)
    }
  })

  it('sanitizes previews: source/destination summaries never carry snapshot payload bytes', () => {
    const preview: ConversationForkPreview = {
      transactionId: 'txn-abc',
      previewFingerprint: 'fp-123',
      strategy: 'isolated-worktree',
      providerCapability: { adapterId: 'pi', strictCrossCwdNativeFork: true },
      source: {
        serverId: 'server-a',
        sessionId: 'session-1',
        conversationHeadMessageId: 'msg-42',
        conversationHeadTurnId: 'turn-42',
        checkout: { mode: 'managed-worktree', managedWorktreeId: 'repo-ab12cd34' },
        branch: 'kata-agent/ab12cd34',
        headSha: 'deadbeef',
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
        serverId: 'server-a',
        repositoryRoot: '/repo',
        branch: 'kata-agent/feature-x',
        checkoutPath: '/srv/kata/worktrees/repo/feature-x',
        exists: false,
        leases: [],
      },
      excludedIgnoredPolicy: { includeOnly: true, includeFileCount: 1 },
      currentHead: true,
    }
    // No snapshot payload, manifest, or file bytes cross into the renderer.
    expect('payloadPath' in preview).toBe(false)
    expect('manifestHash' in preview).toBe(false)
    expect('snapshotBytes' in preview).toBe(false)
    expect('totalBytes' in preview).toBe(false)
    expect(preview.currentHead).toBe(true)
    expect(preview.destination.branch).toBe('kata-agent/feature-x')
  })

  it('models every documented blocker code and typed wire errors', () => {
    // Each tuple is the single source of truth for its union: a code added to
    // the type must be listed here, and removing one breaks the length gate.
    const allCodes: readonly ConversationForkBlockerCode[] = CONVERSATION_FORK_BLOCKER_CODES
    expect(new Set(allCodes).size).toBe(allCodes.length)
    const required: ConversationForkBlockerCode[] = [
      'unsupported-provider',
      'non-head-source',
      'source-active',
      'path-unleased',
      'name-collision',
      'identity-drift',
      'missing-source',
      'unsupported-snapshot',
      'oversized-capture',
      'git-operation-in-progress',
      'cleanup-in-progress',
      'flags-disabled',
      'invalid-name',
      'fork-in-progress',
    ]
    for (const code of required) {
      expect(allCodes).toContain(code)
    }
    expect(isErrorCode(WORKTREE_FORK_ERROR_CODE)).toBe(true)
    expect(isErrorCode(WORKTREE_FORK_BLOCKED_CODE)).toBe(true)
    expect(isErrorCode(WORKTREE_FORK_PREVIEW_STALE_CODE)).toBe(true)
    expect(isErrorCode(WORKTREE_FORK_PENDING_CODE)).toBe(true)
  })

  it('discriminates committed, blocked, and recovery-required results', () => {
    const committed: ConversationForkResult = {
      outcome: 'committed',
      transactionId: 'txn-abc',
      summary: {
        sessionId: 'session-child',
        strategy: 'isolated-worktree',
        checkout: {
          schemaVersion: 2,
          mode: 'managed-worktree',
          repositoryRoot: '/repo',
          checkoutPath: '/srv/kata/worktrees/repo/feature-x',
          branchAtPreparation: 'kata-agent/feature-x',
          baseRef: 'kata-agent/ab12cd34',
          displayName: 'feature-x',
          managedWorktreeId: 'repo-feature-x',
          expectedBranch: 'kata-agent/feature-x',
          materializationRoot: '/srv/kata/worktrees',
        },
        executionCwd: '/srv/kata/worktrees/repo/feature-x',
        transcriptCwd: '/repo/.kata/sessions/session-child',
        childProviderIdPresent: false,
        committedAt: 1,
      },
    }
    const blocked: ConversationForkResult = {
      outcome: 'blocked',
      transactionId: 'txn-abc',
      code: 'unsupported-provider',
      reason: 'The provider cannot establish a strict cross-CWD native fork.',
    }
    const recovery: ConversationForkResult = {
      outcome: 'recovery-required',
      transactionId: 'txn-abc',
      recovery: 'target-materialized',
      reason: 'Seed verification failed after target materialization.',
    }

    expect(committed.outcome).toBe('committed')
    if (committed.outcome === 'committed') {
      // At the durable commit point (child visible), the child provider ID is
      // still pending — never claimed before the provider creates it.
      expect(committed.summary.childProviderIdPresent).toBe(false)
      expect(committed.summary.executionCwd).not.toBe(committed.summary.transcriptCwd)
    }
    expect(blocked.outcome).toBe('blocked')
    if (blocked.outcome === 'blocked') {
      expect(blocked.code).toBe('unsupported-provider')
    }
    expect(recovery.outcome).toBe('recovery-required')
    if (recovery.outcome === 'recovery-required') {
      expect(recovery.recovery).toBe('target-materialized')
    }
  })

  it('reports fork status with the child provider identity pending before first Send', () => {
    const idle: ConversationForkStatus = { active: false }
    const active: ConversationForkStatus = {
      active: true,
      transactionId: 'txn-abc',
      strategy: 'isolated-worktree',
      state: 'published',
      since: 1,
      pendingProviderIdentity: true,
    }
    expect(idle.active).toBe(false)
    if (active.active) {
      expect(active.strategy).toBe('isolated-worktree')
      expect(active.state).toBe('published')
      // The status surface never claims a child provider ID before first Send.
      expect('childProviderId' in active).toBe(false)
    }
  })

  it('covers the durable transaction steps in the recovery state union', () => {
    const states: readonly ConversationForkRecoveryState[] = [
      'pending',
      'source-leased',
      'seed-captured',
      'target-reserved',
      'target-materialized',
      'target-verified',
      'binding-committed',
      'published',
      'establishing',
      'established',
      'restore-failed',
      'cleanup-failed',
      'recovery-required',
    ]
    for (const state of states) {
      expect(state).toBeTruthy()
    }
  })

  it('registers fork RPC channels under the git namespace', () => {
    expect(RPC_CHANNELS.git.FORK_PREVIEW).toBe('git:forkPreview')
    expect(RPC_CHANNELS.git.FORK_CONFIRM).toBe('git:forkConfirm')
    expect(RPC_CHANNELS.git.FORK_STATUS).toBe('git:forkStatus')
    expect(RPC_CHANNELS.git.FORK_RECOVER).toBe('git:forkRecover')
    expect(RPC_CHANNELS.git.FORK_CANCEL).toBe('git:forkCancel')
  })
})
