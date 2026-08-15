import { describe, expect, it } from 'bun:test'
import { BrowserGrabSessionController } from '../grab-session-controller'

function createGuest(options?: { payload?: unknown; executeError?: Error }) {
  const listeners: Record<string, Function[]> = {}
  return {
    id: 42,
    isDestroyed: () => false,
    executeJavaScript: async (script: string) => {
      if (options?.executeError) throw options.executeError
      if (options?.payload !== undefined) return options.payload
      if (script.includes('Grab not armed') || script.includes('__kataContextMenu')) {
        return { page: { sanitizedUrl: 'https://example.com' }, target: { tagName: 'button' } }
      }
      return true
    },
    on: (event: string, cb: Function) => {
      listeners[event] = listeners[event] ?? []
      listeners[event].push(cb)
    },
    off: (event: string, cb: Function) => {
      listeners[event] = (listeners[event] ?? []).filter((fn) => fn !== cb)
    },
    emit(event: string, ...args: unknown[]) {
      for (const cb of listeners[event] ?? []) cb(...args)
    },
  }
}

describe('BrowserGrabSessionController', () => {
  it('cancels an in-flight selection on main-frame navigation and cleans up', async () => {
    const controller = new BrowserGrabSessionController()
    const guest = createGuest({
      payload: new Promise(() => {}),
    })
    const pending = controller.awaitGrabSelection('page-1', 'op-1', guest as unknown as Electron.WebContents)
    guest.emit('did-start-navigation', {}, 'https://example.com/next', false, true)
    const result = await pending
    expect(result).toEqual({ opId: 'op-1', kind: 'cancelled', reason: 'navigation' })
    expect(controller.hasActiveGrabOp('page-1')).toBe(false)
  })

  it('does not cancel on subframe navigation', async () => {
    const controller = new BrowserGrabSessionController()
    let resolvePayload: (value: unknown) => void = () => {}
    const guest = createGuest({
      payload: new Promise((resolve) => {
        resolvePayload = resolve
      }),
    })
    const pending = controller.awaitGrabSelection('page-1', 'op-1', guest as unknown as Electron.WebContents)
    guest.emit('did-start-navigation', {}, 'https://ads.example/iframe', false, false)
    expect(controller.hasActiveGrabOp('page-1')).toBe(true)
    resolvePayload({ __kataCancelled: true })
    const result = await pending
    expect(result.kind).toBe('cancelled')
  })

  it('treats a right-click context-menu wrapper as a normal selection', async () => {
    const controller = new BrowserGrabSessionController()
    const guest = createGuest({
      payload: {
        __kataContextMenu: true,
        payload: {
          page: { sanitizedUrl: 'https://example.com/page', title: 'Example' },
          target: { tagName: 'button', selector: 'button.primary', textSnippet: 'Go' },
        },
      },
    })
    const result = await controller.awaitGrabSelection('page-1', 'op-2', guest as unknown as Electron.WebContents)
    expect(result.kind).toBe('selected')
    if (result.kind === 'selected') {
      expect(result.payload.target.tagName).toBe('button')
      expect(result.payload.screenshot).toBeNull()
    }
  })
})
