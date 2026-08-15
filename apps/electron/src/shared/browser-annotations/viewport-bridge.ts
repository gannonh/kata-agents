import type { BrowserGrabRect } from '@kata-sh/shared/protocol'

export type BrowserAnnotationViewportBridgeMarker = {
  id: string
  index: number
  rectPage: BrowserGrabRect
  rectViewport: BrowserGrabRect
  isFixed: boolean
}

export type BrowserAnnotationViewportBridgeOptions = {
  enabled: boolean
  emitViewport: boolean
  markers: BrowserAnnotationViewportBridgeMarker[]
  token: string
}

export const BROWSER_ANNOTATION_VIEWPORT_BRIDGE_WORLD_ID = 1207
export const BROWSER_ANNOTATION_VIEWPORT_MESSAGE_PREFIX = '__kata_annotation_viewport__:'
export const BROWSER_ANNOTATION_MARKER_SIZE = 24

export type ViewportScroll = { scrollX: number; scrollY: number }
export type ViewportSize = { width: number; height: number }

export function isValidBrowserAnnotationViewportBridgeToken(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(value)
}

function isValidBrowserGrabRect(value: unknown): value is BrowserGrabRect {
  if (!value || typeof value !== 'object') {
    return false
  }
  const rect = value as Record<string, unknown>
  return (
    typeof rect.x === 'number' &&
    Number.isFinite(rect.x) &&
    typeof rect.y === 'number' &&
    Number.isFinite(rect.y) &&
    typeof rect.width === 'number' &&
    Number.isFinite(rect.width) &&
    rect.width >= 0 &&
    typeof rect.height === 'number' &&
    Number.isFinite(rect.height) &&
    rect.height >= 0
  )
}

export function isValidBrowserAnnotationViewportBridgeMarkers(
  value: unknown,
): value is BrowserAnnotationViewportBridgeMarker[] {
  return (
    Array.isArray(value) &&
    value.length <= 50 &&
    value.every((marker) => {
      if (!marker || typeof marker !== 'object') {
        return false
      }
      const candidate = marker as Record<string, unknown>
      return (
        typeof candidate.id === 'string' &&
        candidate.id.length > 0 &&
        candidate.id.length <= 100 &&
        Number.isInteger(candidate.index) &&
        (candidate.index as number) >= 0 &&
        (candidate.index as number) < 100 &&
        typeof candidate.isFixed === 'boolean' &&
        isValidBrowserGrabRect(candidate.rectPage) &&
        isValidBrowserGrabRect(candidate.rectViewport)
      )
    })
  )
}

export function placeAnnotationComposer(
  rect: BrowserGrabRect,
  size: ViewportSize,
  card: { width: number; height: number } = { width: 352, height: 280 },
): { x: number; y: number; below: boolean } {
  const below = rect.y + rect.height + 10 + card.height < size.height - 12
  const margin = 12
  const halfWidth = card.width / 2
  const minX = halfWidth + margin
  const maxX = size.width - halfWidth - margin
  const preferredX = rect.x + rect.width / 2
  const x = maxX < minX
    ? size.width / 2
    : Math.min(Math.max(minX, preferredX), maxX)
  const y = below
    ? Math.min(rect.y + rect.height, size.height - 12)
    : Math.max(12, rect.y)
  return { x, y, below }
}

export function liveAnnotationRect(
  payload: { target: { isFixed?: boolean; rectPage: BrowserGrabRect; rectViewport: BrowserGrabRect }; page: { scrollX: number; scrollY: number } },
  viewport: ViewportScroll,
  version = 1,
): BrowserGrabRect {
  if (payload.target.isFixed) {
    return payload.target.rectViewport
  }
  const scrollX = version === 0 ? payload.page.scrollX : viewport.scrollX
  const scrollY = version === 0 ? payload.page.scrollY : viewport.scrollY
  return {
    ...payload.target.rectViewport,
    x: payload.target.rectPage.x - scrollX,
    y: payload.target.rectPage.y - scrollY,
  }
}

export function placeAnnotationMarker(
  marker: Pick<BrowserAnnotationViewportBridgeMarker, 'rectPage' | 'rectViewport' | 'isFixed'>,
  viewport: ViewportScroll,
  size: ViewportSize,
  markerSize = BROWSER_ANNOTATION_MARKER_SIZE,
): { visible: boolean; x: number; y: number } {
  const sourceRect = marker.isFixed ? marker.rectViewport : marker.rectPage
  const x = marker.isFixed ? sourceRect.x : sourceRect.x - viewport.scrollX
  const y = marker.isFixed ? sourceRect.y : sourceRect.y - viewport.scrollY
  const width = Number.isFinite(sourceRect.width) ? sourceRect.width : 0
  const height = Number.isFinite(sourceRect.height) ? sourceRect.height : 0
  const visible =
    x + width >= 0 &&
    y + height >= 0 &&
    x <= size.width &&
    y <= size.height
  return {
    visible,
    x: x + width / 2 - markerSize / 2,
    y: y + height - markerSize / 2,
  }
}

export function createBrowserAnnotationViewportToken(): string {
  const raw = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 8)}`
  return raw.replaceAll(/[^a-zA-Z0-9_-]/g, 'x').padEnd(16, 'x').slice(0, 80)
}

export function buildBrowserAnnotationViewportBridgeScript({
  emitViewport,
  enabled,
  markers,
  token,
}: BrowserAnnotationViewportBridgeOptions): string {
  return `(() => {
  'use strict';

  const enabled = ${JSON.stringify(enabled)};
  const emitViewportMessages = ${JSON.stringify(emitViewport)};
  const markers = ${JSON.stringify(markers)};
  const token = ${JSON.stringify(token)};
  const prefix = ${JSON.stringify(BROWSER_ANNOTATION_VIEWPORT_MESSAGE_PREFIX)};
  const stateKey = '__kataBrowserAnnotationViewportBridge';
  const hostAttribute = 'data-kata-browser-annotation-overlay';
  const markerSize = ${BROWSER_ANNOTATION_MARKER_SIZE};

  const removeOverlay = (state) => {
    if (state && state.host && state.host.parentNode) {
      state.host.parentNode.removeChild(state.host);
    }
  };

  const cleanup = (state) => {
    if (!state) return;
    if (state.raf) {
      cancelAnimationFrame(state.raf);
    }
    if (state.requestUpdate) {
      window.removeEventListener('scroll', state.requestUpdate, true);
      document.removeEventListener('scroll', state.requestUpdate, true);
      window.removeEventListener('resize', state.requestUpdate, true);
    }
    removeOverlay(state);
  };

  const existing = globalThis[stateKey];
  if (!enabled) {
    cleanup(existing);
    delete globalThis[stateKey];
    return true;
  }

  const toNumber = (value, fallback) =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;

  const readViewport = () => ({
    scrollX: toNumber(window.scrollX, toNumber(window.pageXOffset, 0)),
    scrollY: toNumber(window.scrollY, toNumber(window.pageYOffset, 0))
  });

  const emitViewport = () => {
    if (!emitViewportMessages) return;
    try {
      console.debug(prefix + token + ':' + JSON.stringify(readViewport()));
    } catch (e) {}
  };

  const getRoot = () => document.body || document.documentElement;

  const ensureOverlay = (state) => {
    if (state.host && state.shadowRoot) {
      return state.shadowRoot;
    }
    const root = getRoot();
    if (!root) return null;
    const host = document.createElement('div');
    host.setAttribute(hostAttribute, '');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;contain:layout style paint;overflow:hidden;';
    const shadowRoot = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = '.marker{box-sizing:border-box;position:absolute;left:0;top:0;width:24px;height:24px;display:flex;align-items:center;justify-content:center;border-radius:9999px;border:1px solid rgba(255,255,255,0.95);background:#2563eb;color:#fff;font:600 11px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 10px 24px rgba(0,0,0,.18);will-change:transform;pointer-events:none;user-select:none;}';
    shadowRoot.appendChild(style);
    root.appendChild(host);
    state.host = host;
    state.shadowRoot = shadowRoot;
    return shadowRoot;
  };

  const updateMarkers = (state, nextMarkers) => {
    state.markers = Array.isArray(nextMarkers) ? nextMarkers : [];
    if (state.markers.length === 0) {
      removeOverlay(state);
      state.host = null;
      state.shadowRoot = null;
      state.markerElements = new Map();
      return;
    }
    const shadowRoot = ensureOverlay(state);
    if (!shadowRoot) return;
    const liveIds = new Set();
    state.markers.forEach((marker) => {
      liveIds.add(marker.id);
      let element = state.markerElements.get(marker.id);
      if (!element) {
        element = document.createElement('span');
        element.className = 'marker';
        shadowRoot.appendChild(element);
        state.markerElements.set(marker.id, element);
      }
      element.textContent = String(marker.index + 1);
    });
    state.markerElements.forEach((element, id) => {
      if (!liveIds.has(id)) {
        element.remove();
        state.markerElements.delete(id);
      }
    });
  };

  const positionMarkers = (state) => {
    if (!state.markers || state.markers.length === 0) return;
    const viewport = readViewport();
    const viewportWidth = toNumber(window.innerWidth, 0);
    const viewportHeight = toNumber(window.innerHeight, 0);
    state.markers.forEach((marker) => {
      const element = state.markerElements.get(marker.id);
      if (!element) return;
      const sourceRect = marker.isFixed ? marker.rectViewport : marker.rectPage;
      const x = marker.isFixed ? sourceRect.x : sourceRect.x - viewport.scrollX;
      const y = marker.isFixed ? sourceRect.y : sourceRect.y - viewport.scrollY;
      const width = toNumber(sourceRect.width, 0);
      const height = toNumber(sourceRect.height, 0);
      const visible =
        x + width >= 0 &&
        y + height >= 0 &&
        x <= viewportWidth &&
        y <= viewportHeight;
      if (!visible) {
        element.style.display = 'none';
        return;
      }
      element.style.display = 'flex';
      element.style.transform =
        'translate3d(' +
        (x + width / 2 - markerSize / 2) +
        'px,' +
        (y + height - markerSize / 2) +
        'px,0)';
    });
  };

  if (existing && existing.requestUpdate) {
    existing.emitViewport = emitViewport;
    updateMarkers(existing, markers);
    existing.requestUpdate();
    return true;
  }

  const state = {
    raf: 0,
    emitViewport,
    host: null,
    markerElements: new Map(),
    markers: [],
    shadowRoot: null,
    requestUpdate: null
  };

  state.requestUpdate = () => {
    if (state.raf) return;
    state.raf = requestAnimationFrame(() => {
      state.raf = 0;
      positionMarkers(state);
      state.emitViewport();
    });
  };

  updateMarkers(state, markers);
  window.addEventListener('scroll', state.requestUpdate, true);
  document.addEventListener('scroll', state.requestUpdate, true);
  window.addEventListener('resize', state.requestUpdate, true);
  globalThis[stateKey] = state;
  state.requestUpdate();
  return true;
})();`
}
