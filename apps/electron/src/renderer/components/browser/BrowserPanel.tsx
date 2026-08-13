/**
 * Integrated browser panel.
 *
 * Chrome is HTML (address bar + close). Instance actions live on the
 * top-bar tab so this panel can sit in the same stack as chat without a
 * second title row. Native BrowserViews occupy only the page hole.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useAtomValue } from 'jotai'
import { useTranslation } from 'react-i18next'
import { BrowserControls, BrowserEmptyStateCard } from '@kata-sh/ui'
import { Panel } from '@/components/app-shell/Panel'
import { useAppShellContext } from '@/context/AppShellContext'
import { useCompensateForStoplight } from '@/context/StoplightContext'
import { browserInstancesAtom } from '@/atoms/browser-pane'
import { routes } from '@/lib/navigate'
import { cn } from '@/lib/utils'
import {
  browserPanelBoundsChanged,
  browserPanelReportedBounds,
  isBlankBrowserUrl,
  roundBrowserPanelBounds,
  type BrowserViewRect,
} from '../../../shared/browser-surface'
import { getOpenOverlayRects } from '@/lib/overlay-detection'
import { EMPTY_STATE_PROMPT_SAMPLES } from './empty-state-prompts'
import type { BrowserInstanceInfo } from '../../../shared/types'

const PARKED_BOUNDS: BrowserViewRect = { x: 0, y: 0, width: 0, height: 0 }

interface BrowserPanelProps {
  instanceId: string
}

export function BrowserPanel({ instanceId }: BrowserPanelProps) {
  const { rightSidebarButton, leadingAction } = useAppShellContext()
  const instances = useAtomValue(browserInstancesAtom)
  const instance = instances.find((item) => item.id === instanceId)
  const [requestedUrl, setRequestedUrl] = useState<string | null>(null)
  const url = requestedUrl ?? instance?.url ?? 'about:blank'
  const isBlank = isBlankBrowserUrl(url)
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isBlankBrowserUrl(instance?.url)) setRequestedUrl(null)
  }, [instance?.url])

  useEffect(() => {
    const el = hostRef.current
    const setBounds = window.electronAPI?.browserPane?.setPanelBounds
    if (!el || !setBounds) return

    let last: BrowserViewRect | null = null
    let frame = 0
    let stopped = false

    const report = () => {
      const host = roundBrowserPanelBounds(el.getBoundingClientRect())
      const next = browserPanelReportedBounds(host, getOpenOverlayRects(), url)
      if (!browserPanelBoundsChanged(last, next)) return
      last = next
      void setBounds(instanceId, next)
    }

    const loop = () => {
      if (stopped) return
      report()
      frame = requestAnimationFrame(loop)
    }

    report()
    frame = requestAnimationFrame(loop)
    const observer = new ResizeObserver(report)
    observer.observe(el)
    window.addEventListener('resize', report)
    return () => {
      stopped = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', report)
      void setBounds(instanceId, PARKED_BOUNDS)
    }
  }, [instanceId, url])

  return (
    <Panel variant="grow">
      <div className="h-full flex flex-col min-h-0">
        <BrowserPanelToolbar
          instanceId={instanceId}
          instance={instance}
          leadingAction={leadingAction}
          closeButton={rightSidebarButton}
          onNavigate={(nextUrl) => {
            setRequestedUrl(nextUrl)
          }}
        />
        <div
          ref={hostRef}
          id="browser-panel"
          data-browser-panel=""
          data-browser-instance-id={instanceId}
          className="relative flex-1 min-h-0"
        >
          {isBlank && (
            <BrowserPanelEmptyState />
          )}
        </div>
      </div>
    </Panel>
  )
}

function BrowserPanelToolbar({
  instanceId,
  instance,
  leadingAction,
  closeButton,
  onNavigate,
}: {
  instanceId: string
  instance: BrowserInstanceInfo | undefined
  leadingAction?: ReactNode
  closeButton?: ReactNode
  onNavigate?: (url: string) => void
}) {
  const api = window.electronAPI?.browserPane
  const compensateForStoplight = useCompensateForStoplight() && !leadingAction

  const handleNavigate = useCallback((nextUrl: string) => {
    onNavigate?.(nextUrl)
    void api?.navigate(instanceId, nextUrl)
  }, [api, instanceId, onNavigate])

  const handleGoBack = useCallback(() => {
    void api?.goBack(instanceId)
  }, [api, instanceId])

  const handleGoForward = useCallback(() => {
    void api?.goForward(instanceId)
  }, [api, instanceId])

  const handleReload = useCallback(() => {
    void api?.reload(instanceId)
  }, [api, instanceId])

  const handleStop = useCallback(() => {
    void api?.stop(instanceId)
  }, [api, instanceId])

  return (
    <BrowserControls
      url={instance?.url}
      loading={instance?.isLoading}
      canGoBack={instance?.canGoBack}
      canGoForward={instance?.canGoForward}
      onNavigate={handleNavigate}
      onGoBack={handleGoBack}
      onGoForward={handleGoForward}
      onReload={handleReload}
      onStop={handleStop}
      themeColor={instance?.themeColor}
      compact
      leadingContent={leadingAction}
      trailingContent={closeButton ? (
        <div className="ml-2 flex items-center">
          {closeButton}
        </div>
      ) : undefined}
      urlBarClassName="max-w-[600px]"
      className={cn(
        'shrink-0 border-b border-foreground/6',
        compensateForStoplight && 'pl-[84px]',
      )}
    />
  )
}

function BrowserPanelEmptyState() {
  const { t } = useTranslation()

  const handlePromptSelect = useCallback(async (fullPrompt: string) => {
    const route = routes.action.newSession({ input: fullPrompt, send: true })
    const token = String(Date.now())
    try {
      await window.electronAPI?.browserPane?.emptyStateLaunch?.({ route, token })
    } catch (error) {
      console.warn('[BrowserPanel] Failed to launch empty-state prompt:', error)
    }
  }, [])

  return (
    <div className="absolute inset-0 overflow-auto">
      <BrowserEmptyStateCard
        title={t('browser.readyTitle')}
        description={t('browser.readyDescription')}
        prompts={EMPTY_STATE_PROMPT_SAMPLES}
        showExamplePrompts
        showSafetyHint
        onPromptSelect={(sample) => {
          void handlePromptSelect(sample.full)
        }}
      />
    </div>
  )
}
