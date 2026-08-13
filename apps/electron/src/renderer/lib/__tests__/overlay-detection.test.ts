import { afterEach, describe, expect, it } from 'bun:test'
import { setDismissibleLayerBridge } from '../dismissible-layer-bridge'
import { hasOpenOverlay, getOpenOverlayRects } from '../overlay-detection'

const originalDocument = globalThis.document

afterEach(() => {
  setDismissibleLayerBridge(null)
  ;(globalThis as unknown as { document: Document | undefined }).document = originalDocument
})

describe('hasOpenOverlay', () => {
  it('returns true when dismissible stack has open layers', () => {
    setDismissibleLayerBridge({
      registerLayer: () => () => {},
      hasOpenLayers: () => true,
      getTopLayer: () => ({ id: 'island-1', type: 'island', priority: 200 }),
      closeTop: () => true,
      handleEscape: () => true,
    })

    ;(globalThis as unknown as { document: { querySelector: (_selector: string) => null } }).document = {
      querySelector: () => null,
    }

    expect(hasOpenOverlay()).toBe(true)
  })

  it('returns true when an island dialog is open', () => {
    ;(globalThis as unknown as { document: { querySelector: (selector: string) => object | null } }).document = {
      querySelector: (selector: string) => {
        if (selector.includes('[data-ca-island-dialog="true"][data-state="open"]')) {
          return {}
        }

        return null
      },
    }

    expect(hasOpenOverlay()).toBe(true)
  })

  it('returns false when no overlays are open', () => {
    ;(globalThis as unknown as { document: { querySelector: (_selector: string) => null } }).document = {
      querySelector: () => null,
    }

    expect(hasOpenOverlay()).toBe(false)
  })
})

describe('getOpenOverlayRects', () => {
  it('collects visible overlay rectangles', () => {
    ;(globalThis as unknown as { document: { querySelectorAll: (_selector: string) => Array<{ getBoundingClientRect: () => DOMRect }> } }).document = {
      querySelectorAll: () => [
        {
          getBoundingClientRect: () => ({ x: 720, y: 36, width: 220, height: 220 } as DOMRect),
        },
        {
          getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0 } as DOMRect),
        },
      ],
    }

    expect(getOpenOverlayRects()).toEqual([{ x: 720, y: 36, width: 220, height: 220 }])
  })

  it('collects open menu rectangles without a data-slot attribute', () => {
    ;(globalThis as unknown as { document: { querySelectorAll: (selector: string) => Array<{ getBoundingClientRect: () => DOMRect }> } }).document = {
      querySelectorAll: (selector: string) => {
        if (!selector.includes('[role="menu"]')) return []
        return [
          {
            getBoundingClientRect: () => ({ x: 640, y: 40, width: 180, height: 160 } as DOMRect),
          },
        ]
      },
    }

    expect(getOpenOverlayRects()).toEqual([{ x: 640, y: 40, width: 180, height: 160 }])
  })

  it('ignores closed overlay nodes that remain in the DOM', () => {
    ;(globalThis as unknown as { document: { querySelectorAll: (_selector: string) => Array<{ getAttribute: (name: string) => string; getBoundingClientRect: () => DOMRect }> } }).document = {
      querySelectorAll: () => [
        {
          getAttribute: (name: string) => name === 'data-state' ? 'closed' : '',
          getBoundingClientRect: () => ({ x: 640, y: 40, width: 180, height: 160 } as DOMRect),
        },
      ],
    }

    expect(getOpenOverlayRects()).toEqual([])
  })
})
