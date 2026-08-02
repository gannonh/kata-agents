import { describe, expect, it } from 'bun:test'
import { resolveTurnExpanded } from '../turn-card-expansion'

describe('resolveTurnExpanded', () => {
  it('follows the app default for turns without an explicit override', () => {
    expect(resolveTurnExpanded('turn-1', true, new Set(), new Set())).toBe(true)
    expect(resolveTurnExpanded('turn-1', false, new Set(), new Set())).toBe(false)
  })

  it('keeps an explicitly collapsed turn closed when the default is expanded', () => {
    expect(resolveTurnExpanded('turn-1', true, new Set(), new Set(['turn-1']))).toBe(false)
  })

  it('keeps an explicitly expanded turn open when the default is collapsed', () => {
    expect(resolveTurnExpanded('turn-1', false, new Set(['turn-1']), new Set())).toBe(true)
  })
})
