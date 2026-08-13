import { useEffect, useMemo } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  browserInstancesAtom,
  filterInstancesForWorkspace,
  removeBrowserInstanceAtom,
  setBrowserInstancesAtom,
  updateBrowserInstanceAtom,
} from '@/atoms/browser-pane'
import { closePanelAtom, panelStackAtom, pushPanelAtom } from '@/atoms/panel-stack'
import { routes } from '@/lib/navigate'
import {
  parseBrowserInstanceIdFromRoute,
  reconcileBrowserPanels,
} from '../../shared/browser-surface'
import type { BrowserInstanceInfo } from '../../shared/types'

/**
 * Keep the panel stack in sync with visible panel-surface browser instances,
 * and subscribe to main-process instance state (including compact layouts
 * where the top-bar tab strip is not mounted).
 */
export function useReconcileBrowserPanels(
  activeWorkspaceId: string | null,
  remoteWorkspaceId: string | null,
): void {
  const allInstances = useAtomValue(browserInstancesAtom)
  const panelStack = useAtomValue(panelStackAtom)
  const pushPanel = useSetAtom(pushPanelAtom)
  const closePanel = useSetAtom(closePanelAtom)
  const setInstances = useSetAtom(setBrowserInstancesAtom)
  const updateInstance = useSetAtom(updateBrowserInstanceAtom)
  const removeInstance = useSetAtom(removeBrowserInstanceAtom)

  useEffect(() => {
    const browserPaneApi = window.electronAPI?.browserPane
    if (!browserPaneApi?.list || !window.electronAPI.isChannelAvailable?.('browser-pane:list')) {
      setInstances([])
      return
    }

    void browserPaneApi.list()
      .then((items) => setInstances(items))
      .catch((error) => {
        console.warn('[browser-panel] Failed to list browser panes:', error)
        setInstances([])
      })

    const cleanupState = browserPaneApi.onStateChanged((info: BrowserInstanceInfo) => {
      updateInstance(info)
    })
    const cleanupRemoved = browserPaneApi.onRemoved((id: string) => {
      removeInstance(id)
    })

    return () => {
      cleanupState()
      cleanupRemoved()
    }
  }, [setInstances, updateInstance, removeInstance])

  const instances = useMemo(
    () => filterInstancesForWorkspace(allInstances, activeWorkspaceId, remoteWorkspaceId),
    [allInstances, activeWorkspaceId, remoteWorkspaceId],
  )

  useEffect(() => {
    const openIds = panelStack
      .map((entry) => parseBrowserInstanceIdFromRoute(entry.route))
      .filter((id): id is string => id !== null)
    const { toOpen, toClose } = reconcileBrowserPanels(instances, openIds)

    for (const id of toOpen) {
      pushPanel({ route: routes.view.browser(id) })
    }

    for (const id of toClose) {
      const entry = panelStack.find((p) => parseBrowserInstanceIdFromRoute(p.route) === id)
      if (entry) closePanel(entry.id)
    }
  }, [instances, panelStack, pushPanel, closePanel])
}
