/**
 * ChangesAffordance — compact header control showing the active checkout's
 * changed-file count and additions/deletions, and toggling the Changes panel.
 *
 * Feature-flag gated (spec: AC9). Bound to the panel's own session; clicking it
 * focuses this panel (via PanelSlot pointer-down) and opens the Changes surface,
 * which then binds to the focused session. Hidden for non-Git checkouts so the
 * ordinary chat header is unchanged when the feature is off or irrelevant.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { GitBranch } from 'lucide-react'
import { FEATURE_FLAGS } from '@kata-sh/shared/feature-flags'
import { deriveStatusSummary } from '@kata-sh/shared/git'
import { Tooltip, TooltipTrigger, TooltipContent } from '@kata-sh/ui'
import { cn } from '@/lib/utils'
import { useNavigation, useNavigationState } from '@/contexts/NavigationContext'
import { useGitStatusSubscription } from './useGitStatusSubscription'

export interface ChangesAffordanceProps {
  sessionId: string
}

export function ChangesAffordance({ sessionId }: ChangesAffordanceProps) {
  const { t } = useTranslation()
  const flagEnabled = FEATURE_FLAGS.gitWorkspaceV1
  const navState = useNavigationState()
  const { updateRightSidebar } = useNavigation()

  const { status } = useGitStatusSubscription(sessionId, flagEnabled)
  const summary = deriveStatusSummary(status)

  const isOpen = navState.rightSidebar?.type === 'changes'

  const handleClick = React.useCallback(() => {
    updateRightSidebar(isOpen ? { type: 'none' } : { type: 'changes' })
  }, [isOpen, updateRightSidebar])

  // Hidden entirely when the flag is off or the checkout is not a Git repo.
  if (!flagEnabled || !summary.isGitRepository) return null

  const label = summary.isClean
    ? t('git.changes.noChanges')
    : t('git.changes.fileCount', { count: summary.changedFileCount })

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={handleClick}
          aria-label={t('git.changes.title')}
          aria-pressed={isOpen}
          data-changes-affordance
          data-testid="git-changes-affordance"
          className={cn(
            'panel-header-btn inline-flex items-center gap-1.5 shrink-0 titlebar-no-drag',
            'h-7 rounded-[6px] px-2 text-[12px] font-medium',
            'bg-background shadow-minimal transition-opacity',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            isOpen ? 'opacity-100' : 'opacity-70 hover:opacity-100',
          )}
        >
          <GitBranch className="h-3.5 w-3.5 shrink-0" />
          <span className="tabular-nums">{label}</span>
          {!summary.isClean && (
            <span className="flex items-center gap-1 tabular-nums">
              <span className="text-emerald-600 dark:text-emerald-400">+{summary.additions}</span>
              <span className="text-rose-600 dark:text-rose-400">-{summary.deletions}</span>
            </span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent>{t('git.changes.title')}</TooltipContent>
    </Tooltip>
  )
}
