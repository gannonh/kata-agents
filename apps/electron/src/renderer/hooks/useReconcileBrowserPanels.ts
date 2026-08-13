import { useEffect, useMemo } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  browserInstancesAtom,
  filterInstancesForWorkspace,
  mergeBrowserListSnapshot,
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

    let cancelled = false
    let listSettled = false
    const pendingUpdates = new Map<string, BrowserInstanceInfo>()
    const pendingRemoved = new Set<string>()

    const cleanupState = browserPaneApi.onStateChanged((info: BrowserInstanceInfo) => {
      if (cancelled) return
      if (!listSettled) {
        pendingUpdates.set(info.id, info)
        pendingRemoved.delete(info.id)
        return
      }
      updateInstance(info)
    })
    const cleanupRemoved = browserPaneApi.onRemoved((id: string) => {
      if (cancelled) return
      if (!listSettled) {
        pendingRemoved.add(id)
        pendingUpdates.delete(id)
        return
      }
      removeInstance(id)
    })

    void browserPaneApi.list()
      .then((items) => {
        if (cancelled) return
        const merged = mergeBrowserListSnapshot(items, pendingUpdates, pendingRemoved)
        listSettled = true
        setInstances(merged)
      })
      .catch((error) => {
        if (cancelled) return
        console.warn('[browser-panel] Failed to list browser panes:', error)
        listSettled = true
        setInstances([])
      })

    return () => {
      cancelled = true
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
    const { toOpen, toClose, toPark } = reconcileBrowserPanels(instances, openIds, allInstances)
    const hide = window.electronAPI?.browserPane?.hide
    const parkSet = new Set(toPark)

    for (const id of toOpen) {
      pushPanel({ route: routes.view.browser(id) })
    }

    for (const id of toClose) {
      if (parkSet.has(id)) continue
      const entry = panelStack.find((p) => parseBrowserInstanceIdFromRoute(p.route) === id)
      if (entry) closePanel(entry.id)
    }

    let cancelled = false
    void (async () => {
      for (const id of toPark) {
        try {
          await hide?.(id)
        } catch (error) {
          console.warn('[browser-panel] Failed to park browser pane:', error)
          continue
        }
        if (cancelled) return
        const entry = panelStack.find((p) => parseBrowserInstanceIdFromRoute(p.route) === id)
        if (entry) closePanel(entry.id)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [allInstances, instances, panelStack, pushPanel, closePanel])
}
