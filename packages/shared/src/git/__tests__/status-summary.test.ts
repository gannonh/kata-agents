import { describe, expect, it } from 'bun:test'
import {
  deriveStatusSummary,
  sortStatusEntries,
  changeIndicator,
} from '../status-summary'
import type { GitStatusSnapshot, GitWorkingTreeEntry } from '../../protocol/git'

function snapshot(overrides: Partial<GitStatusSnapshot> = {}): GitStatusSnapshot {
  return {
    repositoryRoot: '/repo',
    checkoutPath: '/repo',
    isGitRepository: true,
    currentBranch: 'main',
    detached: false,
    defaultRef: 'main',
    baseRef: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    publishableCommitCount: 0,
    baseDeltaCount: 0,
    primaryRemote: null,
    provider: 'github',
    entries: [],
    operationInProgress: null,
    blockedReason: null,
    ...overrides,
  }
}

function entry(overrides: Partial<GitWorkingTreeEntry> = {}): GitWorkingTreeEntry {
  return {
    path: overrides.path ?? 'src/a.ts',
    previousPath: overrides.previousPath,
    type: overrides.type ?? 'modified',
    additions: overrides.additions,
    deletions: overrides.deletions,
    binary: overrides.binary,
  }
}

describe('deriveStatusSummary', () => {
  it('reports non-git for a null snapshot', () => {
    const s = deriveStatusSummary(null)
    expect(s.kind).toBe('non-git')
    expect(s.isGitRepository).toBe(false)
    expect(s.changedFileCount).toBe(0)
  })

  it('reports non-git when the directory is not a repository', () => {
    const s = deriveStatusSummary(snapshot({ isGitRepository: false }))
    expect(s.kind).toBe('non-git')
  })

  it('reports clean when there are no entries', () => {
    const s = deriveStatusSummary(snapshot({ entries: [] }))
    expect(s.kind).toBe('clean')
    expect(s.isClean).toBe(true)
    expect(s.changedFileCount).toBe(0)
  })

  it('sums per-entry additions/deletions when present', () => {
    const s = deriveStatusSummary(
      snapshot({
        entries: [
          entry({ path: 'a.ts', additions: 3, deletions: 1 }),
          entry({ path: 'b.ts', additions: 2, deletions: 4 }),
        ],
      }),
    )
    expect(s.kind).toBe('dirty')
    expect(s.changedFileCount).toBe(2)
    expect(s.additions).toBe(5)
    expect(s.deletions).toBe(5)
  })

  it('falls back to snapshot totals when entries omit line counts', () => {
    const s = deriveStatusSummary(
      snapshot({
        entries: [entry({ path: 'bin.dat', binary: true })],
        additions: 7,
        deletions: 8,
      }),
    )
    expect(s.additions).toBe(7)
    expect(s.deletions).toBe(8)
  })
})

describe('sortStatusEntries', () => {
  it('orders entries by path deterministically', () => {
    const sorted = sortStatusEntries([
      entry({ path: 'z.ts' }),
      entry({ path: 'a.ts' }),
      entry({ path: 'm.ts' }),
    ])
    expect(sorted.map((e) => e.path)).toEqual(['a.ts', 'm.ts', 'z.ts'])
  })

  it('does not mutate the input array', () => {
    const input = [entry({ path: 'b.ts' }), entry({ path: 'a.ts' })]
    sortStatusEntries(input)
    expect(input.map((e) => e.path)).toEqual(['b.ts', 'a.ts'])
  })
})

describe('changeIndicator', () => {
  it('maps entry types to single-character indicators', () => {
    expect(changeIndicator('modified')).toBe('M')
    expect(changeIndicator('added')).toBe('A')
    expect(changeIndicator('deleted')).toBe('D')
    expect(changeIndicator('renamed')).toBe('R')
    expect(changeIndicator('untracked')).toBe('U')
    expect(changeIndicator('copied')).toBe('C')
    expect(changeIndicator('unknown')).toBe('?')
  })
})
