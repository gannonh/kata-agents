import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { KatacodeTaskRailView } from '@kata-sh/shared/protocol'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useNavigation } from '@/contexts/NavigationContext'

export interface TaskRailProps {
  conversationId: string
  taskId: string
}

function isAtLeastFresh(next: KatacodeTaskRailView, current: KatacodeTaskRailView | null): boolean {
  if (!current) return true
  return next.freshness.taskVersion >= current.freshness.taskVersion
    && next.freshness.journalSequence >= current.freshness.journalSequence
}

function stateKey(state: KatacodeTaskRailView['runtimeState']): string {
  switch (state) {
    case 'queued': return 'katacode.stateQueued'
    case 'processing': return 'katacode.stateProcessing'
    case 'awaiting-input': return 'katacode.stateAwaitingInput'
    case 'completed': return 'katacode.stateCompleted'
    case 'failed': return 'katacode.stateFailed'
    case 'cancelled': return 'katacode.stateCancelled'
  }
}

export function TaskRail({ conversationId, taskId }: TaskRailProps) {
  const { t } = useTranslation()
  const { updateRightSidebar } = useNavigation()
  const [rail, setRail] = React.useState<KatacodeTaskRailView | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<'cancel' | 'retry' | 'read' | 'reconcile' | null>(null)
  const [cancelReason, setCancelReason] = React.useState('')
  const railRef = React.useRef<KatacodeTaskRailView | null>(null)

  const applyRail = React.useCallback((next: KatacodeTaskRailView): boolean => {
    if (!isAtLeastFresh(next, railRef.current)) return false
    railRef.current = next
    setRail(next)
    return true
  }, [])

  const refresh = React.useCallback(async () => {
    const next = await window.electronAPI.getKatacodeRail({ conversationId, taskId })
    applyRail(next)
    setError(null)
  }, [conversationId, taskId, applyRail])

  React.useEffect(() => {
    let disposed = false
    const waitId = crypto.randomUUID()
    const onError = (err: unknown) => {
      if (!disposed) setError(err instanceof Error ? err.message : String(err))
    }
    const unsubscribe = window.electronAPI.onKatacodeEvent(event => {
      if (event.conversationId !== conversationId || event.taskId !== taskId) return
      refresh().catch(onError)
    })
    const waitForChanges = async () => {
      try {
        await refresh()
        while (!disposed) {
          const current = railRef.current
          if (!current) continue
          const next = await window.electronAPI.waitForKatacode({
            waitId,
            conversationId,
            taskId,
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
      void window.electronAPI.cancelKatacodeWait({ waitId }).catch(onError)
    }
  }, [conversationId, taskId, refresh, applyRail])

  if (!rail) {
    return (
      <div data-testid="task-rail-loading" className="p-4 text-sm text-muted-foreground">
        {t('katacode.loading')}
      </div>
    )
  }

  const canCancel = rail.actions.includes('cancel')
  const canRetry = rail.actions.includes('retry')
  const canOpen = rail.actions.includes('open') && rail.deepLink?.url
  const canRead = rail.actions.includes('read') && rail.runtimeState === 'completed' && rail.unread

  return (
    <div data-testid={`task-rail-${rail.taskId}`} className="flex h-full flex-col gap-4 overflow-auto p-4">
      <div>
        <h2 className="text-sm font-semibold">{t('katacode.railTitle')}</h2>
        <div data-testid="task-rail-state" className="mt-1 text-xs text-muted-foreground">
          {t(stateKey(rail.runtimeState))}
        </div>
      </div>
      <div className="text-xs text-muted-foreground">
        {t('katacode.owner')}: {rail.ownerBotName}
      </div>
      <div data-testid="task-rail-repo" className="text-sm">
        {t('katacode.repository')}: {rail.repositoryLabel}
        <div>{t('katacode.branch')}: {rail.branchLabel}</div>
        <div>
          {rail.worktreePolicy === 'shared' ? t('katacode.worktreeShared') : t('katacode.worktreeIsolated')}
        </div>
        {rail.worktreePolicy === 'shared' && (
          <div data-testid="task-rail-shared-warning" className="mt-1 text-xs text-amber-600">
            {t('katacode.sharedCheckoutWarning')}
          </div>
        )}
      </div>
      <section>
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('katacode.prompt')}</h3>
        <p data-testid="task-rail-prompt" className="mt-1 whitespace-pre-wrap break-words text-sm">{rail.prompt}</p>
      </section>
      <section>
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('katacode.acceptanceCriteria')}</h3>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm">{rail.acceptanceCriteria}</p>
      </section>
      {rail.progressPercent !== undefined && (
        <div data-testid="task-rail-progress">{t('katacode.progress')}: {rail.progressPercent}%</div>
      )}
      {rail.tests && (
        <div data-testid="task-rail-tests">
          {t('katacode.tests')}: {rail.tests.passed}/{rail.tests.total}
        </div>
      )}
      {rail.reconciliationRequired && (
        <div data-testid="task-rail-reconcile" className="text-sm text-amber-600">
          {t('katacode.reconciliationRequired')}
          <Button
            type="button"
            size="sm"
            className="ml-2"
            disabled={busy !== null}
            onClick={async () => {
              setBusy('reconcile')
              try {
                applyRail(await window.electronAPI.reconcileKatacode({ conversationId, taskId }))
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err))
              } finally {
                setBusy(null)
              }
            }}
          >
            {t('katacode.reconcile')}
          </Button>
        </div>
      )}
      {rail.failureMessage && (
        <div data-testid="task-rail-failure" className="text-sm text-destructive">{rail.failureMessage}</div>
      )}
      {rail.resultPreview && (
        <section>
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('katacode.result')}</h3>
          <p data-testid="task-rail-result" className="mt-1 whitespace-pre-wrap break-words text-sm">{rail.resultPreview}</p>
        </section>
      )}
      {rail.evidence.length > 0 && (
        <section>
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('katacode.evidence')}</h3>
          <ul data-testid="task-rail-evidence">
            {rail.evidence.map((item) => (
              <li key={`${item.kind}:${item.label}`}>{item.label}</li>
            ))}
          </ul>
        </section>
      )}
      {rail.artifacts.length > 0 && (
        <section>
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('katacode.artifacts')}</h3>
          <ul data-testid="task-rail-artifacts">
            {rail.artifacts.map((item) => (
              <li key={`${item.kind}:${item.label}`}>{item.label}</li>
            ))}
          </ul>
        </section>
      )}
      {rail.pullRequest && (
        <a data-testid="task-rail-pr" href={rail.pullRequest.url} target="_blank" rel="noreferrer">
          {t('katacode.pullRequest')} #{rail.pullRequest.number}
        </a>
      )}
      {rail.diffSummary && (
        <section>
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('katacode.diff')}</h3>
          <div data-testid="task-rail-diff">{rail.diffSummary}</div>
        </section>
      )}
      {error && <div data-testid="task-rail-error" className="text-sm text-destructive">{error}</div>}
      <div className="mt-auto flex flex-col gap-2">
        {canCancel && (
          <>
            <Input
              data-testid="task-cancel-reason"
              value={cancelReason}
              onChange={(event) => setCancelReason(event.target.value)}
              placeholder={t('katacode.cancelReasonPlaceholder')}
            />
            <Button
              type="button"
              data-testid="task-cancel"
              disabled={busy !== null || !cancelReason.trim()}
              onClick={async () => {
                setBusy('cancel')
                try {
                  applyRail(await window.electronAPI.cancelKatacode({
                    conversationId,
                    taskId,
                    reason: cancelReason,
                  }))
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err))
                } finally {
                  setBusy(null)
                }
              }}
            >
              {t('katacode.cancel')}
            </Button>
          </>
        )}
        {canRetry && (
          <Button
            type="button"
            data-testid="task-retry"
            disabled={busy !== null}
            onClick={async () => {
              setBusy('retry')
              try {
                const next = await window.electronAPI.retryKatacode({ conversationId, taskId })
                if (next.taskId !== taskId) {
                  updateRightSidebar({
                    type: 'katacode',
                    conversationId: next.conversationId,
                    taskId: next.taskId,
                  })
                  return
                }
                applyRail(next)
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err))
              } finally {
                setBusy(null)
              }
            }}
          >
            {t('katacode.retry')}
          </Button>
        )}
        {canRead && (
          <Button
            type="button"
            data-testid="task-mark-read"
            disabled={busy !== null}
            onClick={async () => {
              setBusy('read')
              try {
                applyRail(await window.electronAPI.markKatacodeResultRead({
                  conversationId,
                  taskId,
                  expectedTaskVersion: rail.freshness.taskVersion,
                }))
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err))
              } finally {
                setBusy(null)
              }
            }}
          >
            {t('katacode.markRead')}
          </Button>
        )}
        {canOpen && (
          <a data-testid="task-open" href={rail.deepLink!.url} target="_blank" rel="noreferrer">
            {t('katacode.open')}
          </a>
        )}
      </div>
    </div>
  )
}
