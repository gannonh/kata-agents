import type { JournalEntry } from '@kata-sh/core'
import type { ApprovalCardView, HandoffRailView } from '@kata-sh/shared/protocol'

export type ChatTimelineItem =
  | { kind: 'handoff'; rail: HandoffRailView }
  | { kind: 'approval'; card: ApprovalCardView }
  | { kind: 'entry'; entry: JournalEntry }

export type HandoffTimelineItem = ChatTimelineItem

export function mergeHandoffTimeline(
  entries: readonly JournalEntry[],
  handoffs: readonly HandoffRailView[],
  approvals: readonly ApprovalCardView[] = [],
): ChatTimelineItem[] {
  const loadedHandoffIds = new Set(handoffs.map(rail => rail.handoffId))
  const loadedApprovalIds = new Set(approvals.map(card => card.approvalId))
  const orderedHandoffs = handoffs
    .map(rail => ({ kind: 'handoff' as const, rail, seq: rail.exchange[0]?.seq ?? Number.MAX_SAFE_INTEGER, id: rail.handoffId }))
  const orderedApprovals = approvals
    .map(card => ({
      kind: 'approval' as const,
      card,
      seq: entries.find(entry => entry.kind === 'approval' && entry.approvalId === card.approvalId)?.seq ?? Number.MAX_SAFE_INTEGER,
      id: card.approvalId,
    }))
  const ordered = [...orderedHandoffs, ...orderedApprovals]
    .sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id))
  const items: ChatTimelineItem[] = []
  let index = 0

  for (const entry of entries) {
    while (index < ordered.length && ordered[index].seq <= entry.seq) {
      const item = ordered[index]
      items.push(item.kind === 'handoff' ? { kind: 'handoff', rail: item.rail } : { kind: 'approval', card: item.card })
      index += 1
    }
    const hasLoadedRail = entry.kind === 'handoff'
      && entry.handoffId !== undefined
      && loadedHandoffIds.has(entry.handoffId)
    const hasLoadedApproval = entry.kind === 'approval'
      && entry.approvalId !== undefined
      && loadedApprovalIds.has(entry.approvalId)
    if (!hasLoadedRail && !hasLoadedApproval) items.push({ kind: 'entry', entry })
  }

  while (index < ordered.length) {
    const item = ordered[index]
    items.push(item.kind === 'handoff' ? { kind: 'handoff', rail: item.rail } : { kind: 'approval', card: item.card })
    index += 1
  }
  return items
}
