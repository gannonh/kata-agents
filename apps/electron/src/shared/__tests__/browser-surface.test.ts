import { describe, expect, it } from 'bun:test'
import type { BrowserInstanceInfo } from '@kata-sh/shared/protocol'
import {
  BROWSER_TOOLBAR_HEIGHT,
  browserPanelBoundsChanged,
  browserPanelReportedBounds,
  browserPanelRoute,
  isBlankBrowserUrl,
  layoutBrowserSurfaceRects,
  parseBrowserInstanceIdFromRoute,
  reconcileBrowserPanels,
  resolveCreateSurface,
  roundBrowserPanelBounds,
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

  it('gives the page the full host when toolbar height is zero', () => {
    expect(layoutBrowserSurfaceRects({ x: 40, y: 80, width: 800, height: 600 }, 0)).toEqual({
      toolbar: { x: 40, y: 80, width: 800, height: 0 },
      page: { x: 40, y: 80, width: 800, height: 600 },
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
    expect(result.toPark).toEqual([])
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
    expect(result.toPark).toEqual([])
  })

  it('treats a missing surface as detached so older servers do not auto-open panels', () => {
    const legacy = makeInstance('legacy')
    delete legacy.surface
    const result = reconcileBrowserPanels([legacy], [])
    expect(result.toOpen).toEqual([])
  })

  it('is a no-op when open panels already match visible panel instances', () => {
    const result = reconcileBrowserPanels([makeInstance('a')], ['a'])
    expect(result).toEqual({ toOpen: [], toClose: [], toPark: [] })
  })

  it('parks a still-visible panel instance that the workspace filter dropped', () => {
    const all = [makeInstance('foreign', { workspaceId: 'ws-b' })]
    const result = reconcileBrowserPanels([], ['foreign'], all)
    expect(result).toEqual({ toOpen: [], toClose: ['foreign'], toPark: ['foreign'] })
  })

  it('does not park a panel that detached into a native window', () => {
    const all = [makeInstance('detached', { surface: 'detached' })]
    const result = reconcileBrowserPanels(all, ['detached'], all)
    expect(result).toEqual({ toOpen: [], toClose: ['detached'], toPark: [] })
  })

  it('does not park a panel that is already hidden or destroyed', () => {
    const hidden = reconcileBrowserPanels(
      [makeInstance('hidden', { isVisible: false })],
      ['hidden', 'gone'],
    )
    expect(hidden.toPark).toEqual([])
  })
})

describe('browser panel bounds reporting', () => {
  it('treats a missing previous rect as a change', () => {
    expect(browserPanelBoundsChanged(null, { x: 1, y: 2, width: 3, height: 4 })).toBe(true)
  })

  it('detects origin-only movement with unchanged size', () => {
    const prev = roundBrowserPanelBounds({ x: 34.2, y: 80, width: 400, height: 600 })
    const next = roundBrowserPanelBounds({ x: 244.4, y: 80, width: 400, height: 600 })
    expect(prev).toEqual({ x: 34, y: 80, width: 400, height: 600 })
    expect(browserPanelBoundsChanged(prev, next)).toBe(true)
    expect(browserPanelBoundsChanged(next, { ...next })).toBe(false)
  })
})

describe('browser panel overlay suppression', () => {
  const panel = { x: 40, y: 80, width: 800, height: 600 }

  it('collapses reported bounds when a top-bar dropdown overlaps the panel', () => {
    const tabMenu = { x: 720, y: 36, width: 220, height: 220 }
    expect(browserPanelReportedBounds(panel, [tabMenu])).toEqual({
      ...panel,
      width: 0,
      height: 0,
    })
  })

  it('keeps native views attached when a sidebar menu does not overlap the panel', () => {
    const sessionMenu = { x: 8, y: 80, width: 240, height: 320 }
    expect(browserPanelReportedBounds({ x: 280, y: 80, width: 700, height: 600 }, [sessionMenu])).toEqual({
      x: 280,
      y: 80,
      width: 700,
      height: 600,
    })
  })

  it('keeps native views attached when no overlay is open', () => {
    expect(browserPanelReportedBounds(panel, [])).toEqual(panel)
  })

  it('parks native views on a blank URL so HTML empty state can paint', () => {
    expect(browserPanelReportedBounds(panel, [], 'about:blank')).toEqual({
      ...panel,
      width: 0,
      height: 0,
    })
  })

  it('does not treat a loaded page as blank', () => {
    expect(browserPanelReportedBounds(panel, [], 'https://example.com')).toEqual(panel)
  })
})

describe('isBlankBrowserUrl', () => {
  it('treats empty and about:blank as blank', () => {
    expect(isBlankBrowserUrl('')).toBe(true)
    expect(isBlankBrowserUrl('about:blank')).toBe(true)
    expect(isBlankBrowserUrl('about:blank#blocked')).toBe(true)
  })

  it('does not treat an unknown URL as blank', () => {
    expect(isBlankBrowserUrl(undefined)).toBe(false)
    expect(isBlankBrowserUrl(null)).toBe(false)
    expect(isBlankBrowserUrl('https://example.com')).toBe(false)
  })
})
