/**
 * HandoffAction — the handoff surface for a bound session.
 *
 * `HandoffButton` offers the structurally-possible directions for the session's
 * checkout (current-to-managed / managed-to-current / hand-back) and opens the
 * preview/confirm dialog; `HandoffRecoveryBadge` surfaces an active
 * (pending/recovery) handoff transaction so the user can open recovery.
 *
 * The server remains authoritative: a structurally possible direction still
 * returns a typed blocker (unsupported provider, dirty destination, shared
 * owners, …) which the dialog renders.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeftRight, Loader2, TriangleAlert } from 'lucide-react'

import type { WorktreeHandoffDirection, WorktreeHandoffStatus } from '@kata-sh/shared/protocol'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@kata-sh/ui'

import { handoffDirectionsForCheckout } from '../input/handoff-controls'
import { HandoffDialog } from './HandoffDialog'

export interface HandoffActionProps {
  sessionId: string
  /** Client-visible checkout metadata for direction gating. */
  checkout: { mode: 'current' | 'managed-worktree' } | undefined
  /** Persisted handoff runtime state (armed → a prior handoff completed). */
  handoffRuntimeState?: string | null
  /** True when the session's workspace is owned by a remote server. */
  isRemoteWorkspace?: boolean
}

/** Small control that opens the handoff dialog for a chosen direction. */
export function HandoffButton({
  sessionId,
  checkout,
  handoffRuntimeState,
  isRemoteWorkspace,
}: HandoffActionProps) {
  const { t } = useTranslation()
  const [direction, setDirection] = React.useState<WorktreeHandoffDirection | null>(null)

  const directions = handoffDirectionsForCheckout(
    checkout
      ? ({ mode: checkout.mode } as Parameters<typeof handoffDirectionsForCheckout>[0])
      : undefined,
    handoffRuntimeState,
  )
  if (directions.length === 0) return null

  const directionLabel = (dir: WorktreeHandoffDirection): string => {
    switch (dir) {
      case 'current-to-managed':
        return t('git.handoff.direction.current-to-managed')
      case 'managed-to-current':
        return t('git.handoff.direction.managed-to-current')
      case 'hand-back':
        return t('git.handoff.direction.hand-back')
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            data-testid="handoff-open-button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-[12px] text-muted-foreground hover:text-foreground"
          >
            <ArrowLeftRight className="h-3.5 w-3.5" />
            {t('git.handoff.action')}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[200px]">
          {directions.map((dir) => (
            <DropdownMenuItem key={dir} data-testid={`handoff-direction-${dir}`} onSelect={() => setDirection(dir)}>
              {directionLabel(dir)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {direction && (
        <HandoffDialog
          open
          sessionId={sessionId}
          direction={direction}
          isRemoteWorkspace={isRemoteWorkspace}
          onOpenChange={(open) => {
            if (!open) setDirection(null)
          }}
        />
      )}
    </>
  )
}

/**
 * Polls HANDOFF_STATUS for the bound session and renders a recovery affordance
 * while a transaction is pending/recovery-required. Quiet when inactive.
 */
export function HandoffRecoveryBadge({
  sessionId,
  onRecover,
}: {
  sessionId: string
  /** Called with the active status so the caller can open recovery UI. */
  onRecover: (status: Extract<WorktreeHandoffStatus, { active: true }>) => void
}) {
  const { t } = useTranslation()
  const [status, setStatus] = React.useState<WorktreeHandoffStatus>({ active: false })
  const [checking, setChecking] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    const poll = async () => {
      setChecking(true)
      try {
        const next = await window.electronAPI.handoffStatus({ sessionId })
        if (!cancelled) setStatus(next)
      } catch {
        // Transient server/unreachable states are quiet; the next poll retries.
      } finally {
        if (!cancelled) setChecking(false)
      }
    }
    void poll()
    const interval = window.setInterval(poll, 15_000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [sessionId])

  if (!status.active) return null

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          data-testid="handoff-recovery-badge"
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-[12px] text-rose-600 hover:text-rose-500 dark:text-rose-400"
          onClick={() => onRecover(status)}
        >
          {checking ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <TriangleAlert className="h-3.5 w-3.5" />
          )}
          {t('git.handoff.statusActive')}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t('git.handoff.recoveryHint')}</TooltipContent>
    </Tooltip>
  )
}
