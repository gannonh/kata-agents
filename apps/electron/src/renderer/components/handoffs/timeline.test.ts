import { describe, expect, it } from 'bun:test'
import type { JournalEntry } from '@kata-sh/core'
import type { HandoffRailView } from '@kata-sh/shared/protocol'
import { mergeHandoffTimeline } from './timeline'

function entry(entryId: string, seq: number, handoffId?: string): JournalEntry {
  return {
    schemaVersion: 1,
    entryId,
    conversationId: 'chat_1',
    seq,
    kind: handoffId ? 'handoff' : 'bot',
    idempotencyKey: entryId,
    body: entryId,
    createdAt: '2026-08-28T00:00:00.000Z',
    ...(handoffId ? { handoffId } : {}),
  }
}

function rail(handoffId: string, seq: number): HandoffRailView {
  return {
    handoffId,
    conversationId: 'chat_1',
    sourceBotName: 'Source',
    targetBotName: 'Target',
    delivery: {
      deliveryId: `delivery_${handoffId}`,
      handoffId,
      workspaceId: 'workspace_1',
      conversationId: 'chat_1',
      sourceBotId: 'bot_source',
      targetBotId: 'bot_target',
      request: 'Review this.',
      mailState: 'pending',
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:00.000Z',
      version: 1,
    },
    exchange: [{
      entryId: `entry_${handoffId}`,
      seq,
      phase: 'requested',
      createdAt: '2026-08-28T00:00:00.000Z',
    }],
    task: null,
    unread: false,
    freshness: { deliveryVersion: 1, taskVersion: 0, journalSequence: seq },
    actions: [],
  }
}

describe('mergeHandoffTimeline', () => {
  it('suppresses journal handoff entries only when their rail is loaded', () => {
    const loaded = entry('entry_loaded', 2, 'handoff_loaded')
    const missing = entry('entry_missing', 3, 'handoff_missing')

    expect(mergeHandoffTimeline([
      entry('entry_before', 1),
      loaded,
      missing,
    ], [rail('handoff_loaded', 2)])).toEqual([
      { kind: 'entry', entry: entry('entry_before', 1) },
      { kind: 'handoff', rail: rail('handoff_loaded', 2) },
      { kind: 'entry', entry: missing },
    ])
  })
})
