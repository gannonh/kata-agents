import { describe, expect, it } from 'bun:test'
import type { BrowserInstanceInfo } from '@kata-sh/shared/protocol'
import {
  BROWSER_TOOLBAR_HEIGHT,
  browserPanelRoute,
  layoutBrowserSurfaceRects,
  parseBrowserInstanceIdFromRoute,
  reconcileBrowserPanels,
  resolveCreateSurface,
} from '../browser-surface'

function makeInstance(id: string, overrides?: Partial<BrowserInstanceInfo>): BrowserInstanceInfo {
  return {
    id,
    url: 'https://example.com',
    title: 'Example',
    favicon: null,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    boundSessionId: null,
    ownerType: 'manual',
    ownerSessionId: null,
    isVisible: true,
    agentControlActive: false,
    themeColor: null,
    workspaceId: 'ws-a',
    surface: 'panel',
    ...overrides,
  }
}

describe('browser surface layout', () => {
  it('splits host bounds into toolbar and page rects', () => {
    expect(layoutBrowserSurfaceRects({ x: 40, y: 80, width: 800, height: 600 })).toEqual({
      toolbar: { x: 40, y: 80, width: 800, height: BROWSER_TOOLBAR_HEIGHT },
      page: { x: 40, y: 80 + BROWSER_TOOLBAR_HEIGHT, width: 800, height: 600 - BROWSER_TOOLBAR_HEIGHT },
    })
  })

  it('floors coordinates and never produces a negative page height', () => {
    expect(layoutBrowserSurfaceRects({ x: 10.9, y: 20.2, width: 100.4, height: 30 })).toEqual({
      toolbar: { x: 10, y: 20, width: 100, height: 30 },
      page: { x: 10, y: 50, width: 100, height: 0 },
    })
  })
})

describe('browser panel routes', () => {
  it('builds and parses a browser instance route', () => {
    expect(browserPanelRoute('browser-7')).toBe('browser/browser-7')
    expect(parseBrowserInstanceIdFromRoute('browser/browser-7')).toBe('browser-7')
  })

  it('rejects unrelated routes', () => {
    expect(parseBrowserInstanceIdFromRoute('allSessions/session/abc')).toBeNull()
    expect(parseBrowserInstanceIdFromRoute('browser/')).toBeNull()
    expect(parseBrowserInstanceIdFromRoute('browser/one/two')).toBeNull()
  })
})

describe('resolveCreateSurface', () => {
  it('defaults new instances to the integrated panel', () => {
    expect(resolveCreateSurface()).toBe('panel')
    expect(resolveCreateSurface({})).toBe('panel')
    expect(resolveCreateSurface({ show: true })).toBe('panel')
  })

  it('honors an explicit detached surface', () => {
    expect(resolveCreateSurface({ surface: 'detached' })).toBe('detached')
  })
})

describe('reconcileBrowserPanels', () => {
  it('opens a panel for each visible panel-surface instance', () => {
    const result = reconcileBrowserPanels(
      [makeInstance('a'), makeInstance('b', { surface: 'detached' })],
      [],
    )
    expect(result.toOpen).toEqual(['a'])
    expect(result.toClose).toEqual([])
  })

  it('closes panels whose instances are hidden, detached, or gone', () => {
    const result = reconcileBrowserPanels(
      [
        makeInstance('hidden', { isVisible: false }),
        makeInstance('detached', { surface: 'detached' }),
      ],
      ['hidden', 'detached', 'gone'],
    )
    expect(result.toOpen).toEqual([])
    expect(result.toClose.sort()).toEqual(['detached', 'gone', 'hidden'])
  })

  it('treats a missing surface as detached so older servers do not auto-open panels', () => {
    const legacy = makeInstance('legacy')
    delete legacy.surface
    const result = reconcileBrowserPanels([legacy], [])
    expect(result.toOpen).toEqual([])
  })

  it('is a no-op when open panels already match visible panel instances', () => {
    const result = reconcileBrowserPanels([makeInstance('a')], ['a'])
    expect(result).toEqual({ toOpen: [], toClose: [] })
  })
})
