/**
 * ForkDialog — preview / confirm / recovery for conversation forks.
 *
 * The Branch action opens this dialog when Worktree V2 is effective. It offers
 * the two strategies — Shared worktree (default, pre-existing branch behavior)
 * and New isolated worktree (only when eligible) — and drives the
 * FORK_PREVIEW / FORK_CONFIRM / FORK_STATUS / FORK_RECOVER / FORK_CANCEL RPCs
 * through the workspace-owning server.
 *
 * The client submits only a session ID, a strategy, and (for isolated) an
 * editable worktree name suffix; the server binds every decision-relevant fact
 * into the preview fingerprint and revalidates it under lock on confirm. The
 * shared strategy confirms through the EXISTING branch flow (the server throws
 * FORK_NOT_IMPLEMENTED for shared confirmation), so shared behavior stays
 * byte-identical to today.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Check, CheckCircle2, ExternalLink, GitBranch, GitFork, Loader2, RotateCcw } from 'lucide-react'

import type {
  ConversationForkPreview,
  ConversationForkResult,
  ConversationForkStrategy,
} from '@kata-sh/shared/protocol'

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useRegisterModal } from '@/context/ModalContext'
import { cn } from '@/lib/utils'

import {
  canConfirmForkForName,
  canRecoverFork,
  finalizeForkName,
  forkCommittedChildSessionId,
  forkIsolatedDisabledReason,
  forkIsolatedEligible,
  forkSourceStateKey,
  forkStrategyDefault,
  initialForkDialogState,
  reduceForkDialog,
  type ForkDialogState,
} from '../input/fork-controls'
import { generateDefaultWorktreeName } from '../input/checkout-controls'

export interface ForkDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessionId: string
  /** Source message the branch action was invoked on. */
  branchPointMessageId?: string
  /** Current conversation head message id (client-side head gate for isolated). */
  conversationHeadMessageId?: string
  /** Server-derived: provider advertises a strict cross-CWD native fork. */
  isolatedForkCapable?: boolean
  /** True when the session's workspace is owned by a remote server. */
  isRemoteWorkspace?: boolean
  /**
   * Commit the shared-worktree strategy through the existing branch flow
   * (server-side shared confirmation is FORK_NOT_IMPLEMENTED). Resolves once
   * the child session exists; the caller navigates to it. Required for the
   * creation flow; recovery mode skips confirm entirely.
   */
  onCreateSharedBranch?: (messageId: string) => Promise<void>
  /** Navigate to the committed child session (isolated confirm). */
  onCommitted: (childSessionId: string) => void
  /**
   * Open directly into recovery for an already-known interrupted transaction
   * (from FORK_STATUS), skipping preview.
   */
  initialRecovery?: Extract<ConversationForkResult, { outcome: 'recovery-required' }>
}

function SummaryRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 text-[12px]">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right font-medium text-foreground">{children}</span>
    </div>
  )
}

function RemoteLabel({ serverId }: { serverId: string }) {
  const { t } = useTranslation()
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
      <ExternalLink className="h-3 w-3" />
      {t('git.fork.remoteOwned', { serverId })}
    </span>
  )
}

function BlockedNote({ message }: { message: string }) {
  const { t } = useTranslation()
  return (
    <div
      data-testid="fork-blocked"
      className="flex items-start gap-2 rounded-[6px] border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-300"
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>
        <span className="font-medium">{t('git.fork.blockedTitle')} · </span>
        {message}
      </span>
    </div>
  )
}

function GitStateSummary({ preview }: { preview: ConversationForkPreview }) {
  const { t } = useTranslation()
  const git = preview.source.gitState
  const items: Array<{ key: string; count: number }> = []
  if (git.stagedFileCount > 0) items.push({ key: 'git.fork.gitState.staged', count: git.stagedFileCount })
  if (git.unstagedFileCount > 0) items.push({ key: 'git.fork.gitState.unstaged', count: git.unstagedFileCount })
  if (git.untrackedFileCount > 0) items.push({ key: 'git.fork.gitState.untracked', count: git.untrackedFileCount })
  if (git.includedIgnoredFileCount > 0) {
    items.push({ key: 'git.fork.gitState.includedIgnored', count: git.includedIgnoredFileCount })
  }
  return (
    <span className="flex flex-col items-end gap-0.5">
      <span>{t(forkSourceStateKey(git.state))}</span>
      {items.length > 0 && (
        <span className="flex flex-col items-end gap-0.5 text-[11px] text-muted-foreground">
          {items.map(({ key, count }) => (
            <span key={key}>{t(key, { count })}</span>
          ))}
        </span>
      )}
    </span>
  )
}

/** Render the sanitized preview body (blocked or ready). */
function PreviewBody({
  state,
  isRemoteWorkspace,
  onNameChange,
}: {
  state: ForkDialogState
  isRemoteWorkspace: boolean
  onNameChange: (value: string) => void
}) {
  const { t } = useTranslation()
  const preview = state.preview
  if (!preview) return null
  const remote = isRemoteWorkspace

  return (
    <div className="flex flex-col gap-3">
      {state.phase === 'preview-blocked' && <BlockedNote message={state.message} />}

      {(state.phase === 'preview' || state.phase === 'preview-blocked') && (
        <div className="flex flex-col gap-2">
          {/* Source block: conversation head, branch, HEAD, Git-state summary, owners/leases */}
          <div className="flex flex-col gap-1.5 rounded-[6px] border border-border/50 px-3 py-2">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t('git.fork.sourceLabel')}
            </span>
            <SummaryRow label={t('git.fork.conversationHead')}>
              <span className="font-mono text-[11px]">
                {preview.source.conversationHeadMessageId.slice(0, 12)}
              </span>
            </SummaryRow>
            <SummaryRow label={t('git.fork.sourceCheckout')}>
              <span className="inline-flex items-center gap-1.5">
                {remote && <RemoteLabel serverId={preview.source.serverId} />}
                {preview.source.branch ?? '—'}
                <span className="text-muted-foreground">·</span>
                <span className="font-mono text-[11px]">{preview.source.headSha?.slice(0, 8) ?? '—'}</span>
              </span>
            </SummaryRow>
            <SummaryRow label={t('git.fork.gitStateLabel')}>
              <GitStateSummary preview={preview} />
            </SummaryRow>
            {preview.source.leases.length > 0 && (
              <SummaryRow label={t('git.fork.ownersLabel')}>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {preview.source.leases.map((id) => id.slice(0, 8)).join(', ')}
                </span>
              </SummaryRow>
            )}
          </div>

          {/* Destination block: server, branch, checkout path */}
          <div className="flex flex-col gap-1.5 rounded-[6px] border border-border/50 px-3 py-2">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t('git.fork.destinationLabel')}
            </span>
            <SummaryRow label={t('git.fork.server')}>
              <span className="inline-flex items-center gap-1.5">
                {remote && <RemoteLabel serverId={preview.destination.serverId} />}
                {preview.destination.serverId}
              </span>
            </SummaryRow>
            <SummaryRow label={t('git.fork.destinationBranch')}>
              <span className="inline-flex items-center gap-1.5">
                <GitBranch className="h-3 w-3 text-muted-foreground" />
                {preview.destination.branch}
                {preview.destination.exists ? (
                  <span className="text-amber-600 dark:text-amber-400">({t('git.fork.occupied')})</span>
                ) : null}
              </span>
            </SummaryRow>
            <SummaryRow label={t('git.fork.checkoutPath')}>
              <span className="font-mono text-[11px] text-muted-foreground">{preview.destination.checkoutPath}</span>
            </SummaryRow>
            {preview.destination.leases.length > 0 && (
              <SummaryRow label={t('git.fork.destinationLeases')}>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {preview.destination.leases.map((id) => id.slice(0, 8)).join(', ')}
                </span>
              </SummaryRow>
            )}
          </div>

          {/* Provider capability + ignored-file policy */}
          <div className="flex flex-col gap-1.5 rounded-[6px] border border-border/50 px-3 py-2">
            <SummaryRow label={t('git.fork.provider')}>
              <span className="font-mono text-[11px]">{preview.providerCapability.adapterId}</span>
            </SummaryRow>
            <SummaryRow label={t('git.fork.strictFork')}>
              <span
                className={cn(
                  'inline-flex items-center gap-1',
                  preview.providerCapability.strictCrossCwdNativeFork
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-amber-600 dark:text-amber-400',
                )}
              >
                {preview.providerCapability.strictCrossCwdNativeFork ? (
                  <Check className="h-3 w-3" />
                ) : (
                  <AlertTriangle className="h-3 w-3" />
                )}
                {preview.providerCapability.strictCrossCwdNativeFork
                  ? t('git.fork.strictForkSupported')
                  : t('git.fork.strictForkUnsupported')}
              </span>
            </SummaryRow>
            <SummaryRow label={t('git.fork.ignoredPolicy')}>
              {t('git.fork.ignoredPolicyDetail', { count: preview.excludedIgnoredPolicy.includeFileCount })}
            </SummaryRow>
          </div>
        </div>
      )}

      {state.strategy === 'isolated-worktree' &&
        (state.phase === 'preview' || state.phase === 'preview-blocked') && (
          <div className="flex flex-col gap-1.5">
            <label className="text-[12px] font-medium text-muted-foreground">{t('git.fork.nameLabel')}</label>
            <Input
              data-testid="fork-name-input"
              value={state.nameInput}
              onChange={(event) => onNameChange(event.target.value)}
              placeholder={t('git.fork.namePlaceholder')}
            />
          </div>
        )}
    </div>
  )
}

function CommittedBody({ result }: { result: Extract<ConversationForkResult, { outcome: 'committed' }> }) {
  const { t } = useTranslation()
  const branch = result.summary.checkout.expectedBranch
  return (
    <div
      data-testid="fork-committed"
      className="flex flex-col gap-2 rounded-[6px] border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[12px]"
    >
      <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-300">
        <CheckCircle2 className="h-3.5 w-3.5" />
        {t('git.fork.committedTitle')}
      </span>
      <span className="text-foreground/80">{t('git.fork.committedDetail')}</span>
      {branch && (
        <span className="font-mono text-[11px] text-muted-foreground">
          {t('git.fork.committedBranch', { branch })}
        </span>
      )}
      <span className="text-muted-foreground">{t('git.fork.providerPendingNote')}</span>
    </div>
  )
}

function RecoveryBody({
  state,
  onRecover,
}: {
  state: ForkDialogState
  onRecover: () => void
}) {
  const { t } = useTranslation()
  const result = state.result
  // Keep the button mounted while recovery is in flight so the spinner shows.
  const canRecover = state.phase === 'recovering' || canRecoverFork(state.phase, result)
  return (
    <div className="flex flex-col gap-3">
      <div
        data-testid="fork-recovery-required"
        className="flex flex-col gap-1 rounded-[6px] border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[12px]"
      >
        <span className="inline-flex items-center gap-1.5 font-medium text-rose-700 dark:text-rose-300">
          <AlertTriangle className="h-3.5 w-3.5" />
          {t('git.fork.recoveryTitle')}
        </span>
        <span className="text-foreground/80">{t('git.fork.recoveryNote')}</span>
        {result?.outcome === 'recovery-required' && result.retainedSnapshotId && (
          <span className="font-mono text-[11px] text-muted-foreground">
            {t('git.fork.retainedSnapshot', { snapshotId: result.retainedSnapshotId.slice(0, 8) })}
          </span>
        )}
        {state.phase !== 'recovering' && state.message && (
          <span className="text-muted-foreground">{state.message}</span>
        )}
      </div>
      {canRecover && (
        <Button
          data-testid="fork-recover-button"
          variant="secondary"
          onClick={onRecover}
          disabled={state.phase === 'recovering'}
        >
          {state.phase === 'recovering' ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('git.fork.recovering')}
            </>
          ) : (
            <>
              <RotateCcw className="h-3.5 w-3.5" />
              {t('git.fork.recover')}
            </>
          )}
        </Button>
      )}
    </div>
  )
}

export function ForkDialog({
  open,
  onOpenChange,
  sessionId,
  branchPointMessageId = '',
  conversationHeadMessageId,
  isolatedForkCapable = false,
  isRemoteWorkspace = false,
  onCreateSharedBranch,
  onCommitted,
  initialRecovery,
}: ForkDialogProps) {
  const { t } = useTranslation()
  const [state, dispatch] = React.useReducer(reduceForkDialog, undefined, initialForkDialogState)
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const previewSeqRef = React.useRef(0)
  const strategyRef = React.useRef<ConversationForkStrategy>(state.strategy)

  // Client-side head gate: isolated requires the branch point to be the
  // current conversation head (older points are shared-only).
  const atConversationHead =
    !conversationHeadMessageId || branchPointMessageId === conversationHeadMessageId
  const isolatedEligible = forkIsolatedEligible({
    isolatedCapable: isolatedForkCapable,
    atConversationHead,
  })
  // When the current isolated preview is blocked, its blocker reason is the
  // authoritative disable reason (e.g. the server rejected the name).
  const isolatedDisabledReason = forkIsolatedDisabledReason({
    phase: state.phase,
    strategy: state.strategy,
    atConversationHead,
    isolatedCapable: isolatedForkCapable,
    blockedMessage: state.message,
  })
  const isolatedDisabledReasonLabel =
    isolatedDisabledReason && isolatedDisabledReason.startsWith('git.')
      ? t(isolatedDisabledReason)
      : isolatedDisabledReason

  // Dismissing the dialog without confirming must release the pending preview
  // transaction, or the session stays fenced until recovery.
  const releasePendingPreview = React.useCallback(() => {
    const preview = state.preview
    if (!preview || state.phase === 'recovery-required' || state.phase === 'recovering') return
    void window.electronAPI.forkCancel({ sessionId, transactionId: preview.transactionId }).catch(() => {
      /* best-effort; a confirm may have started, in which case cancel no-ops */
    })
  }, [state.preview, state.phase, sessionId])

  const close = React.useCallback(() => {
    releasePendingPreview()
    onOpenChange(false)
  }, [releasePendingPreview, onOpenChange])

  useRegisterModal(open, close)

  const runPreview = React.useCallback(
    async (strategy: ConversationForkStrategy, nameSuffix: string) => {
      const seq = ++previewSeqRef.current
      try {
        const preview = await window.electronAPI.forkPreview({
          sessionId,
          strategy,
          ...(strategy === 'isolated-worktree' && nameSuffix
            ? { worktreeNameSuffix: finalizeForkName(nameSuffix) }
            : {}),
        })
        if (seq !== previewSeqRef.current) return
        dispatch({ type: 'preview-ready', preview })
      } catch (error) {
        if (seq !== previewSeqRef.current) return
        dispatch({ type: 'preview-error', message: error instanceof Error ? error.message : String(error) })
      }
    },
    [sessionId],
  )

  // Open → reset the dialog and request the first preview for the default
  // (shared) strategy — or enter recovery directly when the interrupted
  // transaction is already known.
  React.useEffect(() => {
    if (!open || !sessionId) return
    strategyRef.current = forkStrategyDefault()
    dispatch({ type: 'open' })
    previewSeqRef.current += 1 // invalidate any in-flight preview from a previous open
    if (initialRecovery) {
      dispatch({ type: 'recovery-from-status', result: initialRecovery })
      return () => {
        if (debounceRef.current) clearTimeout(debounceRef.current)
        previewSeqRef.current += 1
      }
    }
    void runPreview(forkStrategyDefault(), '')
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      previewSeqRef.current += 1 // invalidate any in-flight preview on close
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sessionId, initialRecovery?.transactionId])

  const handleStrategyChange = React.useCallback(
    (strategy: ConversationForkStrategy) => {
      if (strategy === strategyRef.current) return
      strategyRef.current = strategy
      // Compute the name ONCE so the input and the previewed branch suffix
      // always agree (a fresh random default in the reducer would diverge
      // from the name the preview was issued for).
      const nameForIsolated =
        strategy === 'isolated-worktree' ? state.nameInput || generateDefaultWorktreeName() : ''
      dispatch({ type: 'strategy-changed', strategy, nameInput: nameForIsolated })
      void runPreview(strategy, nameForIsolated)
    },
    [runPreview, state.nameInput],
  )

  const handleNameChange = React.useCallback(
    (value: string) => {
      dispatch({ type: 'name-changed', value })
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        void runPreview(strategyRef.current, value)
      }, 350)
    },
    [runPreview],
  )

  // Navigate to the committed child session once the isolated confirm lands.
  React.useEffect(() => {
    const childSessionId = forkCommittedChildSessionId(state.result)
    if (state.phase === 'committed' && childSessionId) {
      onCommitted(childSessionId)
    }
  }, [state.phase, state.result, onCommitted])

  const handleConfirm = React.useCallback(async () => {
    const preview = state.preview
    if (!canConfirmForkForName(state) || preview === null) return
    dispatch({ type: 'confirm' })
    if (strategyRef.current === 'shared-worktree') {
      // Shared confirmation is FORK_NOT_IMPLEMENTED server-side; reuse the
      // existing branch flow so shared behavior stays byte-identical.
      if (!onCreateSharedBranch) return
      try {
        await onCreateSharedBranch(branchPointMessageId)
        dispatch({ type: 'reset' })
        onOpenChange(false)
      } catch (error) {
        dispatch({ type: 'preview-error', message: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    try {
      const result = await window.electronAPI.forkConfirm({
        sessionId,
        strategy: 'isolated-worktree',
        transactionId: preview.transactionId,
        previewFingerprint: preview.previewFingerprint,
        worktreeNameSuffix: finalizeForkName(state.nameInput),
      })
      dispatch({ type: 'confirm-ready', result })
    } catch (error) {
      dispatch({ type: 'preview-error', message: error instanceof Error ? error.message : String(error) })
    }
  }, [state, sessionId, branchPointMessageId, onCreateSharedBranch, onOpenChange])

  const handleRecover = React.useCallback(async () => {
    const result = state.result
    if (!canRecoverFork(state.phase, result) || result === null || result.outcome !== 'recovery-required') return
    dispatch({ type: 'recover' })
    try {
      const recovered = await window.electronAPI.forkRecover({
        sessionId,
        transactionId: result.transactionId,
      })
      dispatch({ type: 'recover-ready', result: recovered })
    } catch (error) {
      dispatch({ type: 'recover-error', message: error instanceof Error ? error.message : String(error) })
    }
  }, [state.phase, state.result, sessionId])

  const busy = state.phase === 'loading' || state.phase === 'confirming' || state.phase === 'recovering'
  // Keep the confirm button mounted while the request is in flight so the
  // spinner state is visible; the click handler guards on the phase itself.
  const confirmable =
    state.phase === 'confirming' || (canConfirmForkForName(state) && !busy)

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent
        data-testid="fork-dialog"
        className="sm:max-w-[480px]"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t('git.fork.title')}</DialogTitle>
          <DialogDescription>{t('git.fork.description')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {/* Strategy selection */}
          {state.phase !== 'recovery-required' && state.phase !== 'recovering' && (
            <div className="flex flex-col gap-1.5" data-testid="fork-strategy-selector">
              <button
                type="button"
                data-testid="fork-strategy-shared"
                onClick={() => handleStrategyChange('shared-worktree')}
                disabled={busy && state.strategy !== 'shared-worktree'}
                className={cn(
                  'flex w-full items-center gap-2 rounded-[6px] border px-3 py-2 text-left text-[13px]',
                  state.strategy === 'shared-worktree'
                    ? 'border-primary/40 bg-primary/5'
                    : 'border-border/60 hover:bg-foreground/5',
                )}
              >
                <GitFork className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="flex-1">
                  <span className="block font-medium">{t('git.fork.strategy.shared')}</span>
                  <span className="block text-[11px] text-muted-foreground">{t('git.fork.strategy.sharedNote')}</span>
                </span>
                {state.strategy === 'shared-worktree' && <Check className="h-3.5 w-3.5 shrink-0" />}
              </button>

              <button
                type="button"
                data-testid="fork-strategy-isolated"
                onClick={() => handleStrategyChange('isolated-worktree')}
                disabled={!isolatedEligible || (busy && state.strategy !== 'isolated-worktree')}
                className={cn(
                  'flex w-full items-center gap-2 rounded-[6px] border px-3 py-2 text-left text-[13px]',
                  !isolatedEligible && 'cursor-not-allowed opacity-60',
                  state.strategy === 'isolated-worktree'
                    ? 'border-primary/40 bg-primary/5'
                    : 'border-border/60 hover:bg-foreground/5',
                )}
              >
                <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="flex-1">
                  <span className="block font-medium">{t('git.fork.strategy.isolated')}</span>
                  <span className="block text-[11px] text-muted-foreground">{t('git.fork.strategy.isolatedNote')}</span>
                </span>
                {state.strategy === 'isolated-worktree' && <Check className="h-3.5 w-3.5 shrink-0" />}
              </button>
              {isolatedDisabledReasonLabel && (
                <span
                  data-testid="fork-isolated-reason"
                  className="px-1 text-[11px] text-amber-600 dark:text-amber-400"
                >
                  {isolatedDisabledReasonLabel}
                </span>
              )}
            </div>
          )}

          {state.phase === 'loading' && (
            <div className="flex items-center gap-2 py-4 text-[12px] text-muted-foreground">
              <Loader2 data-testid="fork-loading" className="h-3.5 w-3.5 animate-spin" />
              {t('git.fork.previewing')}
            </div>
          )}

          {(state.phase === 'preview' || state.phase === 'preview-blocked') && (
            <PreviewBody state={state} isRemoteWorkspace={isRemoteWorkspace} onNameChange={handleNameChange} />
          )}

          {state.phase === 'committed' && state.result?.outcome === 'committed' && (
            <CommittedBody result={state.result} />
          )}

          {(state.phase === 'recovery-required' || state.phase === 'recovering') && (
            <RecoveryBody state={state} onRecover={handleRecover} />
          )}

          {(state.phase === 'blocked' || state.phase === 'error') && (
            <div className="flex flex-col gap-3">
              <BlockedNote message={state.message} />
              {state.phase === 'blocked' && state.result?.outcome === 'blocked' && (
                <span className="text-[12px] text-muted-foreground">{t('git.fork.rolledBackDetail')}</span>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="mt-2 gap-2">
          <Button variant="ghost" data-testid="fork-cancel-button" onClick={close} disabled={busy}>
            {t('git.fork.cancel')}
          </Button>
          {confirmable && (
            <Button
              data-testid="fork-confirm-button"
              onClick={() => void handleConfirm()}
              disabled={state.phase !== 'preview' && state.phase !== 'confirming'}
            >
              {state.phase === 'confirming' ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t('git.fork.confirming')}
                </>
              ) : (
                t('git.fork.confirm')
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
