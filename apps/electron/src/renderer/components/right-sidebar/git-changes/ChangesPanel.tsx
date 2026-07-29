/**
 * ChangesPanel — the Changes review surface (right sidebar / narrow drawer).
 *
 * Binds to a single focused session (spec: multi-panel Changes binds only to the
 * focused session panel). Shows checkout identity + refresh state, aggregate
 * file/line counts, a flat changed-file list, the selected file's diff, and the
 * batched line-feedback control. Renders explicit clean / non-Git / loading /
 * error states.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue } from 'jotai'
import {
  X,
  GitBranch,
  GitFork,
  Users,
  Loader2,
  RefreshCw,
  Columns2,
  Rows2,
  Send,
  FolderGit2,
} from 'lucide-react'
import { FEATURE_FLAGS } from '@kata-sh/shared/feature-flags'
import {
  deriveStatusSummary,
  sortStatusEntries,
  changeIndicator,
  summarizePendingComments,
  serializeFeedback,
} from '@kata-sh/shared/git'
import type { GitWorkingTreeEntry } from '@kata-sh/shared/protocol'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipTrigger, TooltipContent } from '@kata-sh/ui'
import { useAppShellContext, useSession } from '@/context/AppShellContext'
import { useNavigation } from '@/contexts/NavigationContext'
import { sessionPendingCommentsAtomFamily, clearSessionComments } from '@/atoms/git-comments'
import { useGitStatusSubscription } from './useGitStatusSubscription'
import { ChangesDiffView } from './ChangesDiffView'

export interface ChangesPanelProps {
  sessionId: string | null
}

const INDICATOR_COLOR: Record<string, string> = {
  M: 'text-amber-600 dark:text-amber-400',
  A: 'text-emerald-600 dark:text-emerald-400',
  D: 'text-rose-600 dark:text-rose-400',
  R: 'text-sky-600 dark:text-sky-400',
  U: 'text-violet-600 dark:text-violet-400',
  C: 'text-sky-600 dark:text-sky-400',
}

function FileRow({
  entry,
  selected,
  onSelect,
}: {
  entry: GitWorkingTreeEntry
  selected: boolean
  onSelect: () => void
}) {
  const indicator = changeIndicator(entry.type)
  const name = entry.path.split('/').pop() || entry.path
  const dir = entry.path.slice(0, entry.path.length - name.length)
  return (
    <button
      type="button"
      onClick={onSelect}
      title={entry.previousPath ? `${entry.previousPath} → ${entry.path}` : entry.path}
      className={cn(
        'group flex w-full items-center gap-2 rounded-[6px] px-2 py-[5px] text-left text-[13px]',
        'hover:bg-sidebar-hover transition-colors',
        selected && 'bg-sidebar-hover',
      )}
    >
      <span className={cn('w-3 shrink-0 text-center font-mono text-[11px] font-semibold', INDICATOR_COLOR[indicator])}>
        {indicator}
      </span>
      <span className="min-w-0 flex-1 truncate">
        {dir && <span className="text-muted-foreground">{dir}</span>}
        <span>{name}</span>
      </span>
      {(entry.additions !== undefined || entry.deletions !== undefined) && !entry.binary && (
        <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">
          <span className="text-emerald-600 dark:text-emerald-400">+{entry.additions ?? 0}</span>{' '}
          <span className="text-rose-600 dark:text-rose-400">-{entry.deletions ?? 0}</span>
        </span>
      )}
    </button>
  )
}

export function ChangesPanel({ sessionId }: ChangesPanelProps) {
  const { t } = useTranslation()
  const flagEnabled = FEATURE_FLAGS.gitWorkspaceV1
  const { updateRightSidebar } = useNavigation()
  const { onSendMessage } = useAppShellContext()
  const session = useSession(sessionId ?? '__no_session__')

  const { status, loading, error, lastUpdatedAt } = useGitStatusSubscription(sessionId ?? undefined, flagEnabled)
  const summary = deriveStatusSummary(status)

  const [selectedPath, setSelectedPath] = React.useState<string | null>(null)
  const [diffStyle, setDiffStyle] = React.useState<'unified' | 'split'>('unified')

  // Reset the selected file whenever the bound session changes so status and
  // feedback never leak between sessions.
  React.useEffect(() => {
    setSelectedPath(null)
  }, [sessionId])

  const entries = React.useMemo(
    () => (status ? sortStatusEntries(status.entries) : []),
    [status],
  )

  // Keep the selection valid as status refreshes; clear it if the file is gone.
  React.useEffect(() => {
    if (selectedPath && !entries.some((e) => e.path === selectedPath)) {
      setSelectedPath(null)
    }
  }, [entries, selectedPath])

  const comments = useAtomValue(sessionPendingCommentsAtomFamily(sessionId ?? '__no_session__'))
  const feedback = summarizePendingComments(comments)

  const handleSend = React.useCallback(() => {
    if (!sessionId || !feedback.canSend) return
    const message = serializeFeedback(comments)
    onSendMessage(sessionId, message)
    clearSessionComments(sessionId)
  }, [sessionId, feedback.canSend, comments, onSendMessage])

  const close = React.useCallback(() => updateRightSidebar({ type: 'none' }), [updateRightSidebar])

  // Checkout identity.
  const checkout = session?.checkout
  const sharedOwnerCount = session?.sharedOwnerCount ?? 0
  const isWorktree = checkout?.mode === 'managed-worktree'
  const isShared = isWorktree && sharedOwnerCount > 1
  const branch = status?.detached
    ? t('git.workspace.detached')
    : status?.currentBranch ?? checkout?.expectedBranch ?? checkout?.branchAtPreparation ?? t('git.workspace.currentCheckout')

  const identityIcon = isShared ? (
    <Users className="h-3.5 w-3.5" />
  ) : isWorktree ? (
    <GitFork className="h-3.5 w-3.5" />
  ) : (
    <GitBranch className="h-3.5 w-3.5" />
  )
  const identityLabel = isShared
    ? t('git.workspace.sharedWorktree')
    : isWorktree
      ? t('git.workspace.worktree')
      : t('git.workspace.currentCheckout')

  const header = (
    <div className="shrink-0 border-b border-border/50">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium">
          <FolderGit2 className="h-4 w-4 shrink-0" />
          {t('git.changes.title')}
        </span>
        <div className="flex items-center gap-1">
          {summary.kind !== 'non-git' && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setDiffStyle((s) => (s === 'unified' ? 'split' : 'unified'))}
                    aria-label={t('git.changes.toggleDiffStyle')}
                    className="rounded-[6px] p-1.5 opacity-70 hover:bg-foreground/5 hover:opacity-100"
                  >
                    {diffStyle === 'unified' ? <Columns2 className="h-4 w-4" /> : <Rows2 className="h-4 w-4" />}
                  </button>
                </TooltipTrigger>
                <TooltipContent>{t('git.changes.toggleDiffStyle')}</TooltipContent>
              </Tooltip>
            </>
          )}
          <button
            type="button"
            onClick={close}
            aria-label={t('common.close')}
            className="rounded-[6px] p-1.5 opacity-70 hover:bg-foreground/5 hover:opacity-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      {summary.isGitRepository && (
        <div className="flex items-center justify-between px-3 pb-2 text-[12px] text-muted-foreground">
          <span className="flex min-w-0 items-center gap-1.5">
            {identityIcon}
            <span className="truncate" title={branch}>
              {identityLabel} · {branch}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {loading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : lastUpdatedAt ? (
              <RefreshCw className="h-3 w-3 opacity-60" />
            ) : null}
            {!summary.isClean && (
              <span className="tabular-nums">
                {t('git.changes.fileCount', { count: summary.changedFileCount })}{' '}
                <span className="text-emerald-600 dark:text-emerald-400">+{summary.additions}</span>{' '}
                <span className="text-rose-600 dark:text-rose-400">-{summary.deletions}</span>
              </span>
            )}
          </span>
        </div>
      )}
    </div>
  )

  let body: React.ReactNode
  if (!sessionId) {
    body = (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        {t('git.changes.noSession')}
      </div>
    )
  } else if (loading && !status) {
    body = (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    )
  } else if (error) {
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
        <p className="font-medium">{t('git.changes.statusError')}</p>
        <p className="text-xs opacity-70">{error}</p>
      </div>
    )
  } else if (!summary.isGitRepository) {
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
        <FolderGit2 className="h-6 w-6" />
        <p className="font-medium">{t('git.changes.notGit')}</p>
        <p className="text-xs opacity-70">{t('git.changes.notGitDetail')}</p>
      </div>
    )
  } else if (summary.isClean) {
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
        <GitBranch className="h-6 w-6" />
        <p className="font-medium">{t('git.changes.clean')}</p>
        <p className="text-xs opacity-70">{t('git.changes.cleanDetail')}</p>
      </div>
    )
  } else {
    body = (
      <div className="flex h-full min-h-0 flex-col">
        <div
          className={cn(
            'overflow-y-auto p-1',
            selectedPath ? 'max-h-[35%] shrink-0 border-b border-border/50' : 'flex-1',
          )}
        >
          {entries.map((entry) => (
            <FileRow
              key={entry.path}
              entry={entry}
              selected={entry.path === selectedPath}
              onSelect={() => setSelectedPath(entry.path)}
            />
          ))}
        </div>
        {selectedPath && (
          <div className="min-h-0 flex-1 overflow-hidden">
            <ChangesDiffView sessionId={sessionId} path={selectedPath} diffStyle={diffStyle} />
          </div>
        )}
      </div>
    )
  }

  const feedbackBar =
    sessionId && feedback.pendingCount > 0 ? (
      <div className="shrink-0 border-t border-border/50 p-2">
        {feedback.requiresReview && (
          <p className="px-1 pb-1.5 text-[11px] text-amber-600 dark:text-amber-400">
            {t('git.changes.reviewStale', { count: feedback.staleCount })}
          </p>
        )}
        <button
          type="button"
          onClick={handleSend}
          disabled={!feedback.canSend}
          className={cn(
            'flex w-full items-center justify-center gap-2 rounded-[6px] bg-foreground px-3 py-1.5 text-[13px] font-medium text-background transition-opacity',
            !feedback.canSend && 'opacity-50',
          )}
        >
          <Send className="h-3.5 w-3.5" />
          {t('git.changes.sendFeedback', { count: feedback.pendingCount })}
        </button>
      </div>
    ) : null

  return (
    <div className="flex h-full min-h-0 flex-col">
      {header}
      <div className="min-h-0 flex-1 overflow-hidden">{body}</div>
      {feedbackBar}
    </div>
  )
}
