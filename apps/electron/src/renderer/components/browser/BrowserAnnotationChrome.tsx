import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAtomValue } from 'jotai'
import { useTranslation } from 'react-i18next'
import { Copy, MessageSquarePlus, Send, Trash2 } from 'lucide-react'
import { FilterableSelectPopover } from '@kata-sh/ui'
import type { BrowserAnnotationState } from '@kata-sh/shared/protocol'
import { HeaderIconButton } from '@/components/ui/HeaderIconButton'
import { Button } from '@/components/ui/button'
import { useAppShellContext } from '@/context/AppShellContext'
import { sessionMetaMapAtom } from '@/atoms/sessions'
import { cn } from '@/lib/utils'
import {
  annotationListLabel,
  copyAnnotationMarkdown,
  isAnnotateModeActive,
  markdownForBrowserAnnotations,
  sendAnnotationMarkdown,
  sessionPickerLabel,
  shouldEnableAnnotateMode,
  workspaceSessionsForPicker,
} from './annotation-ui'

const EMPTY_STATE: Omit<BrowserAnnotationState, 'instanceId'> = {
  mode: 'idle',
  annotations: [],
  pendingLabel: null,
}

export function useBrowserAnnotationState(instanceId: string): BrowserAnnotationState {
  const [state, setState] = useState<BrowserAnnotationState>({
    instanceId,
    ...EMPTY_STATE,
  })

  useEffect(() => {
    const api = window.electronAPI?.browserPane
    if (!api?.listAnnotations) {
      setState({ instanceId, ...EMPTY_STATE })
      return
    }

    let cancelled = false
    void api.listAnnotations(instanceId).then((next) => {
      if (!cancelled) setState(next)
    }).catch(() => {
      if (!cancelled) setState({ instanceId, ...EMPTY_STATE })
    })

    const unsub = api.onAnnotationStateChanged?.((next) => {
      if (next.instanceId === instanceId) setState(next)
    })

    return () => {
      cancelled = true
      unsub?.()
    }
  }, [instanceId])

  return state
}

export function BrowserAnnotateToggle({
  instanceId,
  state,
  disabled,
  className,
  iconClassName,
}: {
  instanceId: string
  state: Pick<BrowserAnnotationState, 'mode' | 'annotations'>
  disabled?: boolean
  className?: string
  iconClassName?: string
}) {
  const { t } = useTranslation()
  const active = isAnnotateModeActive(state.mode)
  const count = state.annotations.length

  const handleClick = useCallback(() => {
    const api = window.electronAPI?.browserPane
    if (!api) return
    if (shouldEnableAnnotateMode(state.mode)) {
      void api.setAnnotateMode(instanceId, true)
      return
    }
    void api.cancelAnnotate(instanceId)
  }, [instanceId, state.mode])

  return (
    <HeaderIconButton
      id="browser-annotate-toggle"
      icon={(
        <span className="relative inline-flex">
          <MessageSquarePlus className={cn('h-3.5 w-3.5', iconClassName)} />
          {count > 0 ? (
            <span className="absolute -top-1.5 -right-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-foreground px-0.5 text-[9px] font-semibold leading-none text-background">
              {count}
            </span>
          ) : null}
        </span>
      )}
      tooltip={t('browser.annotate')}
      aria-label={t('browser.annotate')}
      aria-pressed={active}
      disabled={disabled}
      onClick={handleClick}
      className={cn(active && 'text-foreground bg-foreground/8', className)}
    />
  )
}

export function BrowserAnnotationTray({
  instanceId,
  state,
}: {
  instanceId: string
  state: BrowserAnnotationState
}) {
  const { t } = useTranslation()
  const { activeWorkspaceId } = useAppShellContext()
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)
  const [copied, setCopied] = useState(false)
  const [sendOpen, setSendOpen] = useState(false)
  const sendRef = useRef<HTMLButtonElement>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const sessions = useMemo(
    () => workspaceSessionsForPicker(sessionMetaMap.values(), activeWorkspaceId),
    [sessionMetaMap, activeWorkspaceId],
  )
  const markdown = markdownForBrowserAnnotations(state.annotations)
  const api = window.electronAPI?.browserPane

  useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current)
    }
  }, [])

  if (state.annotations.length === 0 && state.mode !== 'composing') return null

  const handleCopy = async () => {
    const copiedMarkdown = await copyAnnotationMarkdown(markdown, (value) => navigator.clipboard.writeText(value))
    if (!copiedMarkdown) return
    setCopied(true)
    if (copyTimer.current) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(false), 1400)
  }

  return (
    <div
      id="browser-annotation-tray"
      className="shrink-0 border-b border-foreground/6 bg-background"
    >
      <div className="flex items-center gap-2 px-3 py-1.5">
        <MessageSquarePlus className="h-3.5 w-3.5 text-muted-foreground" />
        <div className="min-w-0 flex-1 text-xs font-medium">
          {t('browser.annotationTrayTitle')}
          {state.annotations.length > 0 ? ` · ${t('browser.annotationsReady', { count: state.annotations.length })}` : ''}
        </div>
        {state.mode === 'composing' ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 gap-1 px-2 text-[11px]"
            onClick={() => { void api?.cancelPendingAnnotation(instanceId) }}
            aria-label={t('browser.annotationCancelPending')}
          >
            {t('common.cancel')}
          </Button>
        ) : null}
        <Button
          ref={sendRef}
          type="button"
          size="sm"
          variant="outline"
          className="h-6 gap-1 px-2 text-[11px]"
          onClick={() => setSendOpen(true)}
          aria-label={t('browser.annotationSendTo')}
          disabled={!markdown}
        >
          <Send className="h-3 w-3" />
          {t('browser.annotationSend')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-6 gap-1 px-2 text-[11px]"
          onClick={() => { void handleCopy() }}
        >
          <Copy className="h-3 w-3" />
          {copied ? t('browser.annotationCopied') : t('browser.annotationCopy')}
        </Button>
        <HeaderIconButton
          icon={<Trash2 className="h-3.5 w-3.5" />}
          tooltip={t('browser.annotationClear')}
          aria-label={t('browser.annotationClear')}
          onClick={() => { void api?.clearAnnotations(instanceId) }}
        />
      </div>
      <div className="max-h-36 overflow-y-auto px-1.5 pb-1.5">
        {state.annotations.map((annotation, index) => (
          <div
            key={annotation.id}
            className="group flex gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-foreground/4"
          >
            <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-foreground text-[10px] font-semibold text-background">
              {index + 1}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{annotationListLabel(annotation)}</div>
              <div className="mt-0.5 line-clamp-2 text-muted-foreground">{annotation.comment}</div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                {t(`browser.annotationIntent.${annotation.intent}`)}
              </div>
            </div>
            <HeaderIconButton
              icon={<Trash2 className="h-3 w-3" />}
              tooltip={t('browser.annotationDelete', { number: index + 1 })}
              aria-label={t('browser.annotationDelete', { number: index + 1 })}
              className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
              onClick={() => { void api?.deleteAnnotation(instanceId, annotation.id) }}
            />
          </div>
        ))}
      </div>
      <FilterableSelectPopover
        open={sendOpen}
        onOpenChange={setSendOpen}
        anchorRef={sendRef}
        items={sessions}
        getKey={(session) => session.id}
        getLabel={sessionPickerLabel}
        isSelected={() => false}
        closeOnSelect
        filterPlaceholder={t('common.search')}
        emptyState={t('browser.annotationNoSessions')}
        onToggle={(session) => {
          sendAnnotationMarkdown(markdown, session.id, (sessionId, content) => {
            void window.electronAPI?.sendMessage(sessionId, content)
          })
          setSendOpen(false)
        }}
      />
    </div>
  )
}
