import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { ApprovalCardView } from '@kata-sh/shared/protocol'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface ApprovalCardProps {
  card: ApprovalCardView
  onResolve: (card: ApprovalCardView, choice: 'deny' | 'allow-once', createStandingAllow?: boolean) => void
}

export function ApprovalCard({ card, onResolve }: ApprovalCardProps) {
  const { t } = useTranslation()
  const pending = card.status === 'pending'

  return (
    <div
      data-testid={`approval-card-${card.approvalId}`}
      data-approval-id={card.approvalId}
      data-approval-status={card.status}
      className={cn(
        'w-full rounded border border-foreground/15 bg-foreground/[0.03] p-3 text-left',
        pending && 'border-primary/50 bg-primary/[0.05]',
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <strong>{t('approvals.cardTitle')}</strong>
        <span data-testid={`approval-card-status-${card.approvalId}`} className="text-xs text-muted-foreground">
          {t(
            card.status === 'allowed-once' ? 'approvals.statusAllowedOnce'
              : card.status === 'consumed' ? 'approvals.statusConsumed'
                : card.status === 'denied' ? 'approvals.statusDenied'
                  : card.status === 'expired' ? 'approvals.statusExpired'
                    : card.status === 'stale' ? 'approvals.statusStale'
                      : 'approvals.statusPending',
          )}
        </span>
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        {t('approvals.toolTarget', { tool: card.toolName, target: card.target })}
      </div>
      <div data-testid={`approval-card-preview-${card.approvalId}`} className="mt-2 line-clamp-4 whitespace-pre-wrap break-words text-sm">
        {card.preview}
      </div>
      {pending && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" data-testid={`approval-deny-${card.approvalId}`} onClick={() => onResolve(card, 'deny')}>
            {t('approvals.deny')}
          </Button>
          <Button type="button" size="sm" data-testid={`approval-allow-once-${card.approvalId}`} onClick={() => onResolve(card, 'allow-once')}>
            {t('approvals.allowOnce')}
          </Button>
          <Button type="button" size="sm" variant="outline" data-testid={`approval-always-${card.approvalId}`} onClick={() => onResolve(card, 'allow-once', true)}>
            {t('approvals.alwaysAllowExact')}
          </Button>
        </div>
      )}
    </div>
  )
}
