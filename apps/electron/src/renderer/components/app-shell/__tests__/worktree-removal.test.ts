import { describe, expect, it } from 'bun:test'
import type { WorktreeRemovalRisk } from '@kata-sh/shared/protocol'
import { summarizeWorktreeRemoval, canOfferWorktreeRemoval } from '../worktree-removal'

function risk(overrides: Partial<WorktreeRemovalRisk> = {}): WorktreeRemovalRisk {
  return {
    managedWorktreeId: 'mw1',
    exists: true,
    ownerSessionIds: ['s1'],
    otherOwnerCount: 0,
    uncommittedFileCount: 0,
    unpushedCommitCount: 0,
    branchHasUniqueWork: false,
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
