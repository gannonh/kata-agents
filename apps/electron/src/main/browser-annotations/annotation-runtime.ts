import {
  isBrowserAnnotationIntent,
  normalizeAnnotationComment,
  type BrowserAnnotationIntent,
  type BrowserAnnotationState,
  type BrowserAnnotateMode,
  type BrowserGrabPayload,
  type BrowserPageAnnotation,
  type BrowserSetAnnotateModeResult,
} from '@kata-sh/shared/protocol'
import {
  BROWSER_ANNOTATION_VIEWPORT_BRIDGE_WORLD_ID,
  BROWSER_ANNOTATION_VIEWPORT_MESSAGE_PREFIX,
  buildBrowserAnnotationViewportBridgeScript,
  createBrowserAnnotationViewportToken,
  isValidBrowserAnnotationViewportBridgeToken,
  liveAnnotationRect,
  placeAnnotationComposer,
  type ViewportScroll,
} from '../../shared/browser-annotations/viewport-bridge'
import {
  createBrowserAnnotationId,
  createBrowserAnnotationPayload,
  createBrowserAnnotationStore,
  type BrowserAnnotationStore,
} from '../../shared/browser-annotations/store'
import { BrowserGrabSessionController } from './grab-session-controller'
import { buildGuestOverlayScript } from './grab-guest-script'
import { sanitizeGrabUrl } from './grab-payload'
import {
  buildAwaitAnnotationComposerScript,
  buildHideAnnotationComposerScript,
  buildPositionAnnotationComposerScript,
  buildShowAnnotationComposerScript,
  type AnnotationComposerLabels,
  type AnnotationComposerOutcome,
} from './composer-overlay'

export type AnnotationRuntimeGuest = {
  id: number
  isDestroyed: () => boolean
  executeJavaScript: (code: string) => Promise<unknown>
  executeJavaScriptInIsolatedWorld: (
    worldId: number,
    scripts: Array<{ code: string }>,
  ) => Promise<unknown>
  on: (event: string, listener: (...args: unknown[]) => void) => void
  off: (event: string, listener: (...args: unknown[]) => void) => void
}

export type AnnotationRuntimePage = {
  guest: AnnotationRuntimeGuest
  overlay: AnnotationRuntimeGuest
  viewportSize: () => { width: number; height: number }
  currentUrl?: () => string
}

type SessionState = {
  mode: BrowserAnnotateMode
  generation: number
  pending: BrowserGrabPayload | null
  viewport: ViewportScroll
  token: string
  loopRunning: boolean
  hiddenMarkerIds: Set<string>
}

export class BrowserAnnotationRuntime {
  private readonly store: BrowserAnnotationStore
  private readonly grab = new BrowserGrabSessionController()
  private readonly sessions = new Map<string, SessionState>()
  private stateCallback: ((state: BrowserAnnotationState) => void) | null = null

  constructor(
    private readonly resolvePage: (instanceId: string) => AnnotationRuntimePage | null,
    private readonly labels: () => AnnotationComposerLabels,
  ) {
    this.store = createBrowserAnnotationStore()
  }

  onStateChange(callback: (state: BrowserAnnotationState) => void): void {
    this.stateCallback = callback
  }

  getState(instanceId: string): BrowserAnnotationState {
    const session = this.sessions.get(instanceId)
    return {
      instanceId,
      mode: session?.mode ?? 'idle',
      annotations: this.store.list(instanceId),
      pendingLabel: pendingLabel(session?.pending ?? null),
    }
  }

  async setEnabled(instanceId: string, enabled: boolean): Promise<BrowserSetAnnotateModeResult> {
    const page = this.resolvePage(instanceId)
    if (!page) return { ok: false, reason: 'not-ready' }
    if (!enabled) {
      this.stop(instanceId)
      return { ok: true }
    }
    const existing = this.sessions.get(instanceId)
    if (existing && existing.mode !== 'idle') {
      return { ok: false, reason: 'already-active' }
    }
    this.ensure(instanceId)
    void this.runLoop(instanceId)
    return { ok: true }
  }

  cancelPending(instanceId: string): void {
    const session = this.sessions.get(instanceId)
    if (!session || session.mode !== 'composing') return
    const page = this.resolvePage(instanceId)
    if (page && !page.overlay.isDestroyed()) {
      void page.overlay.executeJavaScript(buildHideAnnotationComposerScript())
    }
  }

  add(instanceId: string, comment: string, intent: BrowserAnnotationIntent, payload: BrowserGrabPayload): BrowserPageAnnotation | null {
    const normalized = normalizeAnnotationComment(comment)
    if (!normalized) return null
    const annotation = this.store.add({
      id: createBrowserAnnotationId(),
      browserPageId: instanceId,
      comment: normalized,
      intent,
      createdAt: new Date().toISOString(),
      payload: createBrowserAnnotationPayload(payload),
    })
    this.emit(instanceId)
    void this.syncMarkers(instanceId)
    return annotation
  }

  delete(instanceId: string, annotationId: string): boolean {
    const deleted = this.store.delete(instanceId, annotationId)
    if (deleted) {
      this.emit(instanceId)
      void this.syncMarkers(instanceId)
    }
    return deleted
  }

  clear(instanceId: string): void {
    this.store.clear(instanceId)
    this.emit(instanceId)
    void this.syncMarkers(instanceId)
  }

  list(instanceId: string): BrowserPageAnnotation[] {
    return this.store.list(instanceId)
  }

  destroy(instanceId: string): void {
    this.stop(instanceId)
    this.store.clear(instanceId)
    this.sessions.delete(instanceId)
  }

  handleNavigated(instanceId: string, documentChanged = false): void {
    const session = this.sessions.get(instanceId)
    if (!session) return
    this.grab.cancelGrabOp(instanceId, 'navigation')
    if (session.mode === 'composing') {
      const page = this.resolvePage(instanceId)
      if (page && !page.overlay.isDestroyed()) {
        void page.overlay.executeJavaScript(buildHideAnnotationComposerScript())
      }
    }
    if (session.mode !== 'idle') {
      session.mode = 'selecting'
      session.pending = null
      this.emit(instanceId)
    }
    if (documentChanged) {
      const currentUrl = sanitizeGrabUrl(this.resolvePage(instanceId)?.currentUrl?.() ?? '')
      session.hiddenMarkerIds = new Set(
        this.store.list(instanceId)
          .filter((item) => item.payload.page.sanitizedUrl !== currentUrl)
          .map((item) => item.id),
      )
    }
    void this.syncMarkers(instanceId)
  }

  handleConsoleMessage(instanceId: string, message: string): boolean {
    if (!message.startsWith(BROWSER_ANNOTATION_VIEWPORT_MESSAGE_PREFIX)) return false
    const rest = message.slice(BROWSER_ANNOTATION_VIEWPORT_MESSAGE_PREFIX.length)
    const delimiterIdx = rest.indexOf(':')
    if (delimiterIdx <= 0) return true
    const token = rest.slice(0, delimiterIdx)
    const session = this.sessions.get(instanceId)
    if (!session || token !== session.token || !isValidBrowserAnnotationViewportBridgeToken(token)) return true
    try {
      const parsed = JSON.parse(rest.slice(delimiterIdx + 1)) as ViewportScroll
      if (typeof parsed.scrollX === 'number' && typeof parsed.scrollY === 'number') {
        session.viewport = parsed
        if (session.mode === 'composing' && session.pending) {
          void this.positionComposer(instanceId, session.pending, parsed)
        }
      }
    } catch {
      // Ignore malformed guest viewport payloads.
    }
    return true
  }

  private ensure(instanceId: string): SessionState {
    const existing = this.sessions.get(instanceId)
    if (existing) return existing
    const created: SessionState = {
      mode: 'idle',
      generation: 0,
      pending: null,
      viewport: { scrollX: 0, scrollY: 0 },
      token: createBrowserAnnotationViewportToken(),
      loopRunning: false,
      hiddenMarkerIds: new Set(),
    }
    this.sessions.set(instanceId, created)
    return created
  }

  private stop(instanceId: string): void {
    const session = this.sessions.get(instanceId)
    if (!session) return
    session.generation += 1
    session.mode = 'idle'
    session.pending = null
    session.loopRunning = false
    this.grab.cancelGrabOp(instanceId, 'user')
    const page = this.resolvePage(instanceId)
    if (page) {
      if (!page.guest.isDestroyed()) {
        void page.guest.executeJavaScript(buildGuestOverlayScript('teardown'))
        void this.injectViewportBridge(page.guest, {
          enabled: false,
          emitViewport: false,
          markers: [],
          token: session.token,
        })
      }
      if (!page.overlay.isDestroyed()) {
        void page.overlay.executeJavaScript(buildHideAnnotationComposerScript())
      }
    }
    this.emit(instanceId)
    void this.syncMarkers(instanceId)
  }

  private async runLoop(instanceId: string): Promise<void> {
    const session = this.ensure(instanceId)
    if (session.loopRunning) return
    session.loopRunning = true
    session.mode = 'selecting'
    const generation = ++session.generation
    this.emit(instanceId)
    try {
      while (this.sessions.get(instanceId)?.generation === generation) {
        const page = this.resolvePage(instanceId)
        if (!page || page.guest.isDestroyed()) {
          session.mode = 'idle'
          break
        }
        session.mode = 'selecting'
        session.pending = null
        this.emit(instanceId)
        const armed = await this.arm(page)
        if (!armed || this.sessions.get(instanceId)?.generation !== generation) break
        const opId = `annotate-${generation}-${Date.now()}`
        const result = await this.grab.awaitGrabSelection(
          instanceId,
          opId,
          page.guest as unknown as Electron.WebContents,
        )
        if (this.sessions.get(instanceId)?.generation !== generation) break
        if (result.kind !== 'selected') {
          if (result.kind === 'cancelled' && result.reason === 'navigation') {
            continue
          }
          session.mode = 'idle'
          break
        }
        session.mode = 'composing'
        session.pending = result.payload
        this.emit(instanceId)
        await this.syncMarkers(instanceId)
        const outcome = await this.collectComposer(instanceId, page, result.payload)
        if (this.sessions.get(instanceId)?.generation !== generation) break
        if (outcome.kind === 'submit') {
          const intent = isBrowserAnnotationIntent(outcome.intent) ? outcome.intent : 'change'
          this.add(instanceId, outcome.comment, intent, result.payload)
        }
        session.pending = null
      }
    } finally {
      if (this.sessions.get(instanceId)?.generation === generation) {
        session.mode = 'idle'
        session.pending = null
        session.loopRunning = false
        const page = this.resolvePage(instanceId)
        if (page && !page.guest.isDestroyed()) {
          void page.guest.executeJavaScript(buildGuestOverlayScript('teardown'))
        }
        this.emit(instanceId)
        void this.syncMarkers(instanceId)
      } else {
        session.loopRunning = false
      }
    }
  }

  private async arm(page: AnnotationRuntimePage): Promise<boolean> {
    try {
      await page.guest.executeJavaScript(buildGuestOverlayScript('arm'))
      return true
    } catch {
      return false
    }
  }

  private async collectComposer(
    instanceId: string,
    page: AnnotationRuntimePage,
    payload: BrowserGrabPayload,
  ): Promise<AnnotationComposerOutcome> {
    if (page.overlay.isDestroyed()) return { kind: 'cancel' }
    const live = liveAnnotationRect(payload, this.ensure(instanceId).viewport)
    const anchor = placeAnnotationComposer(live, page.viewportSize())
    const label =
      payload.target.accessibility.accessibleName ||
      payload.target.textSnippet ||
      payload.target.tagName
    try {
      await page.overlay.executeJavaScript(buildShowAnnotationComposerScript({
        label,
        selector: payload.target.selector,
        labels: this.labels(),
        anchor,
      }))
      const raw = await page.overlay.executeJavaScript(buildAwaitAnnotationComposerScript())
      return parseComposerOutcome(raw)
    } catch {
      return { kind: 'cancel' }
    }
  }

  private async positionComposer(instanceId: string, payload: BrowserGrabPayload, viewport: ViewportScroll): Promise<void> {
    const page = this.resolvePage(instanceId)
    if (!page || page.overlay.isDestroyed()) return
    const live = liveAnnotationRect(payload, viewport)
    const anchor = placeAnnotationComposer(live, page.viewportSize())
    try {
      await page.overlay.executeJavaScript(buildPositionAnnotationComposerScript(anchor))
    } catch {
      // Overlay may have been torn down.
    }
  }

  private async syncMarkers(instanceId: string): Promise<void> {
    const page = this.resolvePage(instanceId)
    const session = this.ensure(instanceId)
    if (!page || page.guest.isDestroyed()) return
    const markers = this.store.list(instanceId).flatMap((annotation, index) => (
      session.hiddenMarkerIds.has(annotation.id)
        ? []
        : [{
          id: annotation.id,
          index,
          isFixed: annotation.payload.target.isFixed === true,
          rectPage: annotation.payload.target.rectPage,
          rectViewport: annotation.payload.target.rectViewport,
        }]
    ))
    const enabled = markers.length > 0 || session.mode !== 'idle'
    try {
      await this.injectViewportBridge(page.guest, {
        enabled,
        emitViewport: session.mode === 'composing',
        markers,
        token: session.token,
      })
    } catch {
      // Guest may have navigated away.
    }
  }

  private async injectViewportBridge(
    guest: AnnotationRuntimeGuest,
    options: Parameters<typeof buildBrowserAnnotationViewportBridgeScript>[0],
  ): Promise<void> {
    await guest.executeJavaScriptInIsolatedWorld(
      BROWSER_ANNOTATION_VIEWPORT_BRIDGE_WORLD_ID,
      [{ code: buildBrowserAnnotationViewportBridgeScript(options) }],
    )
  }

  private emit(instanceId: string): void {
    this.stateCallback?.(this.getState(instanceId))
  }
}

function pendingLabel(payload: BrowserGrabPayload | null): string | null {
  if (!payload) return null
  return payload.target.accessibility.accessibleName || payload.target.textSnippet || payload.target.tagName
}

function parseComposerOutcome(raw: unknown): AnnotationComposerOutcome {
  if (!raw || typeof raw !== 'object') return { kind: 'cancel' }
  const value = raw as Record<string, unknown>
  if (value.kind === 'submit' && typeof value.comment === 'string') {
    return { kind: 'submit', comment: value.comment, intent: typeof value.intent === 'string' ? value.intent : 'change' }
  }
  return { kind: 'cancel' }
}
