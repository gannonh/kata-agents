/**
 * PullRequestDialog — editable PR title/body (spec: AC15). The base ref is
 * resolved server-side (managed worktree base else default ref), so it is shown
 * read-only for context and not editable here.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useRegisterModal } from '@/context/ModalContext'

export interface PullRequestDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultTitle: string
  defaultBody: string
  /** Base branch shown for context; resolved server-side. */
  baseRef?: string | null
  busy: boolean
  onCreate: (title: string, body: string) => void
}

export function PullRequestDialog({
  open,
  onOpenChange,
  defaultTitle,
  defaultBody,
  baseRef,
  busy,
  onCreate,
}: PullRequestDialogProps) {
  const { t } = useTranslation()
  useRegisterModal(open, () => onOpenChange(false))

  const [title, setTitle] = React.useState(defaultTitle)
  const [body, setBody] = React.useState(defaultBody)

  React.useEffect(() => {
    if (open) {
      setTitle(defaultTitle)
      setBody(defaultBody)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const canCreate = title.trim().length > 0 && !busy

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]" onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{t('git.pr.title')}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {baseRef && (
            <p className="text-[12px] text-muted-foreground">{t('git.pr.base', { ref: baseRef })}</p>
          )}
          <div className="flex flex-col gap-1.5">
            <label className="text-[12px] font-medium text-muted-foreground">
              {t('git.pr.titleLabel')}
            </label>
            <Input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('git.pr.titlePlaceholder')}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-[12px] font-medium text-muted-foreground">
              {t('git.pr.bodyLabel')}
            </label>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={t('git.pr.bodyPlaceholder')}
              rows={6}
              className="resize-none"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => canCreate && onCreate(title.trim(), body)} disabled={!canCreate}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {busy ? t('git.pr.submitting') : t('git.pr.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
