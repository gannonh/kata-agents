/**
 * Browser Toolbar — React entry point
 *
 * Renders the shared BrowserControls component inside a chromeless
 * BrowserWindow. Communicates with the main process via a dedicated
 * preload script (browser-toolbar preload).
 */

import React, { useState, useEffect, useCallback, useRef } from 'react'
import ReactDOM from 'react-dom/client'
import { initReactI18next, useTranslation } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { EyeOff, X, XCircle, AppWindow, PanelLeft, Copy, MessageSquarePlus, Trash2 } from 'lucide-react'
import { setupI18n } from '@kata-sh/shared/i18n'
import { BrowserControls } from '@kata-sh/ui'
import { HeaderIconButton } from '@/components/ui/HeaderIconButton'
import { isBlankBrowserUrl } from '../shared/browser-surface'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from '@/components/ui/styled-dropdown'
import './index.css'

setupI18n([LanguageDetector, initReactI18next])

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ToolbarState {
  url: string
  title: string
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  themeColor?: string | null
  surface?: 'panel' | 'detached'
}

interface ToolbarAnnotationState {
  mode: 'idle' | 'selecting' | 'composing'
  count: number
  pendingLabel: string | null
  markdown: string
}

declare global {
  interface Window {
    browserToolbar: {
      instanceId: string
      navigate: (url: string) => Promise<void>
      goBack: () => Promise<void>
      goForward: () => Promise<void>
      reload: () => Promise<void>
      stop: () => Promise<void>
      setMenuGeometry: (open: boolean, height?: number) => Promise<void>
      hideWindow: () => Promise<void>
      closeWindowEntirely: () => Promise<void>
      detachToWindow: () => Promise<void>
      attachToPanel: () => Promise<void>
      setAnnotateMode: (enabled: boolean) => Promise<{ ok: boolean; reason?: string }>
      clearAnnotations: () => Promise<void>
      onStateUpdate: (callback: (state: ToolbarState) => void) => () => void
      onThemeColor: (callback: (color: string | null) => void) => () => void
      onForceCloseMenu: (callback: (payload: { reason?: string }) => void) => () => void
      onAnnotationState: (callback: (state: ToolbarAnnotationState) => void) => () => void
    }
  }
}

/* ------------------------------------------------------------------ */
/*  App                                                                */
/* ------------------------------------------------------------------ */

function BrowserToolbarApp() {
  const { t } = useTranslation()
  const [state, setState] = useState<ToolbarState>({
    url: 'about:blank',
    title: 'New Tab',
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    surface: 'panel',
  })
  const [themeColor, setThemeColor] = useState<string | null>(null)
  const [windowMenuOpen, setWindowMenuOpen] = useState(false)
  const [annotationState, setAnnotationState] = useState<ToolbarAnnotationState>({
    mode: 'idle',
    count: 0,
    pendingLabel: null,
    markdown: '',
  })
  const [copied, setCopied] = useState(false)
  const menuContentRef = useRef<HTMLDivElement | null>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const api = window.browserToolbar

  useEffect(() => {
    if (!api) return
    return api.onStateUpdate((s) => {
      setState(s)
      // Sync theme color from full state push (initial load / reconnection)
      if ('themeColor' in s) {
        setThemeColor((s as ToolbarState).themeColor ?? null)
      }
    })
  }, [api])

  useEffect(() => {
    if (!api) return
    return api.onThemeColor(setThemeColor)
  }, [api])

  useEffect(() => {
    if (!api) return
    return api.onForceCloseMenu(() => {
      setWindowMenuOpen(false)
    })
  }, [api])

  useEffect(() => {
    if (!api) return
    return api.onAnnotationState(setAnnotationState)
  }, [api])

  useEffect(() => {
    if (!api) return

    if (!windowMenuOpen) {
      void api.setMenuGeometry(false, 0)
      return
    }

    // Prime expansion immediately to avoid a constrained first measurement.
    void api.setMenuGeometry(true, 120)

    const sendGeometry = () => {
      const height = Math.ceil(menuContentRef.current?.getBoundingClientRect().height ?? 0)
      void api.setMenuGeometry(true, height)
    }

    let frame = requestAnimationFrame(sendGeometry)
    const observer = new ResizeObserver(() => {
      sendGeometry()
    })

    if (menuContentRef.current) {
      observer.observe(menuContentRef.current)
    }

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      void api.setMenuGeometry(false, 0)
    }
  }, [api, windowMenuOpen])

  const handleNavigate = useCallback((url: string) => {
    void api?.navigate(url)
  }, [api])

  const handleGoBack = useCallback(() => {
    void api?.goBack()
  }, [api])

  const handleGoForward = useCallback(() => {
    void api?.goForward()
  }, [api])

  const handleReload = useCallback(() => {
    void api?.reload()
  }, [api])

  const handleStop = useCallback(() => {
    void api?.stop()
  }, [api])

  const handleHideWindow = useCallback(() => {
    setWindowMenuOpen(false)
    void api?.hideWindow()
  }, [api])

  const handleDetachToWindow = useCallback(() => {
    setWindowMenuOpen(false)
    void api?.detachToWindow()?.catch((error) => {
      console.warn('[BrowserToolbar] Failed to detach browser:', error)
    })
  }, [api])

  const handleAttachToPanel = useCallback(() => {
    setWindowMenuOpen(false)
    void api?.attachToPanel()?.catch((error) => {
      console.warn('[BrowserToolbar] Failed to attach browser:', error)
    })
  }, [api])

  const handleCloseWindowEntirely = useCallback(() => {
    setWindowMenuOpen(false)
    void api?.closeWindowEntirely()
  }, [api])

  const handleToggleAnnotate = useCallback(() => {
    void api?.setAnnotateMode(annotationState.mode === 'idle')
  }, [api, annotationState.mode])

  const handleCopyAnnotations = useCallback(() => {
    const markdown = annotationState.markdown.trim()
    if (!markdown) return
    void navigator.clipboard.writeText(markdown).then(() => {
      setCopied(true)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 1400)
    })
  }, [annotationState.markdown])

  const handleClearAnnotations = useCallback(() => {
    void api?.clearAnnotations()
  }, [api])

  const isPanel = state.surface === 'panel'
  const annotateActive = annotationState.mode !== 'idle'
  const annotateDisabled = isBlankBrowserUrl(state.url)

  return (
    <>
      {/*
        Full-window outside-tap catcher while menu is open.
        Critical for draggable titlebar windows (Windows) where outside-click
        dismissal can be unreliable if events fall into app-region: drag zones.
      */}
      {windowMenuOpen && (
        <div
          className="fixed inset-0 z-[90] titlebar-no-drag bg-black/[0.0039215686]"
          onPointerDown={(event) => {
            event.preventDefault()
            setWindowMenuOpen(false)
          }}
        />
      )}

      <BrowserControls
        url={state.url}
        loading={state.isLoading}
        canGoBack={state.canGoBack}
        canGoForward={state.canGoForward}
        onNavigate={handleNavigate}
        onGoBack={handleGoBack}
        onGoForward={handleGoForward}
        onReload={handleReload}
        onStop={handleStop}
        trailingContent={(
          <div className="ml-2 flex items-center gap-1.5 titlebar-no-drag">
            <HeaderIconButton
              id="browser-annotate-toggle"
              icon={(
                <span className="relative inline-flex">
                  <MessageSquarePlus className="h-3.5 w-3.5" />
                  {annotationState.count > 0 ? (
                    <span className="absolute -top-1.5 -right-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-foreground px-0.5 text-[9px] font-semibold leading-none text-background">
                      {annotationState.count}
                    </span>
                  ) : null}
                </span>
              )}
              aria-label={t('browser.annotate')}
              aria-pressed={annotateActive}
              disabled={annotateDisabled}
              onClick={handleToggleAnnotate}
              className={annotateActive ? 'text-foreground bg-foreground/8' : (themeColor ? '' : 'bg-background shadow-minimal hover:bg-foreground/5')}
              style={themeColor ? { color: 'var(--tb-fg)' } : undefined}
            />
            {annotationState.count > 0 ? (
              <>
                <HeaderIconButton
                  icon={<Copy className="h-3.5 w-3.5" />}
                  aria-label={copied ? t('browser.annotationCopied') : t('browser.annotationCopy')}
                  onClick={handleCopyAnnotations}
                  className={themeColor ? '' : 'bg-background shadow-minimal hover:bg-foreground/5'}
                  style={themeColor ? { color: 'var(--tb-fg)' } : undefined}
                />
                <HeaderIconButton
                  icon={<Trash2 className="h-3.5 w-3.5" />}
                  aria-label={t('browser.annotationClear')}
                  onClick={handleClearAnnotations}
                  className={themeColor ? '' : 'bg-background shadow-minimal hover:bg-foreground/5'}
                  style={themeColor ? { color: 'var(--tb-fg)' } : undefined}
                />
              </>
            ) : null}
            <DropdownMenu open={windowMenuOpen} onOpenChange={setWindowMenuOpen}>
              <DropdownMenuTrigger asChild>
                <HeaderIconButton
                  icon={<X className="h-3.5 w-3.5" />}
                  aria-label={t('browser.windowOptions')}
                  className={themeColor ? '' : 'bg-background shadow-minimal hover:bg-foreground/5'}
                  style={themeColor ? { color: 'var(--tb-fg)' } : undefined}
                />
              </DropdownMenuTrigger>

              <StyledDropdownMenuContent
                ref={menuContentRef}
                align="end"
                side="bottom"
                sideOffset={6}
                minWidth="min-w-44"
                className="titlebar-no-drag z-[110] max-h-none overflow-visible"
              >
                <StyledDropdownMenuItem onSelect={handleHideWindow}>
                  <EyeOff className="h-3.5 w-3.5" />
                  {t('browser.hideBrowser')}
                </StyledDropdownMenuItem>
                {isPanel ? (
                  <StyledDropdownMenuItem onSelect={handleDetachToWindow}>
                    <AppWindow className="h-3.5 w-3.5" />
                    {t('browser.detachToWindow')}
                  </StyledDropdownMenuItem>
                ) : (
                  <StyledDropdownMenuItem
                    onSelect={handleAttachToPanel}
                    aria-label={annotationState.count > 0
                      ? `${t('browser.returnToPanel')}. ${t('browser.annotationSendInPanel')}`
                      : t('browser.returnToPanel')}
                  >
                    <PanelLeft className="h-3.5 w-3.5" />
                    {t('browser.returnToPanel')}
                  </StyledDropdownMenuItem>
                )}
                <StyledDropdownMenuItem variant="destructive" onSelect={handleCloseWindowEntirely}>
                  <XCircle className="h-3.5 w-3.5" />
                  {t('browser.closeBrowser')}
                </StyledDropdownMenuItem>
              </StyledDropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
        themeColor={themeColor}
        urlBarClassName="max-w-[600px]"
        className="titlebar-drag-region bg-background"
      />
    </>
  )
}

/* ------------------------------------------------------------------ */
/*  Mount                                                              */
/* ------------------------------------------------------------------ */

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserToolbarApp />
  </React.StrictMode>,
)
