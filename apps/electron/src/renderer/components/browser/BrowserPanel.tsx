/**
 * Bounds host for an integrated browser instance.
 *
 * The page, toolbar, and overlay are Electron BrowserViews parented onto the
 * main window. This component reports its layout rectangle so main can place
 * those views; it does not render the page itself.
 */

import { useEffect, useRef } from 'react'
import { Panel } from '@/components/app-shell/Panel'
import {
  browserPanelBoundsChanged,
  roundBrowserPanelBounds,
  type BrowserViewRect,
} from '../../../shared/browser-surface'

interface BrowserPanelProps {
  instanceId: string
}

export function BrowserPanel({ instanceId }: BrowserPanelProps) {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = hostRef.current
    const setBounds = window.electronAPI?.browserPane?.setPanelBounds
    if (!el || !setBounds) return

    let last: BrowserViewRect | null = null
    let frame = 0
    let stopped = false

    const report = () => {
      const next = roundBrowserPanelBounds(el.getBoundingClientRect())
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
    }
  }, [instanceId])

  return (
    <Panel variant="grow">
      <div
        ref={hostRef}
        id="browser-panel"
        data-browser-panel=""
        data-browser-instance-id={instanceId}
        className="h-full w-full min-h-0"
      />
    </Panel>
  )
}
