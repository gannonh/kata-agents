import { parseBrowserInstanceIdFromRoute } from '../../shared/browser-surface'
import type { PanelStackEntry } from '@/atoms/panel-stack'

/**
 * Keep-alive close: hide the browser instance before the panel unmounts so
 * reconcileBrowserPanels does not immediately reopen it.
 */
export async function hideBrowserInstanceForPanel(entry: PanelStackEntry): Promise<void> {
  if (entry.panelType !== 'browser') return
  const instanceId = parseBrowserInstanceIdFromRoute(entry.route)
  if (!instanceId) return
  await window.electronAPI?.browserPane?.hide?.(instanceId)
}
