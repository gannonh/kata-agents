import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { HandoffRailView } from '@kata-sh/shared/protocol'
import { cn } from '@/lib/utils'
import { handoffStateLabel } from './state-label'

export interface HandoffCardProps {
  rail: HandoffRailView
  onOpen: (rail: HandoffRailView) => void
}

export function HandoffCard({ rail, onOpen }: HandoffCardProps) {
  const { t } = useTranslation()
  const runtimeState = handoffStateLabel(t, rail)
  const terminalSummary = rail.task?.result?.preview
    ?? rail.task?.failure?.message
    ?? rail.delivery.failure?.message

  return (
    <button
      type="button"
      data-testid={`handoff-card-${rail.handoffId}`}
      data-handoff-id={rail.handoffId}
      onClick={() => onOpen(rail)}
      className={cn(
        'w-full rounded border border-foreground/15 bg-foreground/[0.03] p-3 text-left transition-colors hover:bg-foreground/[0.07]',
        rail.unread && 'border-primary/50 bg-primary/[0.05]',
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <strong>{t('handoffs.cardTitle')}</strong>
        <span data-testid={`handoff-card-state-${rail.handoffId}`} className="text-xs text-muted-foreground">
          {runtimeState}
        </span>
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        {t('handoffs.cardRoute', { source: rail.sourceBotName, target: rail.targetBotName })}
      </div>
      <div className="mt-2 line-clamp-3 whitespace-pre-wrap break-words text-sm">
        {rail.delivery.request}
      </div>
      {terminalSummary && (
        <div data-testid={`handoff-card-summary-${rail.handoffId}`} className="mt-2 line-clamp-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">
          {terminalSummary}
        </div>
      )}
      {rail.unread && (
        <div data-testid={`handoff-card-unread-${rail.handoffId}`} className="mt-2 text-xs font-medium text-primary">
          {t('handoffs.unread')}
        </div>
      )}
    </button>
  )
}
