import type { JournalEntry } from '@kata-sh/core'
import type { HandoffRailView } from '@kata-sh/shared/protocol'

export type HandoffTimelineItem =
  | { kind: 'handoff'; rail: HandoffRailView }
  | { kind: 'entry'; entry: JournalEntry }

export function mergeHandoffTimeline(
  entries: readonly JournalEntry[],
  handoffs: readonly HandoffRailView[],
): HandoffTimelineItem[] {
  const loadedHandoffIds = new Set(handoffs.map(rail => rail.handoffId))
  const ordered = handoffs
    .map(rail => ({ rail, seq: rail.exchange[0]?.seq ?? Number.MAX_SAFE_INTEGER }))
    .sort((left, right) => left.seq - right.seq || left.rail.handoffId.localeCompare(right.rail.handoffId))
  const items: HandoffTimelineItem[] = []
  let handoffIndex = 0

  for (const entry of entries) {
    while (handoffIndex < ordered.length && ordered[handoffIndex].seq <= entry.seq) {
      items.push({ kind: 'handoff', rail: ordered[handoffIndex].rail })
      handoffIndex += 1
    }
    const hasLoadedRail = entry.kind === 'handoff'
      && entry.handoffId !== undefined
      && loadedHandoffIds.has(entry.handoffId)
    if (!hasLoadedRail) items.push({ kind: 'entry', entry })
  }

  while (handoffIndex < ordered.length) {
    items.push({ kind: 'handoff', rail: ordered[handoffIndex].rail })
    handoffIndex += 1
  }
  return items
}
