/**
 * GitActionControl — adaptive header Git control (spec: AC12–AC16).
 *
 * Renders the pure resolver's primary action as a button plus an adjacent menu
 * that independently exposes each currently valid Commit / Push / Create|View PR
 * action. Compound actions run their stages in order and report partial success;
 * default-branch mutations require an explicit confirmation. Disabled states
 * explain why and suggest a next step. Feature-flag gated and hidden for non-Git
 * checkouts so the ordinary chat header is unchanged when the feature is off.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ChevronDown, GitCommitHorizontal, Loader2 } from 'lucide-react'
import { FEATURE_FLAGS } from '@kata-sh/shared/feature-flags'
import {
  resolveGitAction,
  buildGitMenu,
  type GitActionResolverInput,
} from '@kata-sh/shared/git'
import type {
  GitActionResult,
  GitActionStageResult,
  GitHubCapabilityStatus,
  PullRequestSummary,
} from '@kata-sh/shared/protocol'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from '@kata-sh/ui'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipTrigger, TooltipContent } from '@kata-sh/ui'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useRegisterModal } from '@/context/ModalContext'
import { useSession } from '@/context/AppShellContext'
import { refreshGitStatus } from '@/atoms/git-status'
import { useGitStatusSubscription } from './useGitStatusSubscription'
import { CommitDialog } from './CommitDialog'
import { PullRequestDialog } from './PullRequestDialog'
import { primaryActionLabelKey, disabledExplanation } from './git-action-labels'

export interface GitActionControlProps {
  sessionId: string
}

type CommitMode = 'commit' | 'commit-push' | 'commit-push-pr'

function firstLine(text: string): string {
  const line = text.split('\n')[0]?.trim() ?? ''
  return line
}

function successTitleKey(stage: GitActionStageResult['stage']): string {
  switch (stage) {
    case 'commit':
      return 'git.toast.committed'
    case 'push':
      return 'git.toast.pushed'
    case 'pull':
      return 'git.toast.pulled'
    case 'create-pr':
      return 'git.toast.prCreated'
  }
}

function failTitleKey(stage: GitActionStageResult['stage']): string {
  switch (stage) {
    case 'commit':
      return 'git.toast.commitFailed'
    case 'push':
      return 'git.toast.pushFailed'
    case 'pull':
      return 'git.toast.pullFailed'
    case 'create-pr':
      return 'git.toast.prFailed'
  }
}

export function GitActionControl({ sessionId }: GitActionControlProps) {
  const { t } = useTranslation()
  const flagEnabled = FEATURE_FLAGS.gitWorkspaceV1
  const session = useSession(sessionId)
  const { status } = useGitStatusSubscription(sessionId, flagEnabled)

  const [capability, setCapability] = React.useState<GitHubCapabilityStatus | null>(null)
  const [pullRequest, setPullRequest] = React.useState<PullRequestSummary | null>(null)
  const [busy, setBusy] = React.useState(false)

  const [commitOpen, setCommitOpen] = React.useState(false)
  const [commitMode, setCommitMode] = React.useState<CommitMode>('commit')
  const [prOpen, setPrOpen] = React.useState(false)
  const [prDefaults, setPrDefaults] = React.useState<{ title: string; body: string }>({
    title: '',
    body: '',
  })

  const isGit = !!status?.isGitRepository
  const provider = status?.provider
  const branch = status?.currentBranch

  const refetchGitHub = React.useCallback(async () => {
    if (!flagEnabled || provider !== 'github') {
      setCapability(null)
      setPullRequest(null)
      return
    }
    try {
      const cap = await window.electronAPI.getGitHubCapability(sessionId)
      setCapability(cap)
    } catch {
      /* capability probe failures are non-fatal */
    }
    try {
      // PR lookup failure must never block commit/push.
      const pr = await window.electronAPI.getPullRequest(sessionId)
      setPullRequest(pr)
    } catch {
      setPullRequest(null)
    }
  }, [flagEnabled, provider, sessionId])

  React.useEffect(() => {
    if (!flagEnabled || !isGit) return
    void refetchGitHub()
    // Refetch on branch change so View/Create PR stays accurate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flagEnabled, isGit, provider, branch, sessionId])

  const pullRequestsAvailable =
    provider === 'github' && !!capability?.installed && !!capability?.authenticated

  const resolverInput: GitActionResolverInput = {
    busy,
    status,
    pullRequest,
    pullRequestsAvailable,
  }
  const primary = resolveGitAction(resolverInput)
  const menu = buildGitMenu(resolverInput)
  const hasMenu = menu.commit || menu.push || menu.createPr || menu.viewPr

  const isDefaultBranch = !!branch && branch === status?.defaultRef

  // --- stage execution + reporting -----------------------------------------

  const report = React.useCallback(
    (result: GitActionResult) => {
      for (const stage of result.stages) {
        if (stage.status === 'succeeded') {
          toast.success(t(successTitleKey(stage.stage)), {
            description: stage.recoveryCommand
              ? t('git.toast.commitReconcileWarning', { command: stage.recoveryCommand })
              : undefined,
          })
        } else if (stage.status === 'failed') {
          toast.error(t(failTitleKey(stage.stage)), { description: stage.error })
        }
      }
      void refreshGitStatus(sessionId)
      void refetchGitHub()
    },
    [sessionId, refetchGitHub, t],
  )

  const run = React.useCallback(
    async (op: () => Promise<GitActionResult>) => {
      setBusy(true)
      try {
        const result = await op()
        report(result)
        return result
      } catch (err) {
        toast.error(t('git.toast.actionFailed'), {
          description: err instanceof Error ? err.message : String(err),
        })
        return null
      } finally {
        setBusy(false)
      }
    },
    [report, t],
  )

  const openCommit = React.useCallback((mode: CommitMode) => {
    setCommitMode(mode)
    setCommitOpen(true)
  }, [])

  const openPr = React.useCallback(() => {
    const latest = pullRequest?.title
    setPrDefaults({ title: latest || firstLine(session?.name ?? '') || (branch ?? ''), body: '' })
    setPrOpen(true)
  }, [pullRequest, session?.name, branch])

  const doPush = React.useCallback(
    () => window.electronAPI.pushGit(sessionId),
    [sessionId],
  )

  const withDefaultBranchConfirm = React.useCallback(
    (proceed: () => void) => {
      if (isDefaultBranch) {
        setConfirm({ open: true, onConfirm: proceed })
      } else {
        proceed()
      }
    },
    [isDefaultBranch],
  )

  const [confirm, setConfirm] = React.useState<{ open: boolean; onConfirm: (() => void) | null }>({
    open: false,
    onConfirm: null,
  })

  const executePrimary = React.useCallback(() => {
    switch (primary.kind) {
      case 'commit':
        openCommit('commit')
        break
      case 'commit-push':
        openCommit('commit-push')
        break
      case 'commit-push-pr':
        openCommit('commit-push-pr')
        break
      case 'push':
        void run(doPush)
        break
      case 'push-pr':
      case 'create-pr':
        openPr()
        break
      case 'pull':
        void run(() => window.electronAPI.pullGit(sessionId))
        break
      case 'view-pr':
        if (pullRequest) void window.electronAPI.openUrl(pullRequest.url)
        break
      default:
        break
    }
  }, [primary.kind, openCommit, openPr, run, doPush, sessionId, pullRequest])

  const startPrimary = React.useCallback(() => {
    if (primary.disabled) return
    if (primary.requiresDefaultBranchConfirmation) {
      setConfirm({ open: true, onConfirm: executePrimary })
    } else {
      executePrimary()
    }
  }, [primary.disabled, primary.requiresDefaultBranchConfirmation, executePrimary])

  const handleCommitSubmit = React.useCallback(
    async (message: string, paths: string[]) => {
      const commitRes = await run(() =>
        window.electronAPI.commitGit({ sessionId, message, paths }),
      )
      const committed = commitRes?.stages.some(
        (s) => s.stage === 'commit' && s.status === 'succeeded',
      )
      if (!committed) return
      setCommitOpen(false)
      if (commitMode === 'commit-push') {
        await run(doPush)
      } else if (commitMode === 'commit-push-pr') {
        setPrDefaults({ title: firstLine(message), body: '' })
        setPrOpen(true)
      }
    },
    [run, sessionId, commitMode, doPush],
  )

  const handlePrSubmit = React.useCallback(
    async (title: string, body: string) => {
      const res = await run(() =>
        window.electronAPI.createPullRequest({ sessionId, title, body }),
      )
      if (res && !res.stages.some((s) => s.status === 'failed')) {
        setPrOpen(false)
      }
    },
    [run, sessionId],
  )

  // --- render ---------------------------------------------------------------

  if (!flagEnabled || !isGit) return null

  const primaryLabel = primary.disabled
    ? t(disabledExplanation(primary.disabledReason).labelKey)
    : t(primaryActionLabelKey(primary.kind))
  const primaryHint = primary.disabled
    ? t(disabledExplanation(primary.disabledReason).hintKey)
    : primaryLabel

  return (
    <>
      <div className="inline-flex shrink-0 items-stretch titlebar-no-drag">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={startPrimary}
              disabled={primary.disabled || busy}
              data-git-action-primary
              aria-label={primaryLabel}
              className={cn(
                'panel-header-btn inline-flex items-center gap-1.5 h-7 px-2 text-[12px] font-medium',
                'bg-background shadow-minimal transition-opacity',
                hasMenu ? 'rounded-l-[6px]' : 'rounded-[6px]',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                primary.disabled ? 'opacity-60' : 'opacity-90 hover:opacity-100',
              )}
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <GitCommitHorizontal className="h-3.5 w-3.5 shrink-0" />
              )}
              <span className="truncate">{primaryLabel}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>{primaryHint}</TooltipContent>
        </Tooltip>

        {hasMenu && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t('git.action.menuLabel')}
                data-git-action-menu
                disabled={busy}
                className={cn(
                  'panel-header-btn inline-flex items-center h-7 px-1 rounded-r-[6px]',
                  'border-l border-border/40 bg-background shadow-minimal',
                  'opacity-90 hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                )}
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <StyledDropdownMenuContent align="end">
              {menu.commit && (
                <StyledDropdownMenuItem onClick={() => openCommit('commit')}>
                  {t('git.action.commit')}
                </StyledDropdownMenuItem>
              )}
              {menu.push && (
                <StyledDropdownMenuItem
                  onClick={() => withDefaultBranchConfirm(() => void run(doPush))}
                >
                  {t('git.action.push')}
                </StyledDropdownMenuItem>
              )}
              {menu.createPr && (
                <StyledDropdownMenuItem onClick={openPr}>
                  {t('git.action.createPr')}
                </StyledDropdownMenuItem>
              )}
              {menu.viewPr && (
                <StyledDropdownMenuItem
                  onClick={() => pullRequest && void window.electronAPI.openUrl(pullRequest.url)}
                >
                  {t('git.action.viewPr')}
                </StyledDropdownMenuItem>
              )}
            </StyledDropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <CommitDialog
        open={commitOpen}
        onOpenChange={setCommitOpen}
        entries={status?.entries ?? []}
        defaultMessage={session?.name ?? ''}
        defaultBranchName={isDefaultBranch ? branch : null}
        busy={busy}
        onCommit={handleCommitSubmit}
      />

      <PullRequestDialog
        open={prOpen}
        onOpenChange={setPrOpen}
        defaultTitle={prDefaults.title}
        defaultBody={prDefaults.body}
        baseRef={session?.checkout?.baseRef ?? status?.defaultRef ?? null}
        busy={busy}
        onCreate={handlePrSubmit}
      />

      <DefaultBranchConfirm
        open={confirm.open}
        branch={branch ?? ''}
        onOpenChange={(open) => setConfirm((c) => ({ ...c, open }))}
        onConfirm={() => {
          const fn = confirm.onConfirm
          setConfirm({ open: false, onConfirm: null })
          fn?.()
        }}
      />
    </>
  )
}

function DefaultBranchConfirm({
  open,
  branch,
  onOpenChange,
  onConfirm,
}: {
  open: boolean
  branch: string
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  const { t } = useTranslation()
  useRegisterModal(open, () => onOpenChange(false))
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{t('git.confirm.defaultBranchTitle')}</DialogTitle>
          <DialogDescription>
            {t('git.confirm.defaultBranchBody', { branch })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={onConfirm}>{t('git.confirm.continue')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
