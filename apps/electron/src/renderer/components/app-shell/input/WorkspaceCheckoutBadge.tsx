import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Command as CommandPrimitive } from 'cmdk'
import { Check, GitBranch, GitFork, Loader2 } from 'lucide-react'

import { FEATURE_FLAGS } from '@kata-sh/shared/feature-flags'
import type {
  CheckoutMode,
  CheckoutPrepareResult,
  GitRef,
  RepositoryContext,
} from '@kata-sh/shared/protocol'

import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

import { FreeFormInputContextBadge } from './FreeFormInputContextBadge'

/**
 * WorkspaceCheckoutBadge — composer Workspace control for Git checkouts.
 *
 * Feature-flag gated by {@link FEATURE_FLAGS.gitWorkspaceV1}. Before the first
 * message in a Git repository it offers a Workspace menu with **Current
 * checkout** and **New worktree**; selecting New worktree reveals a searchable
 * **From `<ref>`** picker defaulting to the current branch. Preparing a managed
 * worktree happens on the workspace-owning server via `prepareGitCheckout`; on
 * success the controls lock and show the checkout identity even if the
 * subsequent message send fails. Non-Git directories render nothing so the
 * ordinary working-directory experience is retained.
 */
export interface WorkspaceCheckoutBadgeProps {
  sessionId?: string
  workingDirectory?: string
  isEmptySession?: boolean
  onWorkingDirectoryChange: (path: string) => void
  /** Notified once a checkout is prepared and the controls lock. */
  onCheckoutPrepared?: (result: CheckoutPrepareResult) => void
}

const MENU_CONTAINER_STYLE =
  'min-w-[220px] max-w-[380px] overflow-hidden rounded-[8px] bg-background text-foreground shadow-modal-small p-0'
const MENU_LIST_STYLE = 'max-h-[220px] overflow-y-auto p-1 [&_[cmdk-list-sizer]]:space-y-px'
const MENU_ITEM_STYLE =
  'flex cursor-pointer select-none items-center gap-2 rounded-[6px] px-3 py-1.5 text-[13px] outline-none data-[selected=true]:bg-foreground/5'

/** Deduplicate refs by display name, keeping the first (local-branch) entry. */
function dedupeRefs(refs: GitRef[]): GitRef[] {
  const seen = new Set<string>()
  const out: GitRef[] = []
  for (const ref of refs) {
    if (seen.has(ref.name)) continue
    seen.add(ref.name)
    out.push(ref)
  }
  return out
}

export function WorkspaceCheckoutBadge({
  sessionId,
  workingDirectory,
  isEmptySession = false,
  onWorkingDirectoryChange,
  onCheckoutPrepared,
}: WorkspaceCheckoutBadgeProps) {
  const { t } = useTranslation()
  const [context, setContext] = React.useState<RepositoryContext | null>(null)
  const [mode, setMode] = React.useState<CheckoutMode>('current')
  const [baseRef, setBaseRef] = React.useState<string | null>(null)
  const [refs, setRefs] = React.useState<GitRef[]>([])
  const [refsLoading, setRefsLoading] = React.useState(false)
  const [open, setOpen] = React.useState(false)
  const [preparing, setPreparing] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [prepared, setPrepared] = React.useState<CheckoutPrepareResult | null>(null)

  const flagEnabled = FEATURE_FLAGS.gitWorkspaceV1

  // Resolve repository identity for the active working directory. Reset any
  // pending New worktree intent whenever the directory changes (spec: switching
  // directories reruns discovery and clears an unprepared intent).
  React.useEffect(() => {
    if (!flagEnabled || !workingDirectory) {
      setContext(null)
      return
    }
    let cancelled = false
    setMode('current')
    setBaseRef(null)
    setRefs([])
    setError(null)
    window.electronAPI
      ?.getGitContext?.(workingDirectory)
      .then((ctx) => {
        if (cancelled) return
        setContext(ctx)
        setBaseRef(ctx.currentBranch ?? ctx.defaultRef ?? null)
      })
      .catch(() => {
        if (!cancelled) setContext(null)
      })
    return () => {
      cancelled = true
    }
  }, [flagEnabled, workingDirectory])

  const loadRefs = React.useCallback(() => {
    if (!workingDirectory) return
    setRefsLoading(true)
    window.electronAPI
      ?.listGitRefs?.(workingDirectory)
      .then((result) => {
        setRefs(dedupeRefs(result.refs))
        setBaseRef((prev) => prev ?? result.currentBranch ?? result.defaultRef ?? null)
      })
      .catch(() => setRefs([]))
      .finally(() => setRefsLoading(false))
  }, [workingDirectory])

  const handleSelectMode = React.useCallback(
    (next: CheckoutMode) => {
      setError(null)
      setMode(next)
      if (next === 'managed-worktree' && refs.length === 0) loadRefs()
    },
    [refs.length, loadRefs],
  )

  const handlePrepare = React.useCallback(async () => {
    if (!sessionId || !workingDirectory || !baseRef) return
    setPreparing(true)
    setError(null)
    try {
      const result = await window.electronAPI.prepareGitCheckout(sessionId, {
        mode: 'managed-worktree',
        workingDirectory,
        baseRef,
      })
      setPrepared(result)
      setOpen(false)
      onWorkingDirectoryChange(result.workingDirectory)
      onCheckoutPrepared?.(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPreparing(false)
    }
  }, [sessionId, workingDirectory, baseRef, onWorkingDirectoryChange, onCheckoutPrepared])

  if (!flagEnabled) return null

  // Locked identity after a managed worktree is prepared. Persists for the
  // lifetime of this composer mount even if the message send later fails.
  if (prepared) {
    const branch = prepared.checkout.expectedBranch ?? prepared.checkout.branchAtPreparation
    return (
      <FreeFormInputContextBadge
        icon={<GitFork className="h-4 w-4" />}
        label={branch ?? t('git.workspace.worktree')}
        isExpanded
        hasSelection
        showChevron={false}
        tooltip={
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">{t('git.workspace.worktreeReady')}</span>
            {branch && <span className="text-xs opacity-70">{t('chat.onBranch', { branch })}</span>}
          </span>
        }
        disabled
      />
    )
  }

  if (!context?.isGitRepository) return null

  const liveBranch = context.detached
    ? t('git.workspace.detached')
    : context.currentBranch ?? context.defaultRef ?? t('git.workspace.currentCheckout')

  // Once the session has messages the checkout is fixed; show live branch
  // identity passively rather than the interactive menu.
  if (!isEmptySession || !sessionId) {
    return (
      <FreeFormInputContextBadge
        icon={<GitBranch className="h-4 w-4" />}
        label={liveBranch}
        isExpanded={false}
        hasSelection
        showChevron={false}
        tooltip={
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">{t('git.workspace.currentCheckout')}</span>
            <span className="text-xs opacity-70">{t('chat.onBranch', { branch: liveBranch })}</span>
          </span>
        }
        disabled
      />
    )
  }

  const triggerLabel =
    mode === 'managed-worktree'
      ? t('git.workspace.fromRef', { ref: baseRef ?? liveBranch })
      : liveBranch

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <span className="shrink min-w-0 overflow-hidden">
          <FreeFormInputContextBadge
            icon={
              mode === 'managed-worktree' ? (
                <GitFork className="h-4 w-4" />
              ) : (
                <GitBranch className="h-4 w-4" />
              )
            }
            label={triggerLabel}
            isExpanded={isEmptySession}
            hasSelection
            showChevron
            isOpen={open}
            tooltip={t('git.workspace.menuTooltip')}
          />
        </span>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={8} className={MENU_CONTAINER_STYLE}>
        <div className="p-1">
          <button
            type="button"
            onClick={() => {
              handleSelectMode('current')
              setOpen(false)
            }}
            className={cn(MENU_ITEM_STYLE, 'w-full hover:bg-foreground/5')}
          >
            <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="flex-1 min-w-0 truncate text-left">{t('git.workspace.currentCheckout')}</span>
            {mode === 'current' && <Check className="h-4 w-4 shrink-0" />}
          </button>
          <button
            type="button"
            onClick={() => handleSelectMode('managed-worktree')}
            className={cn(MENU_ITEM_STYLE, 'w-full hover:bg-foreground/5')}
          >
            <GitFork className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="flex-1 min-w-0 truncate text-left">{t('git.workspace.newWorktree')}</span>
            {mode === 'managed-worktree' && <Check className="h-4 w-4 shrink-0" />}
          </button>
        </div>

        {mode === 'managed-worktree' && (
          <div className="border-t border-border/50">
            <div className="px-3 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t('git.workspace.fromRefLabel')}
            </div>
            <CommandPrimitive>
              <div className="border-b border-border/50 px-3 py-2">
                <CommandPrimitive.Input
                  placeholder={t('git.workspace.searchRefs')}
                  className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/50"
                />
              </div>
              <CommandPrimitive.List className={MENU_LIST_STYLE}>
                {refsLoading && (
                  <div className="flex items-center gap-2 px-3 py-2 text-[13px] text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t('common.loading')}
                  </div>
                )}
                {refs.map((ref) => (
                  <CommandPrimitive.Item
                    key={ref.fullName}
                    value={ref.name}
                    onSelect={() => setBaseRef(ref.name)}
                    className={MENU_ITEM_STYLE}
                  >
                    <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="flex-1 min-w-0 truncate">{ref.name}</span>
                    {baseRef === ref.name && <Check className="h-4 w-4 shrink-0" />}
                  </CommandPrimitive.Item>
                ))}
                {!refsLoading && (
                  <CommandPrimitive.Empty className="py-3 text-center text-sm text-muted-foreground">
                    {t('git.workspace.noRefsFound')}
                  </CommandPrimitive.Empty>
                )}
              </CommandPrimitive.List>
            </CommandPrimitive>

            <div className="border-t border-border/50 p-2">
              <p className="px-1 pb-2 text-[11px] text-muted-foreground">
                {t('git.workspace.worktreeCommittedNote')}
              </p>
              {error && <p className="px-1 pb-2 text-[11px] text-destructive">{error}</p>}
              <button
                type="button"
                onClick={handlePrepare}
                disabled={!baseRef || preparing}
                className={cn(
                  'flex w-full items-center justify-center gap-2 rounded-[6px] bg-foreground px-3 py-1.5 text-[13px] font-medium text-background transition-opacity',
                  (!baseRef || preparing) && 'opacity-50',
                )}
              >
                {preparing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {preparing ? t('git.workspace.preparing') : t('git.workspace.createWorktree')}
              </button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
