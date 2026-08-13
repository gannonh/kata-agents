/**
 * Browser surface geometry and panel reconciliation.
 *
 * A browser *instance* (webContents, cookies, CDP, agent control) is independent
 * of the *surface* that currently presents it: an integrated app-shell panel or
 * a detached native window. This module is the pure seam for that split.
 */

export type BrowserSurface = 'panel' | 'detached'

export interface BrowserViewRect {
  x: number
  y: number
  width: number
  height: number
}

export const BROWSER_TOOLBAR_HEIGHT = 48

export function layoutBrowserSurfaceRects(
  host: BrowserViewRect,
  toolbarHeight = BROWSER_TOOLBAR_HEIGHT,
): { toolbar: BrowserViewRect; page: BrowserViewRect } {
  const x = Math.floor(host.x)
  const y = Math.floor(host.y)
  const width = Math.max(0, Math.floor(host.width))
  const height = Math.max(0, Math.floor(host.height))
  const toolbarH = Math.min(Math.max(0, toolbarHeight), height)
  return {
    toolbar: { x, y, width, height: toolbarH },
    page: { x, y: y + toolbarH, width, height: Math.max(0, height - toolbarH) },
  }
}

export function browserPanelRoute(instanceId: string): string {
  return `browser/${instanceId}`
}

export function parseBrowserInstanceIdFromRoute(route: string): string | null {
  const match = /^browser\/([^/]+)$/.exec(route)
  return match?.[1] ?? null
}

export function resolveCreateSurface(options?: {
  surface?: BrowserSurface
  show?: boolean
}): BrowserSurface {
  return options?.surface ?? 'panel'
}

export function isPanelSurface(surface: BrowserSurface | null | undefined): boolean {
  return surface === 'panel'
}

/**
 * Diff visible panel-surface instances against already-open browser panels.
 *
 * Instances with a missing `surface` are treated as detached so an older main
 * process cannot force the renderer to open integrated panels.
 */
export function reconcileBrowserPanels(
  instances: Array<{ id: string; isVisible: boolean; surface?: BrowserSurface | null }>,
  openPanelInstanceIds: string[],
  allInstances: Array<{ id: string; isVisible: boolean; surface?: BrowserSurface | null }> = instances,
): { toOpen: string[]; toClose: string[]; toPark: string[] } {
  const panelVisible = new Set(
    instances
      .filter((instance) => instance.isVisible && isPanelSurface(instance.surface))
      .map((instance) => instance.id),
  )
  const open = new Set(openPanelInstanceIds)
  const toOpen = [...panelVisible].filter((id) => !open.has(id))
  const toClose = [...open].filter((id) => !panelVisible.has(id))
  const byId = new Map(allInstances.map((instance) => [instance.id, instance]))
  return {
    toOpen,
    toClose,
    toPark: toClose.filter((id) => shouldParkBrowserPanelOnClose(byId.get(id))),
  }
}

/**
 * Workspace switches close the React panel without detaching or hiding the
 * instance. Those still-visible panel instances must be parked so native views
 * do not remain over the newly selected workspace.
 */
export function shouldParkBrowserPanelOnClose(
  instance: { isVisible: boolean; surface?: BrowserSurface | null } | undefined,
): boolean {
  return Boolean(instance?.isVisible && isPanelSurface(instance.surface))
}

export function roundBrowserPanelBounds(rect: BrowserViewRect): BrowserViewRect {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }
}

export function browserPanelBoundsChanged(
  prev: BrowserViewRect | null,
  next: BrowserViewRect,
): boolean {
  if (!prev) return true
  return prev.x !== next.x || prev.y !== next.y || prev.width !== next.width || prev.height !== next.height
}

export function rectsOverlap(a: BrowserViewRect, b: BrowserViewRect): boolean {
  return a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0
    && a.x < b.x + b.width
    && a.x + a.width > b.x
    && a.y < b.y + b.height
    && a.y + a.height > b.y
}

export function isBlankBrowserUrl(url: string | null | undefined): boolean {
  if (url == null) return false
  const trimmed = url.trim()
  return trimmed === '' || trimmed === 'about:blank' || trimmed.startsWith('about:blank#')
}

/**
 * Native BrowserViews paint above the renderer, so HTML panel chrome
 * (dropdowns, empty state, plus-menus) would be covered. Collapse the
 * reported host to zero area so main parks the views until the hole is
 * free again.
 */
export function browserPanelReportedBounds(
  host: BrowserViewRect,
  overlays: BrowserViewRect[],
  url?: string | null,
): BrowserViewRect {
  if (isBlankBrowserUrl(url) || overlays.some((overlay) => rectsOverlap(host, overlay))) {
    return { ...host, width: 0, height: 0 }
  }
  return host
}
