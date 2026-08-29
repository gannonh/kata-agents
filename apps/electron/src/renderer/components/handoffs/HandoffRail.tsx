import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { HandoffRailView } from '@kata-sh/shared/protocol'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { handoffStateLabel } from './state-label'

export interface HandoffRailProps {
  conversationId: string
  handoffId: string
}

function resultEvidence(rail: HandoffRailView): string | null {
  const result = rail.task?.result
  if (!result) return null
  return `${result.artifactPath} · ${result.sha256}`
}

function isAtLeastFresh(next: HandoffRailView, current: HandoffRailView | null): boolean {
  if (!current) return true
  return next.freshness.deliveryVersion >= current.freshness.deliveryVersion
    && next.freshness.taskVersion >= current.freshness.taskVersion
    && next.freshness.journalSequence >= current.freshness.journalSequence
}

export function HandoffRail({ conversationId, handoffId }: HandoffRailProps) {
  const { t } = useTranslation()
  const [rail, setRail] = React.useState<HandoffRailView | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<'cancel' | 'read' | null>(null)
  const [cancelReason, setCancelReason] = React.useState('')
  const railRef = React.useRef<HandoffRailView | null>(null)

  const applyRail = React.useCallback((next: HandoffRailView): boolean => {
    if (!isAtLeastFresh(next, railRef.current)) return false
    railRef.current = next
    setRail(next)
    return true
  }, [])

  const refresh = React.useCallback(async () => {
    const next = await window.electronAPI.getHandoffRail({ conversationId, handoffId })
    applyRail(next)
    setError(null)
  }, [conversationId, handoffId, applyRail])

  React.useEffect(() => {
    let disposed = false
    const waitId = crypto.randomUUID()
    const onError = (err: unknown) => {
      if (!disposed) setError(err instanceof Error ? err.message : String(err))
    }

    const unsubscribe = window.electronAPI.onHandoffEvent(event => {
      if (event.conversationId !== conversationId || event.handoffId !== handoffId) return
      refresh().catch(onError)
    })

    const waitForChanges = async () => {
      try {
        await refresh()
        while (!disposed) {
          const current = railRef.current
          if (!current) continue
          const next = await window.electronAPI.waitForHandoff({
            waitId,
            conversationId,
            handoffId,
            after: current.freshness,
            timeoutMs: 5_000,
          })
          if (!disposed) applyRail(next)
        }
      } catch (err) {
        onError(err)
      }
    }
    void waitForChanges()

    return () => {
      disposed = true
      unsubscribe()
      void window.electronAPI.cancelHandoffWait({ waitId }).catch(onError)
    }
  }, [conversationId, handoffId, refresh, applyRail])

  const handleRead = React.useCallback(async () => {
    if (!rail?.task || !rail.unread || busy) return
    setBusy('read')
    try {
      const next = await window.electronAPI.markHandoffResultRead({
        conversationId,
        handoffId,
        expectedTaskVersion: rail.freshness.taskVersion,
      })
      applyRail(next)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [rail, busy, conversationId, handoffId, applyRail])

  const handleCancel = React.useCallback(async () => {
    if (!rail || !rail.actions.includes('cancel') || busy) return
    setBusy('cancel')
    try {
      const next = await window.electronAPI.cancelHandoff({
        conversationId,
        handoffId,
        reason: cancelReason.trim() || t('handoffs.cancelledByUser'),
      })
      await refresh()
      applyRail(next)
      setCancelReason('')
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [rail, busy, conversationId, handoffId, cancelReason, t, refresh, applyRail])

  if (!rail) {
    return (
      <div data-testid="handoff-rail-loading" className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
        {t('handoffs.loading')}
      </div>
    )
  }

  const evidence = resultEvidence(rail)
  const state = handoffStateLabel(t, rail)

  return (
    <div data-testid={`handoff-rail-${handoffId}`} className="flex h-full min-h-0 flex-col">
      <div className="border-b border-foreground/10 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-medium">{t('handoffs.railTitle')}</h2>
          <span data-testid="handoff-rail-state" className="text-xs text-muted-foreground">
            {state}
          </span>
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {t('handoffs.cardRoute', { source: rail.sourceBotName, target: rail.targetBotName })}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <section className="flex flex-col gap-2">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{t('handoffs.request')}</div>
          <div data-testid="handoff-rail-request" className="whitespace-pre-wrap break-words text-sm">
            {rail.delivery.request}
          </div>
        </section>

        <section className="mt-4 flex flex-col gap-2">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{t('handoffs.exchange')}</div>
          {rail.exchange.length === 0 ? (
            <div className="text-sm text-muted-foreground">{t('handoffs.noExchange')}</div>
          ) : rail.exchange.map(entry => (
            <div key={entry.entryId} data-testid={`handoff-exchange-${entry.entryId}`} className="rounded border border-foreground/10 p-2 text-sm">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                {entry.createdAt}
              </div>
              <div className="mt-1 whitespace-pre-wrap break-words">
                {entry.phase === 'requested'
                  ? t('handoffs.exchangeRequested', { source: rail.sourceBotName, target: rail.targetBotName })
                  : t('handoffs.exchangeTerminal', {
                      target: rail.targetBotName,
                      state,
                    })}
              </div>
            </div>
          ))}
        </section>

        <section className="mt-4 flex flex-col gap-2">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{t('handoffs.progress')}</div>
          <div data-testid="handoff-rail-progress" className="text-sm">
            {state}
          </div>
          {rail.task?.stateTimestamps.processingAt && (
            <div className="text-xs text-muted-foreground">{rail.task.stateTimestamps.processingAt}</div>
          )}
        </section>

        {(rail.task?.failure || rail.delivery.failure) && (
          <section data-testid="handoff-rail-failure" className="mt-4 rounded border border-destructive/30 bg-destructive/[0.05] p-2">
            <div className="text-[11px] uppercase tracking-wider text-destructive">{t('handoffs.failure')}</div>
            <div className="mt-1 whitespace-pre-wrap break-words text-sm">
              {rail.task?.failure?.message ?? rail.delivery.failure?.message}
            </div>
          </section>
        )}

        {rail.task?.result && (
          <section data-testid="handoff-rail-result" className="mt-4 rounded border border-primary/30 bg-primary/[0.05] p-2">
            <div className="text-[11px] uppercase tracking-wider text-primary">{t('handoffs.result')}</div>
            <div className="mt-1 whitespace-pre-wrap break-words text-sm">{rail.task.result.preview}</div>
            {evidence && <div data-testid="handoff-rail-evidence" className="mt-2 break-all text-xs text-muted-foreground">{evidence}</div>}
          </section>
        )}
      </div>

      {error && <div data-testid="handoff-rail-error" role="alert" className="border-t border-foreground/10 px-4 py-2 text-sm text-destructive">{error}</div>}

      <div className="flex flex-col gap-2 border-t border-foreground/10 px-4 py-3">
        {rail.actions.includes('read') && (
          <Button type="button" size="sm" disabled={busy !== null} onClick={() => void handleRead()} data-testid="handoff-mark-read">
            {busy === 'read' ? t('handoffs.working') : t('handoffs.markRead')}
          </Button>
        )}
        {rail.actions.includes('cancel') && (
          <>
            <Input
              data-testid="handoff-cancel-reason"
              value={cancelReason}
              onChange={event => setCancelReason(event.target.value)}
              placeholder={t('handoffs.cancelReasonPlaceholder')}
              disabled={busy !== null}
            />
            <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => void handleCancel()} data-testid="handoff-cancel">
              {busy === 'cancel' ? t('handoffs.working') : t('handoffs.cancel')}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
