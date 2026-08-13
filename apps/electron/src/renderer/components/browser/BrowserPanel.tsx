/**
 * Bounds host for an integrated browser instance.
 *
 * The page, toolbar, and overlay are Electron BrowserViews parented onto the
 * main window. This component reports its layout rectangle so main can place
 * those views; it does not render the page itself.
 */

import { useEffect, useRef } from 'react'
import { Panel } from '@/components/app-shell/Panel'

interface BrowserPanelProps {
  instanceId: string
}

export function BrowserPanel({ instanceId }: BrowserPanelProps) {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = hostRef.current
    const setBounds = window.electronAPI?.browserPane?.setPanelBounds
    if (!el || !setBounds) return

    const report = () => {
      const rect = el.getBoundingClientRect()
      void setBounds(instanceId, {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      })
    }

    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    window.addEventListener('resize', report)
    return () => {
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
