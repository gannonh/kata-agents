import {
  GRAB_BUDGET,
  normalizeAnnotationComment,
  type BrowserGrabPayload,
  type BrowserPageAnnotation,
} from '@kata-sh/shared/protocol'

export function createBrowserAnnotationId(): string {
  return `browser-annotation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function sanitizeBrowserPageAnnotation(annotation: BrowserPageAnnotation): BrowserPageAnnotation {
  const comment =
    normalizeAnnotationComment(annotation.comment) ?? annotation.comment.slice(0, GRAB_BUDGET.annotationCommentMaxLength)
  return {
    ...annotation,
    comment,
    payload: {
      ...annotation.payload,
      screenshot: null,
    },
  }
}

export function createBrowserAnnotationPayload(payload: BrowserGrabPayload): BrowserGrabPayload {
  return {
    ...payload,
    screenshot: null,
  }
}

export function createBrowserAnnotationStore() {
  const byInstance = new Map<string, BrowserPageAnnotation[]>()

  return {
    add(annotation: BrowserPageAnnotation): BrowserPageAnnotation | null {
      const comment = normalizeAnnotationComment(annotation.comment)
      if (!comment) return null
      const sanitized = sanitizeBrowserPageAnnotation({ ...annotation, comment })
      const existing = byInstance.get(sanitized.browserPageId) ?? []
      const next = [...existing, sanitized].slice(-GRAB_BUDGET.annotationsMaxPerPage)
      byInstance.set(sanitized.browserPageId, next)
      return sanitized
    },

    delete(instanceId: string, annotationId: string): boolean {
      const existing = byInstance.get(instanceId)
      if (!existing) return false
      const next = existing.filter((item) => item.id !== annotationId)
      if (next.length === existing.length) return false
      if (next.length === 0) byInstance.delete(instanceId)
      else byInstance.set(instanceId, next)
      return true
    },

    clear(instanceId: string): void {
      byInstance.delete(instanceId)
    },

    list(instanceId: string): BrowserPageAnnotation[] {
      return [...(byInstance.get(instanceId) ?? [])]
    },

    snapshot(): Record<string, BrowserPageAnnotation[]> {
      const result: Record<string, BrowserPageAnnotation[]> = {}
      for (const [id, annotations] of byInstance) {
        result[id] = [...annotations]
      }
      return result
    },
  }
}

export type BrowserAnnotationStore = ReturnType<typeof createBrowserAnnotationStore>
