/**
 * ForkAction — fork recovery surface + Worktree V2 capability hook.
 *
 * `ForkRecoveryBadge` polls FORK_STATUS for the bound session and renders a
 * recovery affordance while a fork transaction is active (pending or
 * recovery-required), mirroring HandoffRecoveryBadge. Quiet when inactive.
 *
 * `useForkCapability` resolves whether the workspace-owning server has Worktree
 * V2 effective; the Branch action only opens the fork dialog when V2 is on and
 * otherwise keeps the immediate shared-branch behavior byte-identical.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, TriangleAlert } from 'lucide-react'

import type { ConversationForkStatus } from '@kata-sh/shared/protocol'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@kata-sh/ui'

/**
 * Resolve Worktree V2 effectiveness from the workspace-owning server. V2 is
 * governed by the server's feature flag, not by the local renderer
 * environment; a V1-only server keeps the immediate shared-branch flow.
 */
export function useForkCapability(): { v2Effective: boolean; v2Pending: boolean } {
  const [v2Effective, setV2Effective] = React.useState(false)
  const [v2Pending, setV2Pending] = React.useState(true)

  React.useEffect(() => {
    let cancelled = false
    window.electronAPI
      ?.getGitCapabilities?.()
      .then((capability) => {
        if (cancelled) return
        setV2Effective(!!capability?.worktreeV2)
        setV2Pending(false)
      })
      .catch(() => {
        if (!cancelled) {
          setV2Effective(false)
          setV2Pending(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  return { v2Effective, v2Pending }
}

/**
 * Polls FORK_STATUS for the bound session and renders a recovery affordance
 * while a fork transaction is pending/recovery-required. Quiet when inactive.
 */
export function ForkRecoveryBadge({
  sessionId,
  onRecover,
}: {
  sessionId: string
  /** Called with the active status so the caller can open recovery UI. */
  onRecover: (status: Extract<ConversationForkStatus, { active: true }>) => void
}) {
  const { t } = useTranslation()
  const [status, setStatus] = React.useState<ConversationForkStatus>({ active: false })
  const [checking, setChecking] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    const poll = async () => {
      setChecking(true)
      try {
        const next = await window.electronAPI.forkStatus({ sessionId })
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
          data-testid="fork-recovery-badge"
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
          {t('git.fork.statusActive')}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t('git.fork.recoveryHint')}</TooltipContent>
    </Tooltip>
  )
}
