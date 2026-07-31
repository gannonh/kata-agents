import { describe, it, expect, beforeEach } from 'bun:test'
import { createPendingComment } from '@kata-sh/shared/git'
import type { GitFileDiff } from '@kata-sh/shared/protocol'
import { appStore } from '@/atoms/store'
import {
  pendingCommentsAtom,
  sessionPendingCommentsAtomFamily,
  addPendingComment,
} from '@/atoms/git-comments'
import { submitPendingFeedback } from '../feedback-send'

const store = appStore

function comment(id: string, path: string, fingerprint = 'fp', line = 1) {
  return createPendingComment({
    id,
    sessionId: 's1',
    path,
    side: 'new',
    line,
    text: `comment ${id}`,
    diffFingerprint: fingerprint,
    context: 'ctx',
    createdAt: Number(id.replace(/\D/g, '')) || 1,
  })
}

function textDiff(path: string, fingerprint: string, lines = 3): GitFileDiff {
  return {
    path,
    changeType: 'modified',
    state: 'text',
    fingerprint,
    newContent: Array.from({ length: lines }, (_, i) => `l${i + 1}`).join('\n') + '\n',
    oldContent: '',
  }
}

function scoped() {
  return store.get(sessionPendingCommentsAtomFamily('s1'))
}

describe('submitPendingFeedback', () => {
  beforeEach(() => {
    store.set(pendingCommentsAtom, [])
  })

  it('clears comments only after a successful submission', async () => {
    addPendingComment(comment('c1', 'a.ts', 'fp'))
    const sent: string[] = []
    const result = await submitPendingFeedback('s1', {
      getDiff: async (_id, path) => textDiff(path, 'fp'),
      send: async (_id, message) => {
        sent.push(message)
        return true
      },
    })
    expect(result).toBe('sent')
    expect(sent).toHaveLength(1)
    expect(scoped()).toHaveLength(0)
  })

  it('retains comments when submission fails', async () => {
    addPendingComment(comment('c1', 'a.ts', 'fp'))
    const result = await submitPendingFeedback('s1', {
      getDiff: async (_id, path) => textDiff(path, 'fp'),
      send: async () => false,
    })
    expect(result).toBe('failed')
    expect(scoped().map((c) => c.id)).toEqual(['c1'])
  })

  it('blocks sending and retains comments when a refreshed diff is now stale', async () => {
    addPendingComment(comment('c1', 'a.ts', 'old-fp'))
    let sendCalled = false
    const result = await submitPendingFeedback('s1', {
      // Fingerprint moved since the comment was captured → stale.
      getDiff: async (_id, path) => textDiff(path, 'new-fp'),
      send: async () => {
        sendCalled = true
        return true
      },
    })
    expect(result).toBe('requires-review')
    expect(sendCalled).toBe(false)
    expect(scoped()[0]!.stale).toBe(true)
  })

  it('auto-drops comments on a reverted path and sends the rest', async () => {
    addPendingComment(comment('c1', 'gone.ts', 'fp'))
    addPendingComment(comment('c2', 'a.ts', 'fp'))
    let sentMessage = ''
    const result = await submitPendingFeedback('s1', {
      getDiff: async (_id, path) =>
        path === 'gone.ts'
          ? ({ path, changeType: 'unknown', state: 'clean', fingerprint: 'clean' } as GitFileDiff)
          : textDiff(path, 'fp'),
      send: async (_id, message) => {
        sentMessage = message
        return true
      },
    })
    expect(result).toBe('sent')
    expect(sentMessage).toContain('### a.ts')
    expect(sentMessage).not.toContain('gone.ts')
    expect(scoped()).toHaveLength(0)
  })

  it('reports empty when there are no comments', async () => {
    const result = await submitPendingFeedback('s1', {
      getDiff: async (_id, path) => textDiff(path, 'fp'),
      send: async () => true,
    })
    expect(result).toBe('empty')
  })
})
