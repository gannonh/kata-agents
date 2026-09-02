import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { KatacodeTaskRailView } from '@kata-sh/shared/protocol'
import { cn } from '@/lib/utils'

export interface TaskCardProps {
  rail: KatacodeTaskRailView
  onOpen: (rail: KatacodeTaskRailView) => void
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

export function TaskCard({ rail, onOpen }: TaskCardProps) {
  const { t } = useTranslation()
  const summary = rail.resultPreview ?? rail.failureMessage

  return (
    <button
      type="button"
      data-testid={`task-card-${rail.taskId}`}
      data-task-id={rail.taskId}
      onClick={() => onOpen(rail)}
      className={cn(
        'w-full rounded border border-foreground/15 bg-foreground/[0.03] p-3 text-left transition-colors hover:bg-foreground/[0.07]',
        rail.unread && 'border-primary/50 bg-primary/[0.05]',
        rail.reconciliationRequired && 'border-amber-500/60',
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <strong>{t('katacode.cardTitle')}</strong>
        <span data-testid={`task-card-state-${rail.taskId}`} className="text-xs text-muted-foreground">
          {t(stateKey(rail.runtimeState))}
        </span>
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        {t('katacode.owner')} · {rail.ownerBotName} · {rail.repositoryLabel}/{rail.branchLabel}
      </div>
      {rail.progressPercent !== undefined && (
        <div data-testid={`task-card-progress-${rail.taskId}`} className="mt-1 text-xs text-muted-foreground">
          {t('katacode.progress')}: {rail.progressPercent}%
        </div>
      )}
      {rail.tests && (
        <div data-testid={`task-card-tests-${rail.taskId}`} className="mt-1 text-xs text-muted-foreground">
          {t('katacode.tests')}: {rail.tests.passed}/{rail.tests.total}
        </div>
      )}
      <div className="mt-2 line-clamp-3 whitespace-pre-wrap break-words text-sm">
        {rail.prompt}
      </div>
      {rail.reconciliationRequired && (
        <div data-testid={`task-card-reconcile-${rail.taskId}`} className="mt-2 text-xs font-medium text-amber-600">
          {t('katacode.reconciliationRequired')}
        </div>
      )}
      {summary && (
        <div data-testid={`task-card-summary-${rail.taskId}`} className="mt-2 line-clamp-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">
          {summary}
        </div>
      )}
      {rail.unread && (
        <div data-testid={`task-card-unread-${rail.taskId}`} className="mt-2 text-xs font-medium text-primary">
          {t('katacode.unread')}
        </div>
      )}
    </button>
  )
}
