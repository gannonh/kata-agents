import { describe, expect, it } from 'bun:test'
import {
  BROWSER_ANNOTATION_VIEWPORT_MESSAGE_PREFIX,
  buildBrowserAnnotationViewportBridgeScript,
  isValidBrowserAnnotationViewportBridgeMarkers,
  isValidBrowserAnnotationViewportBridgeToken,
  liveAnnotationRect,
  placeAnnotationComposer,
  placeAnnotationMarker,
} from '../viewport-bridge'

const marker = {
  id: 'm1',
  index: 0,
  isFixed: false,
  rectPage: { x: 400, y: 800, width: 120, height: 40 },
  rectViewport: { x: 400, y: 200, width: 120, height: 40 },
}

describe('annotation marker geometry', () => {
  it('follows document scroll for non-fixed elements', () => {
    const before = placeAnnotationMarker(marker, { scrollX: 0, scrollY: 600 }, { width: 1280, height: 720 })
    const after = placeAnnotationMarker(marker, { scrollX: 0, scrollY: 650 }, { width: 1280, height: 720 })
    expect(before.visible).toBe(true)
    expect(after.visible).toBe(true)
    expect(after.y).toBe(before.y - 50)
    expect(after.x).toBe(before.x)
  })

  it('keeps fixed elements pinned to the viewport rect', () => {
    const placed = placeAnnotationMarker(
      { ...marker, isFixed: true },
      { scrollX: 80, scrollY: 900 },
      { width: 1280, height: 720 },
    )
    expect(placed.visible).toBe(true)
    expect(placed.x).toBe(400 + 120 / 2 - 12)
    expect(placed.y).toBe(200 + 40 - 12)
  })

  it('hides markers that leave the viewport after resize or scroll', () => {
    const scrolledAway = placeAnnotationMarker(marker, { scrollX: 0, scrollY: 0 }, { width: 1280, height: 720 })
    expect(scrolledAway.visible).toBe(false)
    const resizedAway = placeAnnotationMarker(
      { ...marker, rectPage: { x: 2000, y: 10, width: 40, height: 40 }, isFixed: false },
      { scrollX: 0, scrollY: 0 },
      { width: 320, height: 240 },
    )
    expect(resizedAway.visible).toBe(false)
  })

  it('anchors the pending composer below the element when there is room, otherwise above', () => {
    const live = liveAnnotationRect(
      {
        page: { scrollX: 0, scrollY: 600 },
        target: {
          isFixed: false,
          rectPage: { x: 40, y: 80, width: 100, height: 40 },
          rectViewport: { x: 40, y: 80, width: 100, height: 40 },
        },
      },
      { scrollX: 0, scrollY: 0 },
    )
    const below = placeAnnotationComposer(live, { width: 800, height: 720 })
    expect(below.below).toBe(true)
    expect(below.y).toBe(120)

    const cramped = placeAnnotationComposer(
      { x: 40, y: 500, width: 100, height: 40 },
      { width: 800, height: 560 },
    )
    expect(cramped.below).toBe(false)
    expect(cramped.y).toBe(500)
  })
})

describe('viewport bridge script', () => {
  it('rejects short or punctuation-laden tokens', () => {
    expect(isValidBrowserAnnotationViewportBridgeToken('short')).toBe(false)
    expect(isValidBrowserAnnotationViewportBridgeToken('token-with-spaces no')).toBe(false)
    expect(isValidBrowserAnnotationViewportBridgeToken('abcdefghijklmnop')).toBe(true)
  })

  it('rejects oversized marker payloads', () => {
    expect(isValidBrowserAnnotationViewportBridgeMarkers([marker])).toBe(true)
    expect(isValidBrowserAnnotationViewportBridgeMarkers(Array.from({ length: 51 }, (_, index) => ({
      ...marker,
      id: `m${index}`,
      index,
    })))).toBe(false)
  })

  it('is scoped, tokenized, and cleanup-safe', () => {
    const script = buildBrowserAnnotationViewportBridgeScript({
      enabled: true,
      emitViewport: true,
      markers: [marker],
      token: 'abcdefghijklmnop',
    })
    expect(script).toContain(BROWSER_ANNOTATION_VIEWPORT_MESSAGE_PREFIX)
    expect(script).toContain('abcdefghijklmnop')
    expect(script).toContain("attachShadow({ mode: 'closed' })")
    expect(script).toContain('data-kata-browser-annotation-overlay')
    expect(script).toContain('__kataBrowserAnnotationViewportBridge')
    expect(script).toContain('removeEventListener')
    expect(script).toContain('cancelAnimationFrame')

    const teardown = buildBrowserAnnotationViewportBridgeScript({
      enabled: false,
      emitViewport: false,
      markers: [],
      token: 'abcdefghijklmnop',
    })
    expect(teardown).toContain('delete globalThis[stateKey]')
    expect(teardown).toContain('removeOverlay')
  })
})
