/**
 * HandoffDialog — preview / confirm / recovery for worktree checkout handoff.
 *
 * The client submits only a session ID, a direction, and (for current-to-
 * managed) a worktree name; the workspace-owning server binds every decision-
 * relevant fact into the preview fingerprint and revalidates it under lock on
 * confirm. This dialog renders the sanitized preview (source/destination
 * summaries, cleanup counts, include conflicts, return ref, recovery behavior),
 * surfaces typed blockers, and drives the recover flow for interrupted
 * handoffs (spec AC-2/5/7/11).
 *
 * A remote owning server labels the destination with its serverId; there is no
 * local reveal action — paths shown come only from the server-returned preview.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, RotateCcw } from 'lucide-react'

import type {
  WorktreeHandoffDirection,
  WorktreeHandoffResult,
} from '@kata-sh/shared/protocol'

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useRegisterModal } from '@/context/ModalContext'
import { cn } from '@/lib/utils'

import {
  canConfirmHandoff,
  canConfirmHandoffForName,
  canRecoverHandoff,
  finalizeHandoffName,
  initialHandoffDialogState,
  isRemoteOwnedPreview,
  reduceHandoffDialog,
  sourceStateKey,
  type HandoffDialogState,
} from '../input/handoff-controls'
import { generateDefaultWorktreeName } from '../input/checkout-controls'

export interface HandoffDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessionId: string
  direction: WorktreeHandoffDirection
  /** True when the session's workspace is owned by a remote server. */
  isRemoteWorkspace?: boolean
  /**
   * Open directly into recovery for an already-known interrupted transaction
   * (from HANDOFF_STATUS), skipping preview.
   */
  initialRecovery?: Extract<WorktreeHandoffResult, { outcome: 'recovery-required' }>
}

function SummaryRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-3 text-[12px]">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right font-medium text-foreground">{children}</span>
    </div>
  )
}

function BlockedNote({ message }: { message: string }) {
  const { t } = useTranslation()
  return (
    <div
      data-testid="handoff-blocked"
      className="flex items-start gap-2 rounded-[6px] border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-300"
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>
        <span className="font-medium">{t('git.handoff.blockedTitle')} · </span>
        {message}
      </span>
    </div>
  )
}

function RemoteLabel({ serverId }: { serverId: string }) {
  const { t } = useTranslation()
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
      <ExternalLink className="h-3 w-3" />
      {t('git.handoff.remoteOwned', { serverId })}
    </span>
  )
}

/** Render the sanitized preview body (blocked or ready). */
function PreviewBody({
  state,
  isRemoteWorkspace,
  onNameChange,
}: {
  state: HandoffDialogState
  isRemoteWorkspace: boolean
  onNameChange: (value: string) => void
}) {
  const { t } = useTranslation()
  const preview = state.preview
  if (!preview) return null
  const remote = isRemoteOwnedPreview(preview, isRemoteWorkspace)
  const sourceState = sourceStateKey(preview.source.state)

  return (
    <div className="flex flex-col gap-3">
      {state.phase === 'preview-blocked' && <BlockedNote message={state.message} />}
      {state.phase === 'preview' && (
        <div className="flex flex-col gap-2">
          <SummaryRow label={t('git.handoff.source')}>
            <span className="inline-flex items-center gap-1.5">
              {remote && <RemoteLabel serverId={preview.source.serverId} />}
              {preview.source.branch ?? '—'}
              <span className="text-muted-foreground">·</span>
              {t(sourceState)}
              <span className="text-muted-foreground">·</span>
              <span className="font-mono text-[11px]">{preview.source.headSha?.slice(0, 8) ?? '—'}</span>
            </span>
          </SummaryRow>
          <SummaryRow label={t('git.handoff.destination')}>
            <span className="inline-flex items-center gap-1.5">
              {remote && <RemoteLabel serverId={preview.destination.serverId} />}
              {preview.destination.branch}
              {preview.destination.exists ? (
                <span className="text-amber-600 dark:text-amber-400">({t('git.handoff.occupied')})</span>
              ) : null}
            </span>
          </SummaryRow>
          {preview.returnRef && (
            <SummaryRow label={t('git.handoff.returnRef')}>{preview.returnRef.branch}</SummaryRow>
          )}
          <SummaryRow label={t('git.handoff.recoveryBehaviorLabel')}>
            {t(`git.handoff.recovery.${preview.recoveryBehavior}`)}
          </SummaryRow>

          <div className="mt-1 border-t border-border/50 pt-2">
            <CleanupSummary preview={preview} />
          </div>
        </div>
      )}
      {(state.phase === 'preview' || state.phase === 'preview-blocked') && preview.direction === 'current-to-managed' && (
        <div className="flex flex-col gap-1.5">
          <label className="text-[12px] font-medium text-muted-foreground">{t('git.handoff.nameLabel')}</label>
          <Input
            data-testid="handoff-name-input"
            value={state.nameInput}
            onChange={(event) => onNameChange(event.target.value)}
            placeholder={t('git.handoff.namePlaceholder')}
          />
        </div>
      )}
    </div>
  )
}

function CleanupSummary({ preview }: { preview: NonNullable<HandoffDialogState['preview']> }) {
  const { t } = useTranslation()
  const { cleanup, includeCopyConflicts } = preview
  const items: Array<{ key: string; count: number }> = []
  if (cleanup.trackedFileCount > 0) items.push({ key: 'git.handoff.cleanup.tracked', count: cleanup.trackedFileCount })
  if (cleanup.stagedFileCount > 0) items.push({ key: 'git.handoff.cleanup.staged', count: cleanup.stagedFileCount })
  if (cleanup.eligibleUntrackedFileCount > 0) {
    items.push({ key: 'git.handoff.cleanup.untracked', count: cleanup.eligibleUntrackedFileCount })
  }
  if (cleanup.includedIgnoredFileCount > 0) {
    items.push({ key: 'git.handoff.cleanup.includedIgnored', count: cleanup.includedIgnoredFileCount })
  }

  return (
    <div className="flex flex-col gap-1 text-[12px] text-muted-foreground">
      {items.length === 0 ? (
        <span>{t('git.handoff.cleanup.none')}</span>
      ) : (
        items.map(({ key, count }) => <span key={key}>{t(key, { count })}</span>)
      )}
      {includeCopyConflicts.length > 0 && (
        <span className="text-amber-600 dark:text-amber-400">
          {t('git.handoff.includeConflicts', { count: includeCopyConflicts.length })}
        </span>
      )}
      {preview.source.leases.length > 0 && (
        <span className="text-amber-600 dark:text-amber-400">{t('git.handoff.leased')}</span>
      )}
    </div>
  )
}

function CommittedBody({ result }: { result: Extract<WorktreeHandoffResult, { outcome: 'committed' }> }) {
  const { t } = useTranslation()
  return (
    <div
      data-testid="handoff-committed"
      className="flex flex-col gap-2 rounded-[6px] border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[12px]"
    >
      <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-300">
        <CheckCircle2 className="h-3.5 w-3.5" />
        {t('git.handoff.committedTitle')}
      </span>
      <span className="text-foreground/80">{t('git.handoff.committedDetail')}</span>
      <span className="text-muted-foreground">{t('git.handoff.transcriptPreserved')}</span>
    </div>
  )
}

function RecoveryBody({
  state,
  onRecover,
}: {
  state: HandoffDialogState
  onRecover: () => void
}) {
  const { t } = useTranslation()
  const result = state.result
  // Keep the button mounted while recovery is in flight so the spinner shows.
  const canRecover = state.phase === 'recovering' || canRecoverHandoff(state.phase, result)
  return (
    <div className="flex flex-col gap-3">
      <div
        data-testid="handoff-recovery-required"
        className="flex flex-col gap-1 rounded-[6px] border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[12px]"
      >
        <span className="inline-flex items-center gap-1.5 font-medium text-rose-700 dark:text-rose-300">
          <AlertTriangle className="h-3.5 w-3.5" />
          {t('git.handoff.recoveryTitle')}
        </span>
        <span className="text-foreground/80">{t('git.handoff.recoveryNote')}</span>
        {result?.outcome === 'recovery-required' && result.retainedSnapshotId && (
          <span className="font-mono text-[11px] text-muted-foreground">
            {t('git.handoff.retainedSnapshot', { snapshotId: result.retainedSnapshotId.slice(0, 8) })}
          </span>
        )}
        {state.phase !== 'recovering' && state.message && (
          <span className="text-muted-foreground">{state.message}</span>
        )}
      </div>
      {canRecover && (
        <Button
          data-testid="handoff-recover-button"
          variant="secondary"
          onClick={onRecover}
          disabled={state.phase === 'recovering'}
        >
          {state.phase === 'recovering' ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('git.handoff.recovering')}
            </>
          ) : (
            <>
              <RotateCcw className="h-3.5 w-3.5" />
              {t('git.handoff.recover')}
            </>
          )}
        </Button>
      )}
    </div>
  )
}

export function HandoffDialog({
  open,
  onOpenChange,
  sessionId,
  direction,
  isRemoteWorkspace = false,
  initialRecovery,
}: HandoffDialogProps) {
  const { t } = useTranslation()
  const [state, dispatch] = React.useReducer(reduceHandoffDialog, undefined, initialHandoffDialogState)
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const previewSeqRef = React.useRef(0)

  useRegisterModal(open, () => onOpenChange(false))

  const runPreview = React.useCallback(
    async (nameSuffix: string) => {
      const seq = ++previewSeqRef.current
      try {
        const preview = await window.electronAPI.handoffPreview({
          sessionId,
          direction,
          ...(direction === 'current-to-managed' && nameSuffix
            ? { worktreeNameSuffix: finalizeHandoffName(nameSuffix) }
            : {}),
        })
        if (seq !== previewSeqRef.current) return
        dispatch({ type: 'preview-ready', preview })
      } catch (error) {
        if (seq !== previewSeqRef.current) return
        dispatch({ type: 'preview-error', message: error instanceof Error ? error.message : String(error) })
      }
    },
    [sessionId, direction],
  )

  // Open → reset the dialog and request the first preview (or enter recovery
  // directly when the interrupted transaction is already known).
  React.useEffect(() => {
    if (!open || !sessionId) return
    const initialName = direction === 'current-to-managed' ? generateDefaultWorktreeName() : ''
    dispatch({ type: 'open', direction, initialName })
    previewSeqRef.current = 0
    if (initialRecovery) {
      dispatch({ type: 'recovery-from-status', result: initialRecovery })
      return () => {
        if (debounceRef.current) clearTimeout(debounceRef.current)
        previewSeqRef.current += 1
      }
    }
    void runPreview(initialName)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      previewSeqRef.current += 1 // invalidate any in-flight preview on close
    }
  }, [open, sessionId, direction, runPreview, initialRecovery])

  const handleNameChange = React.useCallback(
    (value: string) => {
      dispatch({ type: 'name-changed', value })
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        void runPreview(value)
      }, 350)
    },
    [runPreview],
  )

  const handleConfirm = React.useCallback(async () => {
    const preview = state.preview
    if (!canConfirmHandoffForName(state) || preview === null) return
    dispatch({ type: 'confirm' })
    try {
      const result = await window.electronAPI.handoffConfirm({
        sessionId,
        direction,
        transactionId: preview.transactionId,
        previewFingerprint: preview.previewFingerprint,
      })
      dispatch({ type: 'confirm-ready', result })
    } catch (error) {
      dispatch({ type: 'preview-error', message: error instanceof Error ? error.message : String(error) })
    }
  }, [state.phase, state.preview, sessionId, direction])

  const handleRecover = React.useCallback(async () => {
    const result = state.result
    if (!canRecoverHandoff(state.phase, result) || result === null || result.outcome !== 'recovery-required') return
    dispatch({ type: 'recover' })
    try {
      const recovered = await window.electronAPI.handoffRecover({
        sessionId,
        transactionId: result.transactionId,
      })
      dispatch({ type: 'recover-ready', result: recovered })
    } catch (error) {
      dispatch({ type: 'preview-error', message: error instanceof Error ? error.message : String(error) })
    }
  }, [state.phase, state.result, sessionId])

  const close = React.useCallback(() => onOpenChange(false), [onOpenChange])

  const busy = state.phase === 'loading' || state.phase === 'confirming' || state.phase === 'recovering'
  // Keep the confirm button mounted while the request is in flight so the
  // spinner state is visible; the click handler guards on the phase itself.
  const confirmable =
    state.phase === 'confirming' || (canConfirmHandoffForName(state) && !busy)

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent
        data-testid="handoff-dialog"
        className="sm:max-w-[480px]"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t('git.handoff.title')}</DialogTitle>
          <DialogDescription>{t(`git.handoff.direction.${direction}`)}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {state.phase === 'loading' && (
            <div className="flex items-center gap-2 py-6 text-[12px] text-muted-foreground">
              <Loader2 data-testid="handoff-loading" className="h-3.5 w-3.5 animate-spin" />
              {t('git.handoff.previewing')}
            </div>
          )}

          {state.phase === 'unsupported' && (
            <div
              data-testid="handoff-unsupported"
              className="flex flex-col gap-1 rounded-[6px] border border-border/50 px-3 py-2 text-[12px]"
            >
              <span className="font-medium">{t('git.handoff.unsupportedTitle')}</span>
              <span className="text-muted-foreground">{t('git.handoff.unsupportedDetail')}</span>
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
              {state.phase === 'blocked' && state.result?.outcome === 'blocked' && state.result.code === 'handoff-rolled-back' && (
                <span className="text-[12px] text-muted-foreground">{t('git.handoff.rolledBackDetail')}</span>
              )}
            </div>
          )}
        </div>

        <DialogFooter className={cn('mt-2 gap-2')}>
          <Button variant="ghost" onClick={close} disabled={busy}>
            {t('git.handoff.cancel')}
          </Button>
          {confirmable && (
            <Button
              data-testid="handoff-confirm-button"
              onClick={() => void handleConfirm()}
              disabled={state.phase !== 'preview' && state.phase !== 'confirming'}
            >
              {state.phase === 'confirming' ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t('git.handoff.confirming')}
                </>
              ) : (
                t('git.handoff.confirm')
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}


