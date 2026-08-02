/**
 * Resolve a turn's effective expansion state.
 * Explicit per-turn state takes precedence over the app-wide default.
 */
export function resolveTurnExpanded(
  turnId: string,
  defaultExpanded: boolean,
  expandedTurns: ReadonlySet<string>,
  collapsedTurns: ReadonlySet<string>,
): boolean {
  if (expandedTurns.has(turnId)) return true
  if (collapsedTurns.has(turnId)) return false
  return defaultExpanded
}
