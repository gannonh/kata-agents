import { describe, expect, it } from 'bun:test'
import type { WorktreeRemovalRisk } from '@kata-sh/shared/protocol'
import {
  summarizeWorktreeRemoval,
  canOfferWorktreeRemoval,
  resolveDeleteConfirmation,
} from '../worktree-removal'

function risk(overrides: Partial<WorktreeRemovalRisk> = {}): WorktreeRemovalRisk {
  return {
    managedWorktreeId: 'mw1',
    exists: true,
    ownerSessionIds: ['s1'],
    otherOwnerCount: 0,
    uncommittedFileCount: 0,
    unpushedCommitCount: 0,
    branchHasUniqueWork: false,
    confirmationFingerprint: 'fixture-confirmation-fingerprint',
    blocked: false,
    ...overrides,
  }
}

describe('summarizeWorktreeRemoval', () => {
  it('is non-destructive and prunes the branch for a clean, sole-owned worktree', () => {
    const s = summarizeWorktreeRemoval(risk())
    expect(s.blocked).toBe(false)
    expect(s.destructive).toBe(false)
    expect(s.branchWillBePruned).toBe(true)
  })

  it('blocks while another session owns the worktree', () => {
    const s = summarizeWorktreeRemoval(
      risk({ otherOwnerCount: 1, blocked: true, blockedReason: 'Another session still owns this worktree.' }),
    )
    expect(s.blocked).toBe(true)
    expect(s.blockedReason).toMatch(/another session/i)
  })

  it('marks removal destructive when there are uncommitted files', () => {
    const s = summarizeWorktreeRemoval(risk({ uncommittedFileCount: 3 }))
    expect(s.destructive).toBe(true)
    expect(s.uncommittedFileCount).toBe(3)
  })

  it('marks removal destructive and keeps the branch when it has unique work', () => {
    const s = summarizeWorktreeRemoval(
      risk({ unpushedCommitCount: 2, branchHasUniqueWork: true }),
    )
    expect(s.destructive).toBe(true)
    expect(s.unpushedCommitCount).toBe(2)
    // Unique work → the temporary branch is NOT pruned.
    expect(s.branchWillBePruned).toBe(false)
  })

  it('does not treat a blocked worktree as destructive', () => {
    const s = summarizeWorktreeRemoval(
      risk({ blocked: true, otherOwnerCount: 1, uncommittedFileCount: 5, branchHasUniqueWork: true }),
    )
    expect(s.blocked).toBe(true)
    expect(s.destructive).toBe(false)
  })
})

describe('canOfferWorktreeRemoval', () => {
  it('offers removal only for an existing managed worktree', () => {
    expect(canOfferWorktreeRemoval(risk())).toBe(true)
    expect(canOfferWorktreeRemoval(risk({ exists: false }))).toBe(false)
    expect(canOfferWorktreeRemoval(null)).toBe(false)
  })
})

describe('resolveDeleteConfirmation', () => {
  it('routes a managed-worktree session to the dialog even when the session is empty', () => {
    // Preparation is only allowed before the first send, so a prepared session
    // is still "empty". Taking the empty shortcut here would delete the session
    // and orphan its checkout with no UI left to remove it.
    expect(
      resolveDeleteConfirmation({ isEmpty: true, checkoutMode: 'managed-worktree' }),
    ).toBe('managed-worktree-dialog')
    expect(
      resolveDeleteConfirmation({ isEmpty: false, checkoutMode: 'managed-worktree' }),
    ).toBe('managed-worktree-dialog')
  })

  it('keeps the ordinary paths for sessions with no managed worktree', () => {
    expect(resolveDeleteConfirmation({ isEmpty: true, checkoutMode: null })).toBe('skip')
    expect(resolveDeleteConfirmation({ isEmpty: false, checkoutMode: null })).toBe('native-confirm')
    // A current checkout is the user's own directory — no Kata-owned checkout to
    // clean up, so the ordinary paths apply.
    expect(resolveDeleteConfirmation({ isEmpty: true, checkoutMode: 'current' })).toBe('skip')
    expect(resolveDeleteConfirmation({ isEmpty: false, checkoutMode: 'current' })).toBe(
      'native-confirm',
    )
  })
})
