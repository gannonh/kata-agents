/**
 * Pure-helper coverage for the composer Workspace checkout controls.
 *
 * These helpers back the prepare-before-send gate (AC4), the resume/restart
 * identity (AC5), and the Shared worktree label (AC8) so the interactive
 * `WorkspaceCheckoutBadge` and the FreeFormInput submit path can't quietly
 * diverge from the spec.
 */

import { describe, test, expect } from 'bun:test'
import type { SessionCheckoutV1 } from '@kata-sh/shared/protocol'
import { resolveSendGate, resolveCheckoutIdentity } from '../checkout-controls'

const worktreeCheckout: SessionCheckoutV1 = {
  schemaVersion: 1,
  mode: 'managed-worktree',
  repositoryRoot: '/repo',
  checkoutPath: '/wt/kata-agent-aabbccdd',
  branchAtPreparation: 'kata-agent/aabbccdd',
  baseRef: 'main',
  managedWorktreeId: 'repo-aabbccdd',
  expectedBranch: 'kata-agent/aabbccdd',
}

const currentCheckout: SessionCheckoutV1 = {
  schemaVersion: 1,
  mode: 'current',
  repositoryRoot: '/repo',
  checkoutPath: '/repo',
  branchAtPreparation: 'main',
  baseRef: null,
  managedWorktreeId: null,
  expectedBranch: null,
}

// ---------------------------------------------------------------------------
// resolveSendGate (AC4)
// ---------------------------------------------------------------------------

describe('resolveSendGate', () => {
  test('sends directly when the mode is Current checkout', () => {
    const decision = resolveSendGate({
      mode: 'current',
      baseRef: null,
      workingDirectory: '/repo',
      prepared: false,
      hasPersistedCheckout: false,
      isGitRepository: true,
    })
    expect(decision.action).toBe('send')
  })

  test('prepares before sending when New worktree is selected but not yet prepared', () => {
    const decision = resolveSendGate({
      mode: 'managed-worktree',
      baseRef: 'main',
      workingDirectory: '/repo',
      prepared: false,
      hasPersistedCheckout: false,
      isGitRepository: true,
    })
    expect(decision).toEqual({
      action: 'prepare',
      intent: { mode: 'managed-worktree', workingDirectory: '/repo', baseRef: 'main' },
    })
  })

  test('blocks send when New worktree is selected without a base ref', () => {
    const decision = resolveSendGate({
      mode: 'managed-worktree',
      baseRef: null,
      workingDirectory: '/repo',
      prepared: false,
      hasPersistedCheckout: false,
      isGitRepository: true,
    })
    expect(decision).toEqual({ action: 'block', reason: 'missing-base-ref' })
  })

  test('sends directly once a worktree has already been prepared', () => {
    const decision = resolveSendGate({
      mode: 'managed-worktree',
      baseRef: 'main',
      workingDirectory: '/wt/kata',
      prepared: true,
      hasPersistedCheckout: false,
      isGitRepository: true,
    })
    expect(decision.action).toBe('send')
  })

  test('sends directly when the session already has a persisted checkout (resumed)', () => {
    const decision = resolveSendGate({
      mode: 'managed-worktree',
      baseRef: 'main',
      workingDirectory: '/wt/kata',
      prepared: false,
      hasPersistedCheckout: true,
      isGitRepository: true,
    })
    expect(decision.action).toBe('send')
  })

  test('sends directly for non-Git directories', () => {
    const decision = resolveSendGate({
      mode: 'managed-worktree',
      baseRef: null,
      workingDirectory: '/plain',
      prepared: false,
      hasPersistedCheckout: false,
      isGitRepository: false,
    })
    expect(decision.action).toBe('send')
  })
})

// ---------------------------------------------------------------------------
// resolveCheckoutIdentity (AC5 + AC8)
// ---------------------------------------------------------------------------

describe('resolveCheckoutIdentity', () => {
  test('shows the interactive menu for an empty Git session with no checkout', () => {
    const id = resolveCheckoutIdentity({
      isGitRepository: true,
      isEmptySession: true,
      hasSessionId: true,
      persistedCheckout: null,
      locallyPrepared: null,
      sharedOwnerCount: undefined,
    })
    expect(id.kind).toBe('menu')
  })

  test('locks to the worktree identity from a persisted managed-worktree checkout (resume)', () => {
    const id = resolveCheckoutIdentity({
      isGitRepository: true,
      isEmptySession: true,
      hasSessionId: true,
      persistedCheckout: worktreeCheckout,
      locallyPrepared: null,
      sharedOwnerCount: 1,
    })
    expect(id.kind).toBe('worktree')
    expect(id.branch).toBe('kata-agent/aabbccdd')
  })

  test('does NOT reset to Current when a managed-worktree checkout already exists', () => {
    const id = resolveCheckoutIdentity({
      isGitRepository: true,
      isEmptySession: true,
      hasSessionId: true,
      persistedCheckout: worktreeCheckout,
      locallyPrepared: null,
      sharedOwnerCount: undefined,
    })
    expect(id.kind).not.toBe('current')
    expect(id.kind).not.toBe('menu')
  })

  test('shows Shared worktree when the owner count exceeds one (AC8)', () => {
    const id = resolveCheckoutIdentity({
      isGitRepository: true,
      isEmptySession: false,
      hasSessionId: true,
      persistedCheckout: worktreeCheckout,
      locallyPrepared: null,
      sharedOwnerCount: 2,
    })
    expect(id.kind).toBe('shared-worktree')
    expect(id.branch).toBe('kata-agent/aabbccdd')
  })

  test('locks to Current checkout identity from a persisted current checkout', () => {
    const id = resolveCheckoutIdentity({
      isGitRepository: true,
      isEmptySession: true,
      hasSessionId: true,
      persistedCheckout: currentCheckout,
      locallyPrepared: null,
      sharedOwnerCount: undefined,
    })
    expect(id.kind).toBe('current')
  })

  test('locks to the freshly-prepared worktree even before persistence propagates', () => {
    const id = resolveCheckoutIdentity({
      isGitRepository: true,
      isEmptySession: true,
      hasSessionId: true,
      persistedCheckout: null,
      locallyPrepared: worktreeCheckout,
      sharedOwnerCount: undefined,
    })
    expect(id.kind).toBe('worktree')
  })

  test('renders nothing for non-Git directories', () => {
    const id = resolveCheckoutIdentity({
      isGitRepository: false,
      isEmptySession: true,
      hasSessionId: true,
      persistedCheckout: null,
      locallyPrepared: null,
      sharedOwnerCount: undefined,
    })
    expect(id.kind).toBe('none')
  })
})
