import type { BrowserGrabCancelReason, BrowserGrabResult } from '@kata-sh/shared/protocol'
import { buildGuestOverlayScript } from './grab-guest-script'
import { clampGrabPayload } from './grab-payload'

type ActiveGrabOp = {
  opId: string
  browserTabId: string
  guestWebContentsId: number
  resolve: (result: BrowserGrabResult) => void
  cleanup: (preserveOverlay?: boolean) => void
  skipTeardown?: boolean
}

const GRAB_OP_TIMEOUT_MS = 120_000

function unwrapGuestGrabPayload(rawPayload: unknown): unknown {
  if (!rawPayload || typeof rawPayload !== 'object') {
    return rawPayload
  }
  const value = rawPayload as Record<string, unknown>
  if (value.__kataContextMenu === true && value.payload && typeof value.payload === 'object') {
    return value.payload
  }
  return rawPayload
}

function isGuestCancellationPayload(rawPayload: unknown): boolean {
  if (!rawPayload || typeof rawPayload !== 'object') {
    return false
  }
  const payload = rawPayload as Record<string, unknown>
  if (payload.__kataCancelled === true) {
    return true
  }
  if (payload.message !== 'cancelled') {
    return false
  }
  return !('page' in payload) && !('target' in payload) && !('payload' in payload)
}

function getGuestErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message
  }
  if (err && typeof err === 'object') {
    const message = (err as Record<string, unknown>).message
    if (typeof message === 'string') {
      return message
    }
  }
  return 'Selection failed'
}

export class BrowserGrabSessionController {
  private readonly activeGrabOps = new Map<string, ActiveGrabOp>()

  hasActiveGrabOp(browserTabId: string): boolean {
    return this.activeGrabOps.has(browserTabId)
  }

  cancelGrabOp(browserTabId: string, reason: BrowserGrabCancelReason): void {
    const op = this.activeGrabOps.get(browserTabId)
    if (!op) {
      return
    }
    op.resolve({ opId: op.opId, kind: 'cancelled', reason })
  }

  cancelAll(reason: BrowserGrabCancelReason): void {
    for (const browserTabId of this.activeGrabOps.keys()) {
      this.cancelGrabOp(browserTabId, reason)
    }
  }

  awaitGrabSelection(
    browserTabId: string,
    opId: string,
    guest: Electron.WebContents,
  ): Promise<BrowserGrabResult> {
    const existing = this.activeGrabOps.get(browserTabId)
    if (existing) {
      existing.skipTeardown = true
      existing.resolve({ opId: existing.opId, kind: 'cancelled', reason: 'user' })
    }

    return new Promise<BrowserGrabResult>((resolve) => {
      const guestWebContentsId = guest.id
      let settled = false

      const settleOnce = (result: BrowserGrabResult): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeoutId)
        op.cleanup(result.kind === 'selected')
        this.activeGrabOps.delete(browserTabId)
        resolve(result)
      }

      const awaitGuestClick = async (): Promise<void> => {
        try {
          const rawPayload = unwrapGuestGrabPayload(
            await guest.executeJavaScript(buildGuestOverlayScript('awaitClick')),
          )
          if (!rawPayload || typeof rawPayload !== 'object') {
            settleOnce({ opId, kind: 'cancelled', reason: 'user' })
            return
          }
          if (isGuestCancellationPayload(rawPayload)) {
            settleOnce({ opId, kind: 'cancelled', reason: 'user' })
            return
          }
          const payload = clampGrabPayload(rawPayload)
          if (!payload) {
            settleOnce({ opId, kind: 'error', reason: 'Guest returned invalid payload structure' })
            return
          }
          settleOnce({
            opId,
            kind: 'selected',
            payload,
          })
        } catch (err) {
          const message = getGuestErrorMessage(err)
          if (message.includes('cancelled')) {
            settleOnce({ opId, kind: 'cancelled', reason: 'user' })
          } else {
            settleOnce({ opId, kind: 'error', reason: message })
          }
        }
      }

      const handleNavigation = (
        _event: unknown,
        _url: unknown,
        _isInPlace: unknown,
        isMainFrame: boolean,
      ): void => {
        if (isMainFrame) {
          settleOnce({ opId, kind: 'cancelled', reason: 'navigation' })
        }
      }

      const handleDestroyed = (): void => {
        settleOnce({ opId, kind: 'cancelled', reason: 'evicted' })
      }

      const timeoutId = setTimeout(() => {
        settleOnce({ opId, kind: 'cancelled', reason: 'timeout' })
      }, GRAB_OP_TIMEOUT_MS)
      if (typeof timeoutId.unref === 'function') {
        timeoutId.unref()
      }

      guest.on('did-start-navigation', handleNavigation)
      guest.on('destroyed', handleDestroyed)

      const cleanup = (preserveOverlay?: boolean): void => {
        try {
          guest.off('did-start-navigation', handleNavigation)
          guest.off('destroyed', handleDestroyed)
        } catch {
          // Guest may already be destroyed.
        }
        if (op.skipTeardown || preserveOverlay) {
          return
        }
        try {
          if (!guest.isDestroyed()) {
            void guest.executeJavaScript(buildGuestOverlayScript('teardown'))
          }
        } catch {
          // Best-effort overlay removal
        }
      }

      const op: ActiveGrabOp = {
        opId,
        browserTabId,
        guestWebContentsId,
        resolve: settleOnce,
        cleanup,
      }
      this.activeGrabOps.set(browserTabId, op)
      void awaitGuestClick()
    })
  }
}
