/**
 * ChangesDiffView — bounded diff for one selected path with inline line
 * feedback.
 *
 * Handles the explicit per-file states the spec requires (text / binary /
 * oversized / missing / clean / error / loading), and layers diff-line comments
 * on top of the text state via ShikiDiffViewer's annotation primitives.
 *
 * Comments anchor to Pierre's `deletions` (old) / `additions` (new) sides. When
 * a fresh diff arrives its fingerprint is reconciled against pending comments so
 * a changed diff marks affected comments stale (AC11).
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue } from 'jotai'
import { MessageSquarePlus, Loader2, FileWarning, Ban, FileX2 } from 'lucide-react'
import type { DiffLineAnnotation } from '@pierre/diffs/react'
import type { GitFileDiff, GitPendingComment } from '@kata-sh/shared/protocol'
import { createPendingComment } from '@kata-sh/shared/git'
import { cn } from '@/lib/utils'
import { ShikiDiffViewer } from '@/components/shiki/ShikiDiffViewer'
import { sessionPendingCommentsAtomFamily, addPendingComment, removePendingComment, reconcileStaleForSessionPath } from '@/atoms/git-comments'
import { toPierreSide, fromPierreSide, lineContext, type PierreSide } from './diff-side'

type ChangeAnnotation =
  | { kind: 'comment'; comment: GitPendingComment }
  | { kind: 'composer'; side: PierreSide; line: number }

export interface ChangesDiffViewProps {
  sessionId: string
  path: string
  diffStyle: 'unified' | 'split'
}

function StateCard({ icon, title, detail }: { icon: React.ReactNode; title: string; detail?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
      {icon}
      <p className="text-sm font-medium">{title}</p>
      {detail && <p className="text-xs opacity-70">{detail}</p>}
    </div>
  )
}

let commentSeq = 0
function nextCommentId(): string {
  commentSeq += 1
  return `cmt_${Date.now().toString(36)}_${commentSeq}`
}

export function ChangesDiffView({ sessionId, path, diffStyle }: ChangesDiffViewProps) {
  const { t } = useTranslation()
  const [diff, setDiff] = React.useState<GitFileDiff | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [composer, setComposer] = React.useState<{ side: PierreSide; line: number } | null>(null)
  const [draft, setDraft] = React.useState('')

  const allComments = useAtomValue(sessionPendingCommentsAtomFamily(sessionId))
  const pathComments = React.useMemo(
    () => allComments.filter((c) => c.path === path),
    [allComments, path],
  )

  React.useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setComposer(null)
    setDraft('')
    window.electronAPI
      .getGitDiff(sessionId, path)
      .then((result) => {
        if (cancelled) return
        setDiff(result)
        // A changed diff marks affected comments stale (AC11).
        reconcileStaleForSessionPath(sessionId, path, result.fingerprint)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, path])

  const openComposer = React.useCallback((side: PierreSide, line: number) => {
    setComposer({ side, line })
    setDraft('')
  }, [])

  const submitComposer = React.useCallback(() => {
    if (!composer || !diff) return
    const text = draft.trim()
    if (!text) return
    const side = fromPierreSide(composer.side)
    const content = side === 'old' ? diff.oldContent : diff.newContent
    addPendingComment(
      createPendingComment({
        id: nextCommentId(),
        sessionId,
        path,
        previousPath: diff.previousPath,
        side,
        line: composer.line,
        text,
        diffFingerprint: diff.fingerprint,
        context: lineContext(content, composer.line),
        createdAt: Date.now(),
      }),
    )
    setComposer(null)
    setDraft('')
  }, [composer, diff, draft, sessionId, path])

  const lineAnnotations = React.useMemo<DiffLineAnnotation<ChangeAnnotation>[]>(() => {
    const annotations: DiffLineAnnotation<ChangeAnnotation>[] = pathComments.map((comment) => ({
      side: toPierreSide(comment.side),
      lineNumber: comment.line,
      metadata: { kind: 'comment', comment },
    }))
    if (composer) {
      annotations.push({
        side: composer.side,
        lineNumber: composer.line,
        metadata: { kind: 'composer', side: composer.side, line: composer.line },
      })
    }
    return annotations
  }, [pathComments, composer])

  const renderAnnotation = React.useCallback(
    (annotation: DiffLineAnnotation<ChangeAnnotation>) => {
      const meta = annotation.metadata
      if (!meta) return null
      if (meta.kind === 'composer') {
        return (
          <div className="mx-2 my-1 rounded-[6px] border border-border bg-background p-2 shadow-minimal">
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  submitComposer()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  setComposer(null)
                }
              }}
              placeholder={t('git.changes.commentPlaceholder')}
              className="min-h-[52px] w-full resize-y rounded-[4px] bg-foreground/5 p-2 text-[13px] outline-none placeholder:text-muted-foreground/60"
            />
            <div className="mt-1.5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setComposer(null)}
                className="rounded-[4px] px-2 py-1 text-[12px] text-muted-foreground hover:bg-foreground/5"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={submitComposer}
                disabled={!draft.trim()}
                className={cn(
                  'rounded-[4px] bg-foreground px-2 py-1 text-[12px] font-medium text-background',
                  !draft.trim() && 'opacity-50',
                )}
              >
                {t('git.changes.addComment')}
              </button>
            </div>
          </div>
        )
      }
      const { comment } = meta
      return (
        <div
          className={cn(
            'mx-2 my-1 rounded-[6px] border border-border bg-background p-2 shadow-minimal',
            comment.stale && 'border-amber-500/60',
          )}
        >
          <div className="flex items-start justify-between gap-2">
            <p className="whitespace-pre-wrap text-[13px]">{comment.text}</p>
            <button
              type="button"
              onClick={() => removePendingComment(comment.id)}
              className="shrink-0 rounded-[4px] px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-foreground/5"
            >
              {t('common.delete')}
            </button>
          </div>
          {comment.stale && (
            <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
              {t('git.changes.commentStale')}
            </p>
          )}
        </div>
      )
    },
    [draft, submitComposer, t],
  )

  const renderHoverUtility = React.useCallback(
    (getHoveredLine: () => { lineNumber: number; side: PierreSide } | undefined) => (
      <button
        type="button"
        aria-label={t('git.changes.addComment')}
        onClick={() => {
          const hovered = getHoveredLine()
          if (hovered) openComposer(hovered.side, hovered.lineNumber)
        }}
        className="inline-flex h-4 w-4 items-center justify-center rounded-[3px] bg-foreground text-background"
      >
        <MessageSquarePlus className="h-3 w-3" />
      </button>
    ),
    [openComposer, t],
  )

  if (loading) {
    return <StateCard icon={<Loader2 className="h-5 w-5 animate-spin" />} title={t('common.loading')} />
  }
  if (error) {
    return <StateCard icon={<FileWarning className="h-6 w-6" />} title={t('git.changes.diffError')} detail={error} />
  }
  if (!diff) {
    return <StateCard icon={<FileWarning className="h-6 w-6" />} title={t('git.changes.diffError')} />
  }

  switch (diff.state) {
    case 'binary':
      return <StateCard icon={<Ban className="h-6 w-6" />} title={t('git.changes.binaryFile')} detail={path} />
    case 'oversized':
      return <StateCard icon={<FileWarning className="h-6 w-6" />} title={t('git.changes.oversizedFile')} detail={path} />
    case 'missing':
      return <StateCard icon={<FileX2 className="h-6 w-6" />} title={t('git.changes.missingFile')} detail={path} />
    case 'clean':
      return <StateCard icon={<FileWarning className="h-6 w-6" />} title={t('git.changes.fileClean')} detail={path} />
    case 'error':
      return <StateCard icon={<FileWarning className="h-6 w-6" />} title={t('git.changes.diffError')} detail={diff.error} />
    case 'text':
    default:
      return (
        <ShikiDiffViewer<ChangeAnnotation>
          original={diff.oldContent ?? ''}
          modified={diff.newContent ?? ''}
          filePath={path}
          language={diff.language}
          diffStyle={diffStyle}
          disableFileHeader
          lineAnnotations={lineAnnotations}
          renderAnnotation={renderAnnotation}
          renderHoverUtility={renderHoverUtility}
          onLineNumberClick={(pointer) => openComposer(pointer.side, pointer.lineNumber)}
        />
      )
  }
}
