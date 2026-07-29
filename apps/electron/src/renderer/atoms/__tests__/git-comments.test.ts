import { describe, it, expect, beforeEach } from 'bun:test'
import { getDefaultStore } from 'jotai'
import { createPendingComment } from '@kata-sh/shared/git'
import {
  pendingCommentsAtom,
  sessionPendingCommentsAtomFamily,
  addPendingComment,
  updatePendingCommentText,
  removePendingComment,
  clearSessionComments,
  clearStaleSessionComments,
  getSessionComments,
  reconcileStaleForSessionPath,
  reconcileSessionPathForDiff,
} from '../git-comments'

const store = getDefaultStore()

function comment(id: string, sessionId: string, path: string, fingerprint = 'fp') {
  return createPendingComment({
    id,
    sessionId,
    path,
    side: 'new',
    line: 1,
    text: `comment ${id}`,
    diffFingerprint: fingerprint,
    context: 'ctx',
    createdAt: Number(id.replace(/\D/g, '')) || 1,
  })
}

describe('git-comments store', () => {
  beforeEach(() => {
    store.set(pendingCommentsAtom, [])
  })

  it('adds comments and reads them per session', () => {
    addPendingComment(comment('c1', 's1', 'a.ts'))
    addPendingComment(comment('c2', 's2', 'b.ts'))
    expect(store.get(sessionPendingCommentsAtomFamily('s1')).map((c) => c.id)).toEqual(['c1'])
    expect(store.get(sessionPendingCommentsAtomFamily('s2')).map((c) => c.id)).toEqual(['c2'])
  })

  it('updates and removes a comment', () => {
    addPendingComment(comment('c1', 's1', 'a.ts'))
    updatePendingCommentText('c1', '  revised  ')
    expect(store.get(sessionPendingCommentsAtomFamily('s1'))[0]!.text).toBe('revised')
    removePendingComment('c1')
    expect(store.get(sessionPendingCommentsAtomFamily('s1'))).toHaveLength(0)
  })

  it('clears only the target session on send', () => {
    addPendingComment(comment('c1', 's1', 'a.ts'))
    addPendingComment(comment('c2', 's2', 'b.ts'))
    clearSessionComments('s1')
    expect(store.get(sessionPendingCommentsAtomFamily('s1'))).toHaveLength(0)
    expect(store.get(sessionPendingCommentsAtomFamily('s2'))).toHaveLength(1)
  })

  it('marks a comment stale when its path fingerprint changes', () => {
    addPendingComment(comment('c1', 's1', 'a.ts', 'old-fp'))
    addPendingComment(comment('c2', 's1', 'b.ts', 'keep-fp'))
    reconcileStaleForSessionPath('s1', 'a.ts', 'new-fp')
    const scoped = store.get(sessionPendingCommentsAtomFamily('s1'))
    expect(scoped.find((c) => c.id === 'c1')!.stale).toBe(true)
    expect(scoped.find((c) => c.id === 'c2')!.stale).toBe(false)
  })

  it('does not mark comments stale when the fingerprint still matches', () => {
    addPendingComment(comment('c1', 's1', 'a.ts', 'fp'))
    reconcileStaleForSessionPath('s1', 'a.ts', 'fp')
    expect(store.get(sessionPendingCommentsAtomFamily('s1'))[0]!.stale).toBe(false)
  })

  it('reads a session snapshot synchronously', () => {
    addPendingComment(comment('c1', 's1', 'a.ts'))
    addPendingComment(comment('c2', 's2', 'b.ts'))
    expect(getSessionComments('s1').map((c) => c.id)).toEqual(['c1'])
  })

  it('reconciles a session path against a fresh diff (drop clean, mark stale)', () => {
    addPendingComment(comment('c1', 's1', 'a.ts', 'old-fp'))
    addPendingComment(comment('c2', 's1', 'gone.ts', 'fp'))
    // a.ts still changed but fingerprint moved → stale
    reconcileSessionPathForDiff('s1', 'a.ts', {
      state: 'text',
      fingerprint: 'new-fp',
      newContent: 'l1\n',
    })
    // gone.ts reverted to clean → its comment is auto-dropped
    reconcileSessionPathForDiff('s1', 'gone.ts', { state: 'clean', fingerprint: 'clean' })
    const scoped = store.get(sessionPendingCommentsAtomFamily('s1'))
    expect(scoped.map((c) => c.id)).toEqual(['c1'])
    expect(scoped[0]!.stale).toBe(true)
  })

  it('clears only stale comments for a session', () => {
    addPendingComment(comment('c1', 's1', 'a.ts', 'old'))
    addPendingComment(comment('c2', 's1', 'b.ts', 'fp'))
    reconcileSessionPathForDiff('s1', 'a.ts', { state: 'text', fingerprint: 'new', newContent: 'l1\n' })
    clearStaleSessionComments('s1')
    expect(store.get(sessionPendingCommentsAtomFamily('s1')).map((c) => c.id)).toEqual(['c2'])
  })
})
