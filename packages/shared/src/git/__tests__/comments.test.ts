import { describe, expect, it } from 'bun:test'
import {
  createPendingComment,
  reconcileStaleForPath,
  hasStaleComments,
  commentsForSession,
  serializeFeedback,
  sortCommentsForSerialization,
} from '../comments'
import type { GitPendingComment } from '../../protocol/git'

function make(overrides: Partial<GitPendingComment> = {}): GitPendingComment {
  return {
    id: overrides.id ?? 'c1',
    sessionId: overrides.sessionId ?? 's1',
    path: overrides.path ?? 'src/a.ts',
    previousPath: overrides.previousPath,
    side: overrides.side ?? 'new',
    line: overrides.line ?? 10,
    text: overrides.text ?? 'fix this',
    diffFingerprint: overrides.diffFingerprint ?? 'fp1',
    context: overrides.context ?? 'const a = 1',
    createdAt: overrides.createdAt ?? 1,
    stale: overrides.stale,
  }
}

describe('createPendingComment', () => {
  it('trims text and starts non-stale', () => {
    const c = createPendingComment({
      id: 'c1',
      sessionId: 's1',
      path: 'a.ts',
      side: 'new',
      line: 3,
      text: '  needs work  ',
      diffFingerprint: 'fp',
      context: 'x',
      createdAt: 5,
    })
    expect(c.text).toBe('needs work')
    expect(c.stale).toBe(false)
  })
})

describe('reconcileStaleForPath', () => {
  it('marks comments stale when the fingerprint changes for that path', () => {
    const comments = [make({ id: 'c1', path: 'a.ts', diffFingerprint: 'old' })]
    const next = reconcileStaleForPath(comments, 'a.ts', 'new')
    expect(next[0]!.stale).toBe(true)
  })

  it('clears staleness when the fingerprint matches again', () => {
    const comments = [make({ id: 'c1', path: 'a.ts', diffFingerprint: 'fp', stale: true })]
    const next = reconcileStaleForPath(comments, 'a.ts', 'fp')
    expect(next[0]!.stale).toBe(false)
  })

  it('does not touch comments on other paths', () => {
    const comments = [
      make({ id: 'c1', path: 'a.ts', diffFingerprint: 'old' }),
      make({ id: 'c2', path: 'b.ts', diffFingerprint: 'keep' }),
    ]
    const next = reconcileStaleForPath(comments, 'a.ts', 'new')
    expect(next[0]!.stale).toBe(true)
    expect(next[1]!.stale).toBeUndefined()
  })

  it('returns the same array reference when nothing changed', () => {
    const comments = [make({ id: 'c1', path: 'a.ts', diffFingerprint: 'fp' })]
    const next = reconcileStaleForPath(comments, 'a.ts', 'fp')
    expect(next).toBe(comments)
  })
})

describe('hasStaleComments', () => {
  it('detects at least one stale comment', () => {
    expect(hasStaleComments([make({ stale: false }), make({ id: 'c2', stale: true })])).toBe(true)
    expect(hasStaleComments([make({ stale: false })])).toBe(false)
  })
})

describe('commentsForSession', () => {
  it('filters to a single session', () => {
    const all = [make({ id: 'c1', sessionId: 's1' }), make({ id: 'c2', sessionId: 's2' })]
    expect(commentsForSession(all, 's1').map((c) => c.id)).toEqual(['c1'])
  })
})

describe('sortCommentsForSerialization', () => {
  it('orders by path, side (old before new), line, then createdAt', () => {
    const comments = [
      make({ id: 'a', path: 'z.ts', side: 'new', line: 1 }),
      make({ id: 'b', path: 'a.ts', side: 'new', line: 5 }),
      make({ id: 'c', path: 'a.ts', side: 'old', line: 9 }),
      make({ id: 'd', path: 'a.ts', side: 'new', line: 2 }),
    ]
    expect(sortCommentsForSerialization(comments).map((c) => c.id)).toEqual(['c', 'd', 'b', 'a'])
  })
})

describe('serializeFeedback', () => {
  it('produces a deterministic structured message with path, side, line, and context', () => {
    const comments = [
      make({ id: 'c1', path: 'src/a.ts', side: 'new', line: 12, text: 'rename this', context: 'const foo = 1' }),
      make({ id: 'c2', path: 'src/a.ts', side: 'old', line: 4, text: 'why removed?', context: 'const bar = 2' }),
    ]
    const msg = serializeFeedback(comments)
    expect(msg).toContain('### src/a.ts')
    expect(msg).toContain('- [old line 4] why removed?')
    expect(msg).toContain('- [new line 12] rename this')
    expect(msg).toContain('  > const foo = 1')
    // Deterministic across insertion order.
    const reversed = serializeFeedback([...comments].reverse())
    expect(reversed).toBe(msg)
  })

  it('notes renames in the path heading', () => {
    const msg = serializeFeedback([
      make({ path: 'new.ts', previousPath: 'old.ts', text: 'ok' }),
    ])
    expect(msg).toContain('### new.ts (renamed from old.ts)')
  })
})
