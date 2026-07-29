/**
 * Pure mappings between Kata's comment side vocabulary (`old` / `new`) and
 * Pierre's diff annotation sides (`deletions` / `additions`), plus line-context
 * extraction for anchoring a comment to the diff line it targets.
 *
 * Keep this free of React so it stays unit-testable.
 */

import type { GitCommentSide } from '@kata-sh/shared/protocol'

/** Pierre's annotation side vocabulary. */
export type PierreSide = 'deletions' | 'additions'

/** `old` → committed/HEAD side (`deletions`); `new` → working-tree side (`additions`). */
export function toPierreSide(side: GitCommentSide): PierreSide {
  return side === 'old' ? 'deletions' : 'additions'
}

/** Inverse of {@link toPierreSide}. */
export function fromPierreSide(side: PierreSide): GitCommentSide {
  return side === 'deletions' ? 'old' : 'new'
}

/**
 * Extract the 1-based line's text from a file side's content, trimmed for use as
 * a comment's surrounding context. Out-of-range lines yield an empty string.
 */
export function lineContext(content: string | undefined, line: number): string {
  if (!content || line < 1) return ''
  const lines = content.split('\n')
  const value = lines[line - 1]
  return value === undefined ? '' : value.trim()
}
