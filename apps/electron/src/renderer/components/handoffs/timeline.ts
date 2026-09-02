import type { JournalEntry } from '@kata-sh/core'
import type { ApprovalCardView, HandoffRailView, KatacodeTaskRailView } from '@kata-sh/shared/protocol'

export type ChatTimelineItem =
  | { kind: 'handoff'; rail: HandoffRailView }
  | { kind: 'katacode'; rail: KatacodeTaskRailView }
  | { kind: 'approval'; card: ApprovalCardView }
  | { kind: 'entry'; entry: JournalEntry }

export type HandoffTimelineItem = ChatTimelineItem

export function mergeHandoffTimeline(
  entries: readonly JournalEntry[],
  handoffs: readonly HandoffRailView[],
  approvals: readonly ApprovalCardView[] = [],
  tasks: readonly KatacodeTaskRailView[] = [],
): ChatTimelineItem[] {
  const loadedHandoffIds = new Set(handoffs.map(rail => rail.handoffId))
  const loadedApprovalIds = new Set(approvals.map(card => card.approvalId))
  const loadedTaskIds = new Set(tasks.map(rail => rail.taskId))
  const orderedHandoffs = handoffs
    .map(rail => ({ kind: 'handoff' as const, rail, seq: rail.exchange[0]?.seq ?? Number.MAX_SAFE_INTEGER, id: rail.handoffId }))
  const orderedApprovals = approvals
    .map(card => ({
      kind: 'approval' as const,
      card,
      seq: entries.find(entry => entry.kind === 'approval' && entry.approvalId === card.approvalId)?.seq ?? Number.MAX_SAFE_INTEGER,
      id: card.approvalId,
    }))
  const orderedTasks = tasks
    .map(rail => ({
      kind: 'katacode' as const,
      rail,
      seq: entries.find(entry => entry.kind === 'task' && entry.taskId === rail.taskId)?.seq ?? Number.MAX_SAFE_INTEGER,
      id: rail.taskId,
    }))
  const ordered = [...orderedHandoffs, ...orderedApprovals, ...orderedTasks]
    .sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id))
  const items: ChatTimelineItem[] = []
  let index = 0

  for (const entry of entries) {
    while (index < ordered.length && ordered[index].seq <= entry.seq) {
      items.push(toItem(ordered[index]))
      index += 1
    }
    const hasLoadedRail = entry.kind === 'handoff'
      && entry.handoffId !== undefined
      && loadedHandoffIds.has(entry.handoffId)
    const hasLoadedApproval = entry.kind === 'approval'
      && entry.approvalId !== undefined
      && loadedApprovalIds.has(entry.approvalId)
    const hasLoadedTask = entry.kind === 'task'
      && entry.taskId !== undefined
      && loadedTaskIds.has(entry.taskId)
    if (!hasLoadedRail && !hasLoadedApproval && !hasLoadedTask) items.push({ kind: 'entry', entry })
  }

  while (index < ordered.length) {
    items.push(toItem(ordered[index]))
    index += 1
  }
  return items
}

function toItem(
  item:
    | { kind: 'handoff'; rail: HandoffRailView }
    | { kind: 'approval'; card: ApprovalCardView }
    | { kind: 'katacode'; rail: KatacodeTaskRailView },
): ChatTimelineItem {
  if (item.kind === 'handoff') return { kind: 'handoff', rail: item.rail }
  if (item.kind === 'approval') return { kind: 'approval', card: item.card }
  return { kind: 'katacode', rail: item.rail }
}
