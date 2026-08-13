import { describe, expect, it } from 'bun:test'
import {
  buildRouteFromNavigationState,
  parseCompoundRoute,
  parseRouteToNavigationState,
} from '../route-parser'
import type { BrowserNavigationState } from '../types'

describe('route-parser: browser panel routes', () => {
  it('parses browser/{id} as a browser navigator with an instance', () => {
    const parsed = parseCompoundRoute('browser/browser-3')
    expect(parsed).toEqual({
      navigator: 'browser',
      details: { type: 'instance', id: 'browser-3' },
    })
  })

  it('round-trips browser navigation state', () => {
    const state: BrowserNavigationState = {
      navigator: 'browser',
      instanceId: 'browser-9',
    }
    const route = buildRouteFromNavigationState(state)
    expect(route).toBe('browser/browser-9')
    expect(parseRouteToNavigationState(route)).toEqual(state)
  })

  it('does not parse a bare browser prefix as an instance', () => {
    expect(parseCompoundRoute('browser')).toBeNull()
    expect(parseRouteToNavigationState('browser')).toBeNull()
  })
})
