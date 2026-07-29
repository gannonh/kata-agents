/**
 * Pure derivations over a {@link GitStatusSnapshot} for the Changes surface.
 *
 * These helpers are transport- and React-agnostic so the renderer's Changes
 * affordance, panel header, and file list all read the same derived truth. Keep
 * this module free of React and IPC concerns so it stays unit-testable.
 */

import type {
  GitStatusSnapshot,
  GitWorkingTreeEntry,
  GitWorkingTreeEntryType,
} from '../protocol/git'

/**
 * High-level surface state used by the affordance and the panel header. The
 * spec requires the panel to render explicit clean / non-Git states, and the
 * affordance to show a changed-file count with additions/deletions.
 */
export type ChangesSurfaceKind = 'non-git' | 'clean' | 'dirty'

export interface GitStatusSummary {
  kind: ChangesSurfaceKind
  isGitRepository: boolean
  isClean: boolean
  changedFileCount: number
  additions: number
  deletions: number
}

/** Sum per-entry additions/deletions, falling back to the snapshot totals. */
function resolveTotals(status: GitStatusSnapshot): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  let sawPerEntry = false
  for (const entry of status.entries) {
    if (typeof entry.additions === 'number') {
      additions += entry.additions
      sawPerEntry = true
    }
    if (typeof entry.deletions === 'number') {
      deletions += entry.deletions
      sawPerEntry = true
    }
  }
  if (sawPerEntry) return { additions, deletions }
  return {
    additions: status.additions ?? 0,
    deletions: status.deletions ?? 0,
  }
}

/**
 * Derive the affordance/header summary from a status snapshot. A null snapshot
 * (not yet loaded) is treated as a non-Git, empty summary so callers can render
 * a neutral state without special-casing loading.
 */
export function deriveStatusSummary(status: GitStatusSnapshot | null): GitStatusSummary {
  if (!status || !status.isGitRepository) {
    return {
      kind: 'non-git',
      isGitRepository: false,
      isClean: true,
      changedFileCount: 0,
      additions: 0,
      deletions: 0,
    }
  }

  const changedFileCount = status.entries.length
  const isClean = changedFileCount === 0
  const { additions, deletions } = resolveTotals(status)

  return {
    kind: isClean ? 'clean' : 'dirty',
    isGitRepository: true,
    isClean,
    changedFileCount,
    additions,
    deletions,
  }
}

/**
 * Deterministic ordering for the flat changed-file list (V1 has no tree). Sorts
 * by path so the list is stable across polls regardless of Git's output order.
 */
export function sortStatusEntries(entries: GitWorkingTreeEntry[]): GitWorkingTreeEntry[] {
  return [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/**
 * Single-character status indicator for the flat list. Mirrors Git's short
 * status vocabulary: M(odified), A(dded), D(eleted), R(enamed), U(ntracked),
 * C(opied), and `?` for unknown.
 */
export function changeIndicator(type: GitWorkingTreeEntryType): string {
  switch (type) {
    case 'modified':
      return 'M'
    case 'added':
      return 'A'
    case 'deleted':
      return 'D'
    case 'renamed':
      return 'R'
    case 'untracked':
      return 'U'
    case 'copied':
      return 'C'
    default:
      return '?'
  }
}
