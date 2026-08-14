import type {
  BrowserAnnotateMode,
  BrowserPageAnnotation,
} from '@kata-sh/shared/protocol'
import { formatBrowserAnnotationsAsMarkdown } from '../../../shared/browser-annotations/output'

export type AnnotationSessionOption = {
  id: string
  name?: string
  preview?: string
  workspaceId: string
  lastMessageAt?: number
  hidden?: boolean
  isArchived?: boolean
}

export function shouldEnableAnnotateMode(mode: BrowserAnnotateMode): boolean {
  return mode === 'idle'
}

export function isAnnotateModeActive(mode: BrowserAnnotateMode): boolean {
  return mode !== 'idle'
}

export function annotationListLabel(annotation: BrowserPageAnnotation): string {
  return (
    annotation.payload.target.accessibility.accessibleName ||
    annotation.payload.target.textSnippet ||
    annotation.payload.target.tagName
  )
}

export function workspaceSessionsForPicker(
  sessions: Iterable<AnnotationSessionOption>,
  workspaceId: string | null,
): AnnotationSessionOption[] {
  if (!workspaceId) return []
  return [...sessions]
    .filter((session) => (
      session.workspaceId === workspaceId
      && !session.hidden
      && !session.isArchived
    ))
    .sort((left, right) => (right.lastMessageAt ?? 0) - (left.lastMessageAt ?? 0))
}

export function markdownForBrowserAnnotations(
  annotations: BrowserPageAnnotation[],
): string | null {
  const markdown = formatBrowserAnnotationsAsMarkdown(annotations).trim()
  return markdown.length > 0 ? markdown : null
}

export async function copyAnnotationMarkdown(
  markdown: string | null,
  writeText: (value: string) => Promise<void>,
): Promise<boolean> {
  if (!markdown) return false
  await writeText(markdown)
  return true
}

export function sendAnnotationMarkdown(
  markdown: string | null,
  sessionId: string,
  sendMessage: (sessionId: string, content: string) => unknown,
): boolean {
  if (!markdown) return false
  void sendMessage(sessionId, markdown)
  return true
}

export function sessionPickerLabel(session: AnnotationSessionOption): string {
  const name = session.name?.trim()
  if (name) return name
  const preview = session.preview?.trim()
  if (preview) return preview
  return session.id
}
