import { describe, it, expect } from 'bun:test'
import {
  parseRightSidebarParam,
  buildRightSidebarParam,
  parseRouteToNavigationState,
} from '../route-parser'
import type { RightSidebarPanel } from '../types'

describe('route-parser: changes right-sidebar param', () => {
  it('parses a bare "changes" param into a changes panel with no path', () => {
    expect(parseRightSidebarParam('changes')).toEqual({ type: 'changes' })
  })

  it('parses "changes/<path>" into a changes panel with the selected path', () => {
    expect(parseRightSidebarParam('changes/src/a.ts')).toEqual({
      type: 'changes',
      path: 'src/a.ts',
    })
  })

  it('round-trips a changes panel with a path through build/parse', () => {
    const panel: RightSidebarPanel = { type: 'changes', path: 'packages/x/y.ts' }
    const param = buildRightSidebarParam(panel)
    expect(param).toBe('changes/packages/x/y.ts')
    expect(parseRightSidebarParam(param)).toEqual(panel)
  })

  it('round-trips a bare changes panel', () => {
    const panel: RightSidebarPanel = { type: 'changes' }
    const param = buildRightSidebarParam(panel)
    expect(param).toBe('changes')
    expect(parseRightSidebarParam(param)).toEqual({ type: 'changes' })
  })

  it('attaches the changes panel to a session navigation state', () => {
    const state = parseRouteToNavigationState('allSessions/session/abc123', 'changes')
    expect(state).not.toBeNull()
    expect(state!.rightSidebar).toEqual({ type: 'changes' })
  })
})
