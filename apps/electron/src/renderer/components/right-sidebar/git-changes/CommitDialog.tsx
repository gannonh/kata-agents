/**
 * CommitDialog — editable commit message + whole-file selection (spec: AC13).
 *
 * Defaults to committing all changed files. Renames are shown and selected as a
 * single atomic old→new pair (the server expands the pair). The server commits
 * only the selected whole-file paths and preserves unrelated staged entries.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { changeIndicator, sortStatusEntries } from '@kata-sh/shared/git'
import type { GitWorkingTreeEntry } from '@kata-sh/shared/protocol'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useRegisterModal } from '@/context/ModalContext'

export interface CommitDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  entries: GitWorkingTreeEntry[]
  defaultMessage: string
  /** Non-null when committing to the repository's default branch (warning). */
  defaultBranchName?: string | null
  busy: boolean
  onCommit: (message: string, paths: string[]) => void
}

export function CommitDialog({
  open,
  onOpenChange,
  entries,
  defaultMessage,
  defaultBranchName,
  busy,
  onCommit,
}: CommitDialogProps) {
  const { t } = useTranslation()
  useRegisterModal(open, () => onOpenChange(false))

  const sorted = React.useMemo(() => sortStatusEntries(entries), [entries])
  const [message, setMessage] = React.useState(defaultMessage)
  const [selected, setSelected] = React.useState<Set<string>>(
    () => new Set(sorted.map((e) => e.path)),
  )

  // Re-seed the message + selection each time the dialog opens.
  React.useEffect(() => {
    if (open) {
      setMessage(defaultMessage)
      setSelected(new Set(sorted.map((e) => e.path)))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const toggle = React.useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const allSelected = selected.size === sorted.length && sorted.length > 0
  const toggleAll = React.useCallback(() => {
    setSelected((prev) =>
      prev.size === sorted.length ? new Set() : new Set(sorted.map((e) => e.path)),
    )
  }, [sorted])

  const canCommit = message.trim().length > 0 && selected.size > 0 && !busy

  const handleCommit = () => {
    if (!canCommit) return
    onCommit(message.trim(), Array.from(selected))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="git-commit-dialog"
        className="sm:max-w-[480px]"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t('git.commit.title')}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-[12px] font-medium text-muted-foreground">
              {t('git.commit.messageLabel')}
            </label>
            <Textarea
              data-testid="git-commit-message"
              autoFocus
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={t('git.commit.messagePlaceholder')}
              rows={3}
              className="resize-none"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label className="text-[12px] font-medium text-muted-foreground">
                {t('git.commit.filesLabel')}
              </label>
              {sorted.length > 0 && (
                <button
                  type="button"
                  onClick={toggleAll}
                  className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
                >
                  {allSelected ? t('git.commit.deselectAll') : t('git.commit.selectAll')}
                </button>
              )}
            </div>
            {sorted.length === 0 ? (
              <p className="py-2 text-[12px] text-muted-foreground">{t('git.commit.noFiles')}</p>
            ) : (
              <div className="max-h-[200px] overflow-y-auto rounded-[6px] border border-border/50">
                {sorted.map((entry) => {
                  const indicator = changeIndicator(entry.type)
                  const label = entry.previousPath
                    ? `${entry.previousPath} → ${entry.path}`
                    : entry.path
                  return (
                    <label
                      key={entry.path}
                      className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[13px] hover:bg-sidebar-hover"
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(entry.path)}
                        onChange={() => toggle(entry.path)}
                        className="h-3.5 w-3.5"
                      />
                      <span className="w-3 shrink-0 text-center font-mono text-[11px] font-semibold">
                        {indicator}
                      </span>
                      <span className="min-w-0 flex-1 truncate" title={label}>
                        {label}
                      </span>
                    </label>
                  )
                })}
              </div>
            )}
          </div>

          {defaultBranchName && (
            <p className="rounded-[6px] bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-600 dark:text-amber-400">
              {t('git.commit.defaultBranchWarning', { branch: defaultBranchName })}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button data-testid="git-commit-submit" onClick={handleCommit} disabled={!canCommit}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {busy ? t('git.commit.submitting') : t('git.commit.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
