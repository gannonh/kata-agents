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
 * Removal is requested as part of the delete call rather than as a separate
 * client step: the server quiesces the agent, verifies removal is allowed,
 * deletes the session durably, and only then removes the checkout. Doing it
 * from here in two calls could discard writes from a still-running turn, and
 * could leave a session pointing at an already-removed checkout if the delete
 * failed. Feature-flag gated; non-Git / current checkouts fall back to the
 * caller's ordinary confirmation path.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { AlertTriangle, GitFork, Loader2 } from 'lucide-react'
import type {
  SessionDeleteOptions,
  SessionDeleteResult,
  WorktreeRemovalRisk,
} from '@kata-sh/shared/protocol'
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
  /**
   * Perform the session deletion, forwarding the managed-worktree choice to the
   * server so it owns the ordering of the two irreversible steps.
   */
  onDeleteSession: (
    sessionId: string,
    options?: SessionDeleteOptions,
  ) => Promise<SessionDeleteResult>
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
  /** Bumped to re-run the risk inspection after a blocked removal. */
  const [refreshToken, setRefreshToken] = React.useState(0)

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
  }, [open, sessionId, refreshToken])

  const summary = risk ? summarizeWorktreeRemoval(risk) : null
  const offerRemoval = canOfferWorktreeRemoval(risk)
  const removalChosen = removeWorktree && offerRemoval && !summary?.blocked

  const handleConfirm = React.useCallback(async () => {
    if (!sessionId) return
    setBusy(true)
    try {
      // One server-owned operation. A destructive removal passes force.
      const result = await onDeleteSession(
        sessionId,
        removalChosen && summary
          ? {
              removeManagedWorktree: true,
              forceWorktreeRemoval: summary.destructive,
              // Send the counts actually rendered above, so `force` authorizes
              // discarding *this much* work rather than whatever the server
              // finds later. If the checkout gained work since, the server
              // refuses and we re-inspect so the user re-confirms real numbers.
              confirmedRisk: {
                uncommittedFileCount: summary.uncommittedFileCount,
                unpushedCommitCount: summary.unpushedCommitCount,
              },
            }
          : undefined,
      )

      if (!result?.deleted) {
        // Removal was rejected before anything changed — the session and its
        // checkout are both intact. Keep the dialog open so the user can retry
        // without the removal choice.
        toast.error(t('git.delete.removalBlockedToast'), {
          description: result?.worktreeRemoval?.blockedReason,
        })
        // Re-inspect so the displayed counts match the state that caused the
        // block; leaving the stale summary up would invite confirming the same
        // out-of-date numbers again.
        setRefreshToken((n) => n + 1)
        return
      }

      // The session is gone. Removal is a best-effort follow-on step, so report
      // it separately when it did not happen.
      const removal = result.worktreeRemoval
      if (removal && !removal.removed) {
        toast.error(t('git.delete.removalFailedToast'), { description: removal.blockedReason })
      }
      onDeleted?.(sessionId)
      onOpenChange(false)
    } catch (err) {
      toast.error(t('git.delete.deleteFailedToast'), {
        description: err instanceof Error ? err.message : String(err),
      })
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
