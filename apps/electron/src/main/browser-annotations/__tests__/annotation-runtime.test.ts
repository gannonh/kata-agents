import { describe, expect, it } from 'bun:test'
import type { BrowserGrabPayload } from '@kata-sh/shared/protocol'
import { BROWSER_ANNOTATION_VIEWPORT_MESSAGE_PREFIX } from '../../../shared/browser-annotations/viewport-bridge'
import { BrowserAnnotationRuntime } from '../annotation-runtime'
import type { AnnotationRuntimeGuest, AnnotationRuntimePage } from '../annotation-runtime'

function makePayload(): BrowserGrabPayload {
  return {
    page: {
      sanitizedUrl: 'https://example.com/pricing',
      title: 'Pricing',
      viewportWidth: 1280,
      viewportHeight: 720,
      scrollX: 0,
      scrollY: 0,
      devicePixelRatio: 2,
      capturedAt: '2026-05-15T00:00:00.000Z',
    },
    target: {
      tagName: 'button',
      selector: 'main > button.primary',
      textSnippet: 'Start free trial',
      htmlSnippet: '<button class="primary">Start free trial</button>',
      attributes: { class: 'primary' },
      accessibility: {
        role: 'button',
        accessibleName: 'Start free trial',
        ariaLabel: null,
        ariaLabelledBy: null,
      },
      rectViewport: { x: 10, y: 20, width: 30, height: 40 },
      rectPage: { x: 10, y: 20, width: 30, height: 40 },
      computedStyles: {
        display: 'flex',
        position: 'relative',
        width: '30px',
        height: '40px',
        margin: '0px',
        padding: '0px',
        color: 'rgb(0, 0, 0)',
        backgroundColor: 'rgb(255, 255, 255)',
        border: '0px none',
        borderRadius: '0px',
        fontFamily: 'sans-serif',
        fontSize: '14px',
        fontWeight: '400',
        lineHeight: '20px',
        textAlign: 'left',
        zIndex: 'auto',
      },
    },
    nearbyText: [],
    ancestorPath: [],
    screenshot: null,
  }
}

function createGuest(options?: {
  executeJavaScript?: (code: string) => Promise<unknown>
}): AnnotationRuntimeGuest & { isolatedScripts: string[]; overlayScripts: string[] } {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {}
  const isolatedScripts: string[] = []
  const overlayScripts: string[] = []
  return {
    id: 1,
    isolatedScripts,
    overlayScripts,
    isDestroyed: () => false,
    executeJavaScript: async (code: string) => {
      overlayScripts.push(code)
      if (options?.executeJavaScript) {
        return options.executeJavaScript(code)
      }
      if (code.includes('Grab not armed')) {
        return new Promise(() => {})
      }
      return true
    },
    executeJavaScriptInIsolatedWorld: async (worldId, scripts) => {
      expect(worldId).toBe(1207)
      isolatedScripts.push(scripts[0]?.code ?? '')
      return true
    },
    on: (event, listener) => {
      listeners[event] = listeners[event] ?? []
      listeners[event].push(listener)
    },
    off: (event, listener) => {
      listeners[event] = (listeners[event] ?? []).filter((item) => item !== listener)
    },
  }
}

function createPage(): AnnotationRuntimePage {
  const guest = createGuest()
  return {
    guest,
    overlay: createGuest(),
    viewportSize: () => ({ width: 800, height: 600 }),
  }
}

function waitForMode(runtime: BrowserAnnotationRuntime, instanceId: string, mode: string): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (runtime.getState(instanceId).mode === mode) resolve()
    }
    runtime.onStateChange(check)
    check()
  })
}

describe('BrowserAnnotationRuntime', () => {
  const labels = () => ({
    dialog: 'Add browser annotation',
    comment: 'Comment',
    placeholder: 'What should change?',
    intent: 'Intent',
    change: 'Change',
    fix: 'Fix',
    question: 'Question',
    approve: 'Approve',
    cancel: 'Cancel',
    save: 'Add',
  })

  it('returns not-ready when the instance has no page', async () => {
    const runtime = new BrowserAnnotationRuntime(() => null, labels)
    expect(await runtime.setEnabled('missing', true)).toEqual({ ok: false, reason: 'not-ready' })
  })

  it('persists notes per instance and isolates workspaces by instance id', () => {
    const pages = new Map<string, AnnotationRuntimePage>([
      ['page-a', createPage()],
      ['page-b', createPage()],
    ])
    const runtime = new BrowserAnnotationRuntime((id) => pages.get(id) ?? null, labels)
    const payload = makePayload()

    expect(runtime.add('page-a', '   ', 'change', payload)).toBeNull()
    expect(runtime.add('page-a', 'First note', 'change', payload)?.comment).toBe('First note')
    expect(runtime.add('page-a', 'Second note', 'fix', payload)?.intent).toBe('fix')
    expect(runtime.add('page-b', 'Other instance', 'question', payload)?.browserPageId).toBe('page-b')

    expect(runtime.list('page-a').map((item) => item.comment)).toEqual(['First note', 'Second note'])
    expect(runtime.list('page-b').map((item) => item.comment)).toEqual(['Other instance'])
    expect(runtime.list('page-a').every((item) => item.payload.screenshot === null)).toBe(true)

    expect(runtime.delete('page-a', runtime.list('page-a')[0]!.id)).toBe(true)
    expect(runtime.list('page-a')).toHaveLength(1)
    runtime.clear('page-a')
    expect(runtime.list('page-a')).toEqual([])
    expect(runtime.list('page-b')).toHaveLength(1)
  })

  it('installs numbered markers in an isolated world and hides them after a document change', async () => {
    const guest = createGuest()
    const runtime = new BrowserAnnotationRuntime(() => ({
      guest,
      overlay: createGuest(),
      viewportSize: () => ({ width: 800, height: 600 }),
    }), labels)
    const payload = makePayload()
    const added = runtime.add('page-a', 'Keep this note', 'change', payload)
    expect(added).not.toBeNull()
    await Promise.resolve()
    expect(guest.isolatedScripts.some((code) => (
      code.includes('__kataBrowserAnnotationViewportBridge') && code.includes(added!.id)
    ))).toBe(true)

    runtime.handleNavigated('page-a', true)
    await Promise.resolve()
    const last = guest.isolatedScripts.at(-1) ?? ''
    expect(last).toContain('const markers = []')
    expect(last).not.toContain(added!.id)
    expect(runtime.list('page-a')).toHaveLength(1)
  })

  it('rejects a second enable while selecting and turns off from the toggle', async () => {
    const page = createPage()
    const runtime = new BrowserAnnotationRuntime((id) => (id === 'page-a' ? page : null), labels)

    expect(await runtime.setEnabled('page-a', true)).toEqual({ ok: true })
    await waitForMode(runtime, 'page-a', 'selecting')
    expect(await runtime.setEnabled('page-a', true)).toEqual({ ok: false, reason: 'already-active' })

    expect(await runtime.setEnabled('page-a', false)).toEqual({ ok: true })
    expect(runtime.getState('page-a').mode).toBe('idle')
  })

  it('keeps tray marker numbers stable and restores markers when returning to the captured URL', async () => {
    let currentUrl = 'https://example.com/pricing'
    const guest = createGuest()
    const runtime = new BrowserAnnotationRuntime(() => ({
      guest,
      overlay: createGuest(),
      viewportSize: () => ({ width: 800, height: 600 }),
      currentUrl: () => currentUrl,
    }), labels)
    const first = runtime.add('page-a', 'First note', 'change', makePayload())
    const second = runtime.add('page-a', 'Second note', 'fix', makePayload())
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()

    currentUrl = 'https://example.com/checkout'
    runtime.handleNavigated('page-a', true)
    await Promise.resolve()
    const hidden = guest.isolatedScripts.at(-1) ?? ''
    expect(hidden).toContain('const markers = []')
    expect(hidden).not.toContain(first!.id)
    expect(hidden).not.toContain(second!.id)

    const third = runtime.add('page-a', 'Third note', 'question', {
      ...makePayload(),
      page: { ...makePayload().page, sanitizedUrl: 'https://example.com/checkout' },
    })
    await Promise.resolve()
    const afterThird = guest.isolatedScripts.at(-1) ?? ''
    expect(afterThird).toContain(third!.id)
    expect(afterThird).toContain('"index":2')
    expect(runtime.list('page-a')).toHaveLength(3)

    currentUrl = 'https://example.com/pricing'
    runtime.handleNavigated('page-a', true)
    await Promise.resolve()
    const restored = guest.isolatedScripts.at(-1) ?? ''
    expect(restored).toContain(first!.id)
    expect(restored).toContain(second!.id)
    expect(restored).not.toContain(third!.id)
  })

  it('persists a submitted composer note from the select loop', async () => {
    const payload = makePayload()
    let grabCalls = 0
    const guest = createGuest({
      executeJavaScript: async (code) => {
        if (code.includes('Grab not armed')) {
          grabCalls += 1
          if (grabCalls === 1) return payload
          return new Promise(() => {})
        }
        return true
      },
    })
    const overlay = createGuest({
      executeJavaScript: async (code) => {
        if (code.includes('__kataAnnotationComposerResolve = resolve')) {
          return { kind: 'submit', comment: 'Make the CTA clearer', intent: 'fix' }
        }
        return true
      },
    })
    const runtime = new BrowserAnnotationRuntime(() => ({
      guest,
      overlay,
      viewportSize: () => ({ width: 800, height: 600 }),
    }), labels)

    expect(await runtime.setEnabled('page-a', true)).toEqual({ ok: true })
    await waitForMode(runtime, 'page-a', 'selecting')
    await new Promise<void>((resolve) => {
      const check = () => {
        if (runtime.list('page-a').length === 1) resolve()
      }
      runtime.onStateChange(check)
      check()
    })
    expect(runtime.list('page-a')[0]?.comment).toBe('Make the CTA clearer')
    expect(runtime.list('page-a')[0]?.intent).toBe('fix')
  })

  it('drops forged viewport messages and repositions the composer for a valid token', async () => {
    const payload = makePayload()
    const guest = createGuest({
      executeJavaScript: async (code) => {
        if (code.includes('Grab not armed')) return new Promise(() => {})
        return true
      },
    })
    const overlay = createGuest({
      executeJavaScript: async (code) => {
        if (code.includes('__kataAnnotationComposerResolve = resolve')) {
          return new Promise(() => {})
        }
        return true
      },
    })
    let grabCalls = 0
    guest.executeJavaScript = async (code: string) => {
      if (code.includes('Grab not armed')) {
        grabCalls += 1
        if (grabCalls === 1) return payload
        return new Promise(() => {})
      }
      return true
    }
    const runtime = new BrowserAnnotationRuntime(() => ({
      guest,
      overlay,
      viewportSize: () => ({ width: 800, height: 600 }),
    }), labels)

    expect(await runtime.setEnabled('page-a', true)).toEqual({ ok: true })
    await waitForMode(runtime, 'page-a', 'composing')
    const tokenMatch = guest.isolatedScripts.join('\n').match(/const token = "([^"]+)";/)
    expect(tokenMatch?.[1]).toBeTruthy()
    const token = tokenMatch![1]!

    expect(runtime.handleConsoleMessage('page-a', 'not-a-bridge')).toBe(false)
    expect(runtime.handleConsoleMessage(
      'page-a',
      `${BROWSER_ANNOTATION_VIEWPORT_MESSAGE_PREFIX}forged-token-value:${JSON.stringify({ scrollX: 9, scrollY: 9 })}`,
    )).toBe(true)
    const before = overlay.overlayScripts.filter((code) => code.includes('annotation-composer')).length

    expect(runtime.handleConsoleMessage(
      'page-a',
      `${BROWSER_ANNOTATION_VIEWPORT_MESSAGE_PREFIX}${token}:${JSON.stringify({ scrollX: 40, scrollY: 80 })}`,
    )).toBe(true)
    await Promise.resolve()
    const after = overlay.overlayScripts.filter((code) => (
      code.includes("card.style.left = 10 + 'px'") || code.includes('translate')
    ))
    expect(after.length).toBeGreaterThan(before)
  })

  it('tears down grab overlay, viewport markers, and stored notes on destroy', async () => {
    const guest = createGuest()
    const overlay = createGuest()
    const runtime = new BrowserAnnotationRuntime(() => ({
      guest,
      overlay,
      viewportSize: () => ({ width: 800, height: 600 }),
    }), labels)
    expect(runtime.add('page-a', 'Keep this note', 'change', makePayload())).not.toBeNull()
    await Promise.resolve()
    guest.overlayScripts.length = 0
    overlay.overlayScripts.length = 0

    runtime.destroy('page-a')
    await Promise.resolve()
    expect(runtime.list('page-a')).toEqual([])
    expect(runtime.getState('page-a').mode).toBe('idle')
    expect(guest.overlayScripts.some((code) => code.includes('__kataGrab'))).toBe(true)
    expect(guest.isolatedScripts.some((code) => code.includes('const enabled = false'))).toBe(true)
  })

  it('hides markers when only the query string changes', async () => {
    let currentUrl = 'https://example.com/record?id=1'
    const guest = createGuest()
    const runtime = new BrowserAnnotationRuntime(() => ({
      guest,
      overlay: createGuest(),
      viewportSize: () => ({ width: 800, height: 600 }),
      currentUrl: () => currentUrl,
    }), labels)
    const added = runtime.add('page-a', 'Keep this note', 'change', makePayload())
    expect(added).not.toBeNull()
    await Promise.resolve()

    currentUrl = 'https://example.com/record?id=2'
    runtime.handleNavigated('page-a', true)
    await Promise.resolve()
    const last = guest.isolatedScripts.at(-1) ?? ''
    expect(last).toContain('const markers = []')
    expect(last).not.toContain(added!.id)
    expect(runtime.list('page-a')).toHaveLength(1)
  })

  it('does not persist a composer submit after document navigation', async () => {
    const payload = makePayload()
    let resolveComposer: ((value: unknown) => void) | undefined
    let grabCalls = 0
    const guest = createGuest({
      executeJavaScript: async (code) => {
        if (code.includes('Grab not armed')) {
          grabCalls += 1
          if (grabCalls === 1) return payload
          return new Promise(() => {})
        }
        return true
      },
    })
    const overlay = createGuest({
      executeJavaScript: async (code) => {
        if (code.includes('__kataAnnotationComposerResolve = resolve')) {
          return new Promise((resolve) => {
            resolveComposer = resolve
          })
        }
        return true
      },
    })
    let currentUrl = 'https://example.com/pricing'
    const runtime = new BrowserAnnotationRuntime(() => ({
      guest,
      overlay,
      viewportSize: () => ({ width: 800, height: 600 }),
      currentUrl: () => currentUrl,
    }), labels)

    expect(await runtime.setEnabled('page-a', true)).toEqual({ ok: true })
    await waitForMode(runtime, 'page-a', 'composing')
    for (let i = 0; i < 20 && !resolveComposer; i += 1) {
      await Promise.resolve()
    }
    expect(resolveComposer).toBeDefined()
    currentUrl = 'https://example.com/checkout'
    runtime.handleNavigated('page-a', true)
    resolveComposer?.({ kind: 'submit', comment: 'stale note from previous page', intent: 'fix' })
    await Promise.resolve()
    await Promise.resolve()
    expect(runtime.list('page-a')).toEqual([])
  })
})
