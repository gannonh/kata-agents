import { describe, expect, it } from 'bun:test'
import {
  WORKTREE_V2_CAPABILITY_ERROR_CODE,
  WorktreeV2CapabilityError,
  type CheckoutPrepareIntent,
  type CheckoutPrepareIntentV2,
  type CheckoutPrepareIntentVersioned,
  type CheckoutPrepareResultVersioned,
  type ManagedWorktreeRecord,
  type ManagedWorktreeRecordV2,
  type ManagedWorktreeSummaryV2,
  type ManagedWorktreeSummaryVersioned,
  type ServerCapabilityDto,
  type SessionCheckout,
  type SessionCheckoutV1,
  type SessionCheckoutV2,
  type WorktreeSettingsSnapshot,
} from '../git'
import { isErrorCode } from '../types'

describe('Git Worktree V2 protocol contracts', () => {
  it('keeps V1 checkout intents and records free of fabricated V2 values', () => {
    const intent: CheckoutPrepareIntent = {
      mode: 'managed-worktree',
      workingDirectory: '/repo',
      baseRef: 'main',
    }
    const checkout: SessionCheckoutV1 = {
      schemaVersion: 1,
      mode: 'managed-worktree',
      repositoryRoot: '/repo',
      checkoutPath: '/worktrees/repo/abcd1234',
      branchAtPreparation: 'kata-agent/abcd1234',
      baseRef: 'main',
      managedWorktreeId: 'repo-abcd1234',
      expectedBranch: 'kata-agent/abcd1234',
    }
    const record: ManagedWorktreeRecord = {
      managedWorktreeId: 'repo-abcd1234',
      workspaceId: 'workspace',
      repositoryRoot: '/repo',
      gitCommonDir: '/repo/.git',
      checkoutPath: checkout.checkoutPath,
      baseRef: 'main',
      expectedBranch: 'kata-agent/abcd1234',
      createdAt: 1,
      ownerSessionIds: ['session'],
      state: 'ready',
    }

    expect(intent.worktreeNameSuffix).toBeUndefined()
    expect('worktreeNameSuffix' in intent).toBe(false)
    expect('displayName' in checkout).toBe(false)
    expect('materializationRoot' in checkout).toBe(false)
    expect('displayName' in record).toBe(false)
    expect('materializationRoot' in record).toBe(false)
  })

  it('models a named V2 preparation and returned identity metadata', () => {
    const intent: CheckoutPrepareIntentV2 = {
      schemaVersion: 2,
      mode: 'managed-worktree',
      workingDirectory: '/repo',
      baseRef: 'main',
      worktreeNameSuffix: 'team/auth-refresh',
    }
    const checkout: SessionCheckoutV2 = {
      schemaVersion: 2,
      mode: 'managed-worktree',
      repositoryRoot: '/repo',
      checkoutPath: '/worktrees/repo/team-auth-refresh-4b6f2a1c',
      branchAtPreparation: 'kata-agent/team/auth-refresh',
      baseRef: 'main',
      managedWorktreeId: 'repo-4b6f2a1c',
      displayName: 'team/auth-refresh',
      expectedBranch: 'kata-agent/team/auth-refresh',
      materializationRoot: '/worktrees',
    }
    const record: ManagedWorktreeRecordV2 = {
      managedWorktreeId: checkout.managedWorktreeId!,
      schemaVersion: 2,
      workspaceId: 'workspace',
      repositoryRoot: checkout.repositoryRoot,
      gitCommonDir: '/repo/.git',
      checkoutPath: checkout.checkoutPath,
      baseRef: checkout.baseRef,
      displayName: checkout.displayName,
      expectedBranch: checkout.expectedBranch,
      materializationRoot: checkout.materializationRoot,
      createdAt: 1,
      lastUsedAt: 1,
      ownerSessionIds: ['session'],
      state: 'ready',
    }
    const summary: ManagedWorktreeSummaryV2 = {
      schemaVersion: 2,
      managedWorktreeId: record.managedWorktreeId,
      checkoutPath: record.checkoutPath,
      displayName: record.displayName,
      expectedBranch: record.expectedBranch,
      materializationRoot: record.materializationRoot,
      baseRef: record.baseRef,
      ownerCount: 1,
      state: 'ready',
    }
    const versionedIntent: CheckoutPrepareIntentVersioned = intent
    const versionedCheckout: SessionCheckout = checkout
    const versionedResult: CheckoutPrepareResultVersioned = {
      checkout,
      workingDirectory: checkout.checkoutPath,
      sdkCwd: checkout.checkoutPath,
    }
    const versionedSummary: ManagedWorktreeSummaryVersioned = summary

    expect(versionedIntent).toBe(intent)
    expect(versionedCheckout.schemaVersion).toBe(2)
    expect(versionedResult.checkout.displayName).toBe('team/auth-refresh')
    expect(versionedSummary).toBe(summary)
    expect(intent.worktreeNameSuffix).toBe('team/auth-refresh')
    expect(checkout.displayName).toBe('team/auth-refresh')
    expect(checkout.expectedBranch).toBe('kata-agent/team/auth-refresh')
    expect(summary.materializationRoot).toBe('/worktrees')
  })

  it('represents an immutable per-server root settings snapshot', () => {
    const snapshot: WorktreeSettingsSnapshot = {
      schemaVersion: 1,
      serverId: 'server-a',
      version: 3,
      materializationRoot: '/srv/kata/worktrees',
      capturedAt: 123,
      autoDeleteEnabled: true,
      retentionLimit: 15,
    }

    expect(snapshot.serverId).toBe('server-a')
    expect(snapshot.version).toBe(3)
    expect(snapshot.materializationRoot).toBe('/srv/kata/worktrees')
    expect(snapshot.autoDeleteEnabled).toBe(true)
    expect(snapshot.retentionLimit).toBe(15)
  })

  it('exposes a typed server capability and typed V2-unavailable error', () => {
    const capability: ServerCapabilityDto = {
      serverId: 'server-a',
      worktreeV2: true,
    }
    const error = new WorktreeV2CapabilityError()

    expect(capability).toEqual({ serverId: 'server-a', worktreeV2: true })
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe(WORKTREE_V2_CAPABILITY_ERROR_CODE)
    expect(isErrorCode(error.code)).toBe(true)
  })
})
