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
): { toOpen: string[]; toClose: string[] } {
  const panelVisible = new Set(
    instances
      .filter((instance) => instance.isVisible && isPanelSurface(instance.surface))
      .map((instance) => instance.id),
  )
  const open = new Set(openPanelInstanceIds)
  return {
    toOpen: [...panelVisible].filter((id) => !open.has(id)),
    toClose: [...open].filter((id) => !panelVisible.has(id)),
  }
}
