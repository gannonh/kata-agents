/**
 * Pure-helper coverage for the composer Workspace checkout controls.
 *
 * These helpers back the prepare-before-send gate (AC4), the resume/restart
 * identity (AC5), and the Shared worktree label (AC8) so the interactive
 * `WorkspaceCheckoutBadge` and the FreeFormInput submit path can't quietly
 * diverge from the spec.
 */

import { describe, test, expect } from 'bun:test'
import type { SessionCheckoutV1, SessionCheckoutV2 } from '@kata-sh/shared/protocol'
import {
  resolveSendGate,
  resolveCheckoutIdentity,
  generateDefaultWorktreeName,
  normalizeWorktreeName,
  normalizeWorktreeNameInput,
  resolveCheckoutRecovery,
  resolveLiveBranchLabel,
} from '../checkout-controls'

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

const namedWorktreeCheckout: SessionCheckoutV2 = {
  schemaVersion: 2,
  mode: 'managed-worktree',
  repositoryRoot: '/repo',
  checkoutPath: '/wt/auth-refresh-aabbccdd',
  branchAtPreparation: 'kata-agent/auth-refresh',
  baseRef: 'main',
  managedWorktreeId: 'repo-aabbccdd',
  displayName: 'auth-refresh',
  expectedBranch: 'kata-agent/auth-refresh',
  materializationRoot: '/worktrees',
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
// Worktree name normalization
// ---------------------------------------------------------------------------

describe('normalizeWorktreeName', () => {
  test('converts human-readable names to lowercase kebab-case', () => {
    expect(normalizeWorktreeNameInput('My New Feature')).toBe('my-new-feature')
    expect(normalizeWorktreeName('My New Feature')).toBe('my-new-feature')
  })

  test('preserves nested refs while normalizing each name segment', () => {
    expect(normalizeWorktreeName(' Team / Auth_Refresh ')).toBe('team/auth-refresh')
  })

  test('strips Git-forbidden ref characters instead of passing them through', () => {
    expect(normalizeWorktreeName('feat:auth')).toBe('feat-auth')
    expect(normalizeWorktreeName('a..b')).toBe('a.b')
    expect(normalizeWorktreeName('x@{y')).toBe('x-y')
    expect(normalizeWorktreeName('bad~name^v1')).toBe('bad-name-v1')
    expect(normalizeWorktreeName('q?[*]\\r')).toBe('q-r')
    expect(normalizeWorktreeName('..edge.')).toBe('edge')
  })
})

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

  test('prepares an explicit V2 named intent when the server capability is effective', () => {
    const decision = resolveSendGate({
      mode: 'managed-worktree',
      baseRef: 'main',
      worktreeV2Enabled: true,
      worktreeNameSuffix: 'Auth Refresh',
      workingDirectory: '/repo',
      prepared: false,
      hasPersistedCheckout: false,
      isGitRepository: true,
    })
    expect(decision).toEqual({
      action: 'prepare',
      intent: {
        schemaVersion: 2,
        mode: 'managed-worktree',
        workingDirectory: '/repo',
        baseRef: 'main',
        worktreeNameSuffix: 'auth-refresh',
      },
    })
  })

  test('blocks a V2 new-worktree send without a name', () => {
    const decision = resolveSendGate({
      mode: 'managed-worktree',
      baseRef: 'main',
      worktreeV2Enabled: true,
      worktreeNameSuffix: '   ',
      workingDirectory: '/repo',
      prepared: false,
      hasPersistedCheckout: false,
      isGitRepository: true,
    })
    expect(decision).toEqual({ action: 'block', reason: 'missing-worktree-name' })
  })

  test('keeps the V1 intent shape when the selected server is not V2-capable', () => {
    const decision = resolveSendGate({
      mode: 'managed-worktree',
      baseRef: 'main',
      worktreeV2Enabled: false,
      worktreeNameSuffix: 'auth-refresh',
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

  test('waits while the owning server capability is unresolved before preparing a new worktree', () => {
    // A V1 intent persisted during capability discovery would lock the session
    // to a generated branch that a V2-capable server cannot upgrade later.
    const decision = resolveSendGate({
      mode: 'managed-worktree',
      baseRef: 'main',
      worktreeV2Pending: true,
      workingDirectory: '/repo',
      prepared: false,
      hasPersistedCheckout: false,
      isGitRepository: true,
    })
    expect(decision).toEqual({ action: 'wait' })
  })

  test('does not wait on capability discovery when binding an existing worktree', () => {
    const decision = resolveSendGate({
      mode: 'managed-worktree',
      baseRef: null,
      managedWorktreeId: 'repo-aabbccdd',
      worktreeIntent: 'existing',
      worktreeV2Pending: true,
      workingDirectory: '/repo',
      prepared: false,
      hasPersistedCheckout: false,
      isGitRepository: true,
    })
    expect(decision).toEqual({
      action: 'prepare',
      intent: {
        mode: 'managed-worktree',
        workingDirectory: '/repo',
        managedWorktreeId: 'repo-aabbccdd',
      },
    })
  })

  test('prepares the V1 intent once capability resolution reports a V1-only server', () => {
    const decision = resolveSendGate({
      mode: 'managed-worktree',
      baseRef: 'main',
      worktreeV2Pending: false,
      worktreeV2Enabled: false,
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

  test('prepares by binding when an existing worktree is selected (no base ref needed)', () => {
    const decision = resolveSendGate({
      mode: 'managed-worktree',
      baseRef: null,
      managedWorktreeId: 'repo-aabbccdd',
      worktreeIntent: 'existing',
      workingDirectory: '/repo',
      prepared: false,
      hasPersistedCheckout: false,
      isGitRepository: true,
    })
    expect(decision).toEqual({
      action: 'prepare',
      intent: {
        mode: 'managed-worktree',
        workingDirectory: '/repo',
        managedWorktreeId: 'repo-aabbccdd',
      },
    })
  })

  test('blocks an Existing intent without a selection even when a base ref is present', () => {
    // The badge retains the Git-context base ref; without an explicit
    // New-vs-Existing intent this would fall through to New-worktree
    // preparation and create a worktree the user never chose.
    const decision = resolveSendGate({
      mode: 'managed-worktree',
      baseRef: 'main',
      managedWorktreeId: null,
      worktreeIntent: 'existing',
      workingDirectory: '/repo',
      prepared: false,
      hasPersistedCheckout: false,
      isGitRepository: true,
    })
    expect(decision).toEqual({ action: 'block', reason: 'missing-existing-selection' })
  })

  test('blocks send when Existing worktree is selected but none is chosen yet', () => {
    const decision = resolveSendGate({
      mode: 'managed-worktree',
      baseRef: null,
      managedWorktreeId: null,
      worktreeIntent: 'existing',
      workingDirectory: '/repo',
      prepared: false,
      hasPersistedCheckout: false,
      isGitRepository: true,
    })
    expect(decision).toEqual({ action: 'block', reason: 'missing-existing-selection' })
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

  test('waits for Git context before sending an unprepared worktree intent', () => {
    const decision = resolveSendGate({
      mode: 'managed-worktree',
      baseRef: 'main',
      workingDirectory: '/repo',
      prepared: false,
      hasPersistedCheckout: false,
      isGitRepository: false,
      gitContextResolved: false,
    })
    expect(decision).toEqual({ action: 'wait' })
  })

  test('sends directly for a confirmed non-Git directory', () => {
    const decision = resolveSendGate({
      mode: 'managed-worktree',
      baseRef: null,
      workingDirectory: '/plain',
      prepared: false,
      hasPersistedCheckout: false,
      isGitRepository: false,
      gitContextResolved: true,
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

  test('generates an editable lowercase eight-hex default name', () => {
    expect(generateDefaultWorktreeName()).toMatch(/^[0-9a-f]{8}$/)
  })

  test('uses the V2 display name while retaining the exact branch identity', () => {
    const id = resolveCheckoutIdentity({
      isGitRepository: true,
      isEmptySession: false,
      hasSessionId: true,
      persistedCheckout: namedWorktreeCheckout,
      locallyPrepared: null,
      sharedOwnerCount: 1,
    })
    expect(id.kind).toBe('worktree')
    expect(id.displayName).toBe('auth-refresh')
    expect(id.branch).toBe('kata-agent/auth-refresh')
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

// ---------------------------------------------------------------------------
// resolveCheckoutRecovery (AC20 — recovery / blocked states)
// ---------------------------------------------------------------------------

describe('resolveCheckoutRecovery', () => {
  test('is ok for a current checkout (recovery only applies to managed worktrees)', () => {
    const r = resolveCheckoutRecovery({
      checkout: currentCheckout,
      contextLoaded: true,
      liveBranch: 'feature',
      liveDetached: false,
      checkoutExists: true,
    })
    expect(r.kind).toBe('ok')
  })

  test('is ok when there is no persisted checkout', () => {
    const r = resolveCheckoutRecovery({
      checkout: null,
      contextLoaded: true,
      liveBranch: null,
      liveDetached: false,
      checkoutExists: false,
    })
    expect(r.kind).toBe('ok')
  })

  test('stays ok while repository context is still loading (avoid false drift on resume)', () => {
    const r = resolveCheckoutRecovery({
      checkout: worktreeCheckout,
      contextLoaded: false,
      liveBranch: null,
      liveDetached: false,
      checkoutExists: true,
    })
    expect(r.kind).toBe('ok')
  })

  test('is ok when the live branch matches the expected branch', () => {
    const r = resolveCheckoutRecovery({
      checkout: worktreeCheckout,
      contextLoaded: true,
      liveBranch: 'kata-agent/aabbccdd',
      liveDetached: false,
      checkoutExists: true,
    })
    expect(r.kind).toBe('ok')
  })

  test('reports missing when the checkout no longer resolves to a Git repository', () => {
    const r = resolveCheckoutRecovery({
      checkout: worktreeCheckout,
      contextLoaded: true,
      liveBranch: null,
      liveDetached: false,
      checkoutExists: false,
    })
    expect(r.kind).toBe('missing')
  })

  test('reports missing when the registry marks the worktree missing', () => {
    const r = resolveCheckoutRecovery({
      checkout: worktreeCheckout,
      contextLoaded: true,
      liveBranch: 'kata-agent/aabbccdd',
      liveDetached: false,
      checkoutExists: true,
      worktreeStatus: 'missing',
    })
    expect(r.kind).toBe('missing')
  })

  test('reports branch-drift when the worktree was externally switched to another branch', () => {
    const r = resolveCheckoutRecovery({
      checkout: worktreeCheckout,
      contextLoaded: true,
      liveBranch: 'main',
      liveDetached: false,
      checkoutExists: true,
    })
    expect(r).toEqual({ kind: 'branch-drift', expected: 'kata-agent/aabbccdd', found: 'main' })
  })

  test('reports branch-drift when the worktree HEAD was externally detached', () => {
    const r = resolveCheckoutRecovery({
      checkout: worktreeCheckout,
      contextLoaded: true,
      liveBranch: null,
      liveDetached: true,
      checkoutExists: true,
    })
    expect(r).toEqual({ kind: 'branch-drift', expected: 'kata-agent/aabbccdd', found: null })
  })

  test('reports blocked when the registry marks the worktree blocked', () => {
    const r = resolveCheckoutRecovery({
      checkout: worktreeCheckout,
      contextLoaded: true,
      liveBranch: 'kata-agent/aabbccdd',
      liveDetached: false,
      checkoutExists: true,
      worktreeStatus: 'blocked',
    })
    expect(r.kind).toBe('blocked')
  })

  test('prioritizes missing over branch-drift when both would apply', () => {
    const r = resolveCheckoutRecovery({
      checkout: worktreeCheckout,
      contextLoaded: true,
      liveBranch: 'main',
      liveDetached: false,
      checkoutExists: false,
    })
    expect(r.kind).toBe('missing')
  })
})

// ---------------------------------------------------------------------------
// resolveLiveBranchLabel (badge label precedence)
// ---------------------------------------------------------------------------

describe('resolveLiveBranchLabel', () => {
  const labels = { detached: 'Detached HEAD', currentCheckout: 'Current checkout' }

  test('reports the detached label when HEAD is detached', () => {
    const label = resolveLiveBranchLabel(
      { detached: true, currentBranch: null, defaultRef: 'main', identityBranch: 'feature/x' },
      labels,
    )
    expect(label).toBe('Detached HEAD')
  })

  test('prefers the live current branch over a persisted identity branch', () => {
    const label = resolveLiveBranchLabel(
      { detached: false, currentBranch: 'main', defaultRef: 'main', identityBranch: 'feature/x' },
      labels,
    )
    expect(label).toBe('main')
  })

  test('prefers the default ref over a persisted identity branch when the branch is unknown', () => {
    const label = resolveLiveBranchLabel(
      { detached: false, currentBranch: null, defaultRef: 'develop', identityBranch: 'feature/x' },
      labels,
    )
    expect(label).toBe('develop')
  })

  test('shows the persisted identity branch while live context is not ready', () => {
    // A resumed Current checkout carries branchAtPreparation. While the live
    // lookup is still loading, the badge must show that persisted branch
    // instead of the generic label.
    const label = resolveLiveBranchLabel(
      { detached: false, currentBranch: null, defaultRef: null, identityBranch: 'main' },
      labels,
    )
    expect(label).toBe('main')
  })

  test('falls back to the generic label when nothing is known', () => {
    const label = resolveLiveBranchLabel(
      { detached: false, currentBranch: null, defaultRef: null, identityBranch: null },
      labels,
    )
    expect(label).toBe('Current checkout')
  })
})
