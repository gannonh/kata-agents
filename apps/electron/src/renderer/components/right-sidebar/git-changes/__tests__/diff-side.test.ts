import { describe, it, expect } from 'bun:test'
import { toPierreSide, fromPierreSide, lineContext } from '../diff-side'

describe('diff-side mapping', () => {
  it('maps old → deletions and new → additions', () => {
    expect(toPierreSide('old')).toBe('deletions')
    expect(toPierreSide('new')).toBe('additions')
  })

  it('inverts back from Pierre sides', () => {
    expect(fromPierreSide('deletions')).toBe('old')
    expect(fromPierreSide('additions')).toBe('new')
  })

  it('round-trips both directions', () => {
    expect(fromPierreSide(toPierreSide('old'))).toBe('old')
    expect(fromPierreSide(toPierreSide('new'))).toBe('new')
  })
})

describe('lineContext', () => {
  const content = 'const a = 1\nconst b = 2\n  const c = 3  '

  it('returns the trimmed text of a 1-based line', () => {
    expect(lineContext(content, 1)).toBe('const a = 1')
    expect(lineContext(content, 2)).toBe('const b = 2')
    expect(lineContext(content, 3)).toBe('const c = 3')
  })

  it('returns empty string for out-of-range or missing content', () => {
    expect(lineContext(content, 0)).toBe('')
    expect(lineContext(content, 99)).toBe('')
    expect(lineContext(undefined, 1)).toBe('')
  })
})
