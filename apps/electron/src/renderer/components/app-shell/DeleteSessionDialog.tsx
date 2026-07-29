/**
 * DeleteSessionDialog — delete a session and, as a *separate* choice, optionally
 * remove its managed worktree (spec: AC18–AC19).
 *
 * Session deletion always drops the worktree owner reference but never removes
 * the checkout on its own. Managed-worktree removal is offered as an explicit
 * additional choice that is:
 *  - blocked while another session still owns the worktree;
 *  - guarded by a destructive confirmation naming the uncommitted-file and
 *    unpushed/unique-commit counts;
 *  - allowed to prune the temporary branch only when it has no unique work.
 *
 * Removal (when chosen) runs before deletion so the server can still resolve the
 * worktree from the owning session. Feature-flag gated; non-Git / current
 * checkouts fall back to the caller's ordinary confirmation path.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { AlertTriangle, GitFork, Loader2 } from 'lucide-react'
import type { WorktreeRemovalRisk } from '@kata-sh/shared/protocol'
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
import { cn } from '@/lib/utils'
import { summarizeWorktreeRemoval, canOfferWorktreeRemoval } from './worktree-removal'

export interface DeleteSessionDialogProps {
  open: boolean
  sessionId: string | null
  sessionName: string
  /** Expected managed-worktree branch, for the removal label. */
  branch?: string | null
  onOpenChange: (open: boolean) => void
  /** Perform the session deletion (drops ownership; never removes the worktree). */
  onDeleteSession: (sessionId: string) => Promise<void>
  /** Notified after a successful deletion so the caller can update UI. */
  onDeleted?: (sessionId: string) => void
}

export function DeleteSessionDialog({
  open,
  sessionId,
  sessionName,
  branch,
  onOpenChange,
  onDeleteSession,
  onDeleted,
}: DeleteSessionDialogProps) {
  const { t } = useTranslation()
  useRegisterModal(open, () => onOpenChange(false))

  const [risk, setRisk] = React.useState<WorktreeRemovalRisk | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [removeWorktree, setRemoveWorktree] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  // Inspect removal risk when the dialog opens for a managed-worktree session.
  React.useEffect(() => {
    if (!open || !sessionId) {
      setRisk(null)
      setRemoveWorktree(false)
      return
    }
    let cancelled = false
    setLoading(true)
    window.electronAPI
      .inspectGitWorktreeRemoval(sessionId)
      .then((r) => {
        if (!cancelled) setRisk(r)
      })
      .catch(() => {
        if (!cancelled) setRisk(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, sessionId])

  const summary = risk ? summarizeWorktreeRemoval(risk) : null
  const offerRemoval = canOfferWorktreeRemoval(risk)
  const removalChosen = removeWorktree && offerRemoval && !summary?.blocked

  const handleConfirm = React.useCallback(async () => {
    if (!sessionId) return
    setBusy(true)
    try {
      // Remove the worktree first (while the owning session can still resolve
      // it), then delete the session. A destructive removal passes force.
      if (removalChosen && summary) {
        try {
          const res = await window.electronAPI.removeGitWorktree(sessionId, summary.destructive)
          if (res.blocked) {
            toast.error(t('git.delete.removalBlockedToast'), { description: res.blockedReason })
            setBusy(false)
            return
          }
        } catch (err) {
          toast.error(t('git.delete.removalFailedToast'), {
            description: err instanceof Error ? err.message : String(err),
          })
          setBusy(false)
          return
        }
      }
      await onDeleteSession(sessionId)
      onDeleted?.(sessionId)
      onOpenChange(false)
    } finally {
      setBusy(false)
    }
  }, [sessionId, removalChosen, summary, onDeleteSession, onDeleted, onOpenChange, t])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="git-delete-session-dialog" className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{t('git.delete.title')}</DialogTitle>
          <DialogDescription>{t('git.delete.description', { name: sessionName })}</DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center gap-2 py-2 text-[13px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('common.loading')}
          </div>
        )}

        {!loading && offerRemoval && summary && (
          <div className="rounded-[8px] border border-border/60 p-3">
            <label
              className={cn(
                'flex items-start gap-2.5 text-[13px]',
                summary.blocked ? 'cursor-not-allowed opacity-70' : 'cursor-pointer',
              )}
            >
              <input
                type="checkbox"
                data-testid="git-delete-remove-worktree"
                className="mt-0.5 h-4 w-4 shrink-0 accent-destructive"
                checked={removalChosen}
                disabled={summary.blocked || busy}
                onChange={(e) => setRemoveWorktree(e.target.checked)}
              />
              <span className="flex flex-col gap-1">
                <span className="inline-flex items-center gap-1.5 font-medium">
                  <GitFork className="h-3.5 w-3.5 shrink-0" />
                  {branch
                    ? t('git.delete.removeWorktreeLabelBranch', { branch })
                    : t('git.delete.removeWorktreeLabel')}
                </span>

                {summary.blocked ? (
                  <span className="text-[12px] text-muted-foreground">
                    {t('git.delete.sharedBlocked', { count: summary.otherOwnerCount })}
                  </span>
                ) : (
                  <>
                    <span className="text-[12px] text-muted-foreground">
                      {t('git.delete.worktreeKeptNote')}
                    </span>
                    {removalChosen && summary.destructive && (
                      <span
                        data-testid="git-delete-destructive-warning"
                        className="mt-1 flex flex-col gap-0.5 rounded-[6px] bg-destructive/10 p-2 text-[12px] text-destructive"
                      >
                        <span className="inline-flex items-center gap-1.5 font-medium">
                          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                          {t('git.delete.destructiveHeading')}
                        </span>
                        {summary.uncommittedFileCount > 0 && (
                          <span>
                            {t('git.delete.uncommittedWarning', {
                              count: summary.uncommittedFileCount,
                            })}
                          </span>
                        )}
                        {summary.unpushedCommitCount > 0 && (
                          <span>
                            {t('git.delete.unpushedWarning', {
                              count: summary.unpushedCommitCount,
                            })}
                          </span>
                        )}
                      </span>
                    )}
                    {removalChosen && summary.branchHasUniqueWork && (
                      <span className="text-[12px] text-muted-foreground">
                        {t('git.delete.branchKeptNote')}
                      </span>
                    )}
                  </>
                )}
              </span>
            </label>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            data-testid="git-delete-confirm"
            variant="destructive"
            onClick={handleConfirm}
            disabled={busy || loading}
          >
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {removalChosen && summary?.destructive
              ? t('git.delete.confirmDestructive')
              : t('git.delete.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
