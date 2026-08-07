import { describe, expect, it } from 'bun:test'
import {
  WORKTREE_HANDOFF_BLOCKER_CODES,
  WORKTREE_HANDOFF_BLOCKED_CODE,
  WORKTREE_HANDOFF_DIRECTIONS,
  WORKTREE_HANDOFF_ERROR_CODE,
  WORKTREE_HANDOFF_PENDING_CODE,
  WORKTREE_HANDOFF_PREVIEW_STALE_CODE,
  RPC_CHANNELS,
  type WorktreeHandoffBlockerCode,
  type WorktreeHandoffConfirmInput,
  type WorktreeHandoffPreview,
  type WorktreeHandoffProviderCapability,
  type WorktreeHandoffResult,
  type WorktreeHandoffStatus,
} from '../index'
import { isErrorCode } from '../types'

describe('Worktree handoff protocol contracts', () => {
  it('defines exactly the three supported handoff directions', () => {
    expect(WORKTREE_HANDOFF_DIRECTIONS).toHaveLength(3)
    expect(new Set(WORKTREE_HANDOFF_DIRECTIONS).size).toBe(3)
  })

  it('keeps the provider capability DTO free of paths, payloads, and secrets', () => {
    const capability: WorktreeHandoffProviderCapability = {
      adapterId: 'pi',
      executionCwdRebindable: true,
    }
    expect(Object.keys(capability).sort()).toEqual(['adapterId', 'executionCwdRebindable'])
    // An adapter that cannot separate transcript storage from execution must
    // not advertise the capability; that state is representable.
    const incapable: WorktreeHandoffProviderCapability = {
      adapterId: 'anthropic',
      executionCwdRebindable: false,
    }
    expect(incapable.executionCwdRebindable).toBe(false)
  })

  it('accepts confirmation by transaction ID and preview fingerprint only — never paths or patches', () => {
    const input: WorktreeHandoffConfirmInput = {
      sessionId: 'session-1',
      direction: 'current-to-managed',
      transactionId: 'txn-abc',
      previewFingerprint: 'fp-123',
    }
    expect('path' in input).toBe(false)
    expect('patch' in input).toBe(false)
    expect('repositoryRoot' in input).toBe(false)
    expect('checkoutPath' in input).toBe(false)
    // Structural guarantee: no client-nominated path component may be added.
    const allowedKeys = new Set(['sessionId', 'direction', 'transactionId', 'previewFingerprint'])
    for (const key of Object.keys(input)) {
      expect(allowedKeys.has(key)).toBe(true)
    }
  })

  it('sanitizes previews: source/destination summaries never carry snapshot payload bytes', () => {
    const preview: WorktreeHandoffPreview = {
      transactionId: 'txn-abc',
      previewFingerprint: 'fp-123',
      direction: 'managed-to-current',
      providerCapability: { adapterId: 'pi', executionCwdRebindable: true },
      source: {
        serverId: 'server-a',
        branch: 'kata-agent/ab12cd34',
        headSha: 'deadbeef',
        state: 'clean',
        checkoutPath: '/srv/kata/worktrees/repo/ab12cd34',
        leases: [],
      },
      destination: {
        serverId: 'server-a',
        repositoryRoot: '/repo',
        branch: 'main',
        checkoutPath: '/repo',
        exists: true,
        leases: ['session-other'],
      },
      includeCopyConflicts: [{ path: '.env' }],
      excludedIgnoredPolicy: { includeOnly: true, includeFileCount: 2 },
      cleanup: {
        trackedFileCount: 1,
        stagedFileCount: 0,
        eligibleUntrackedFileCount: 3,
        includedIgnoredFileCount: 2,
      },
      returnRef: { branch: 'main', headSha: 'deadbeef' },
      recoveryBehavior: 'source-authoritative',
    }
    // No snapshot payload, manifest, or file bytes cross into the renderer.
    expect('payloadPath' in preview).toBe(false)
    expect('manifestHash' in preview).toBe(false)
    expect('fileCount' in preview).toBe(false)
    expect('totalBytes' in preview).toBe(false)
    expect(preview.recoveryBehavior).toBe('source-authoritative')
    expect(preview.returnRef).toEqual({ branch: 'main', headSha: 'deadbeef' })
  })

  it('models every documented blocker code and typed wire errors', () => {
    // The tuple is the single source of truth for the union: a code added to
    // the type must be listed here, and removing one breaks the length gate.
    const allCodes: readonly WorktreeHandoffBlockerCode[] = WORKTREE_HANDOFF_BLOCKER_CODES
    expect(allCodes).toHaveLength(16)
    expect(new Set(allCodes).size).toBe(16)
    expect(isErrorCode(WORKTREE_HANDOFF_ERROR_CODE)).toBe(true)
    expect(isErrorCode(WORKTREE_HANDOFF_BLOCKED_CODE)).toBe(true)
    expect(isErrorCode(WORKTREE_HANDOFF_PREVIEW_STALE_CODE)).toBe(true)
    expect(isErrorCode(WORKTREE_HANDOFF_PENDING_CODE)).toBe(true)
  })

  it('discriminates committed, blocked, and recovery-required results', () => {
    const committed: WorktreeHandoffResult = {
      outcome: 'committed',
      transactionId: 'txn-abc',
      summary: {
        sessionId: 'session-1',
        direction: 'current-to-managed',
        checkout: {
          schemaVersion: 2,
          mode: 'managed-worktree',
          repositoryRoot: '/repo',
          checkoutPath: '/srv/kata/worktrees/repo/ab12cd34',
          branchAtPreparation: 'kata-agent/ab12cd34',
          baseRef: 'main',
          displayName: 'ab12cd34',
          managedWorktreeId: 'repo-ab12cd34',
          expectedBranch: 'kata-agent/ab12cd34',
          materializationRoot: '/srv/kata/worktrees',
        },
        executionCwd: '/srv/kata/worktrees/repo/ab12cd34',
        transcriptCwd: '/repo/.kata/sessions/session-1',
        retainedSnapshotId: 'snap-1',
        committedAt: 1,
      },
    }
    const blocked: WorktreeHandoffResult = {
      outcome: 'blocked',
      transactionId: 'txn-abc',
      code: 'another-path-user',
      reason: 'Another session leases the destination checkout.',
    }
    const recovery: WorktreeHandoffResult = {
      outcome: 'recovery-required',
      transactionId: 'txn-abc',
      recovery: 'source-released',
      retainedSnapshotId: 'snap-1',
      reason: 'Branch checkout in current failed after source release.',
    }

    expect(committed.outcome).toBe('committed')
    if (committed.outcome === 'committed') {
      expect(committed.summary.transcriptCwd).toBe('/repo/.kata/sessions/session-1')
      expect(committed.summary.executionCwd).not.toBe(committed.summary.transcriptCwd)
    }
    expect(blocked.outcome).toBe('blocked')
    if (blocked.outcome === 'blocked') {
      expect(blocked.code).toBe('another-path-user')
    }
    expect(recovery.outcome).toBe('recovery-required')
    if (recovery.outcome === 'recovery-required') {
      expect(recovery.recovery).toBe('source-released')
    }
  })

  it('reports handoff status with an active transaction or none', () => {
    const idle: WorktreeHandoffStatus = { active: false }
    const active: WorktreeHandoffStatus = {
      active: true,
      transactionId: 'txn-abc',
      direction: 'hand-back',
      state: 'source-released',
      retainedSnapshotId: 'snap-1',
      since: 1,
    }
    expect(idle.active).toBe(false)
    if (active.active) {
      expect(active.direction).toBe('hand-back')
      expect(active.state).toBe('source-released')
    }
    expect(active.active).toBe(true)
  })

  it('registers handoff RPC channels under the git namespace', () => {
    expect(RPC_CHANNELS.git.HANDOFF_PREVIEW).toBe('git:handoffPreview')
    expect(RPC_CHANNELS.git.HANDOFF_CONFIRM).toBe('git:handoffConfirm')
    expect(RPC_CHANNELS.git.HANDOFF_STATUS).toBe('git:handoffStatus')
    expect(RPC_CHANNELS.git.HANDOFF_RECOVER).toBe('git:handoffRecover')
  })
})
