/**
 * Persistent page-element annotations for the integrated browser.
 *
 * Bounded, redacted context captured from a guest page. Screenshots and
 * raw secrets are never part of the persisted record.
 */

export type BrowserGrabPageContext = {
  sanitizedUrl: string
  title: string
  viewportWidth: number
  viewportHeight: number
  scrollX: number
  scrollY: number
  devicePixelRatio: number
  capturedAt: string
}

export type BrowserGrabAccessibility = {
  role: string | null
  accessibleName: string | null
  ariaLabel: string | null
  ariaLabelledBy: string | null
}

export type BrowserGrabComputedStyles = {
  display: string
  position: string
  width: string
  height: string
  margin: string
  padding: string
  color: string
  backgroundColor: string
  border: string
  borderRadius: string
  fontFamily: string
  fontSize: string
  fontWeight: string
  lineHeight: string
  textAlign: string
  zIndex: string
}

export type BrowserGrabRect = {
  x: number
  y: number
  width: number
  height: number
}

export type BrowserGrabTarget = {
  tagName: string
  selector: string
  elementPath?: string
  fullPath?: string
  cssClasses?: string
  nearbyElements?: string[]
  selectedText?: string | null
  isFixed?: boolean
  reactComponents?: string | null
  sourceFile?: string | null
  textSnippet: string
  htmlSnippet: string
  attributes: Record<string, string>
  accessibility: BrowserGrabAccessibility
  rectViewport: BrowserGrabRect
  rectPage: BrowserGrabRect
  computedStyles: BrowserGrabComputedStyles
}

export type BrowserGrabPayload = {
  page: BrowserGrabPageContext
  target: BrowserGrabTarget
  nearbyText: string[]
  ancestorPath: string[]
  screenshot: null
}

export type BrowserAnnotationIntent = 'fix' | 'change' | 'question' | 'approve'

export const BROWSER_ANNOTATION_INTENTS: readonly BrowserAnnotationIntent[] = [
  'change',
  'fix',
  'question',
  'approve',
]

export type BrowserPageAnnotation = {
  id: string
  browserPageId: string
  comment: string
  intent: BrowserAnnotationIntent
  createdAt: string
  payload: BrowserGrabPayload
}

export type BrowserGrabCancelReason = 'user' | 'tab-inactive' | 'navigation' | 'evicted' | 'timeout'

export type BrowserGrabResult =
  | { opId: string; kind: 'selected'; payload: BrowserGrabPayload }
  | { opId: string; kind: 'cancelled'; reason: BrowserGrabCancelReason }
  | { opId: string; kind: 'error'; reason: string }

export type BrowserGrabRejectReason =
  | 'not-ready'
  | 'not-authorized'
  | 'already-active'
  | 'injection-failed'

export type BrowserAnnotateMode = 'idle' | 'selecting' | 'composing'

export type BrowserAnnotationState = {
  instanceId: string
  mode: BrowserAnnotateMode
  annotations: BrowserPageAnnotation[]
  pendingLabel: string | null
}

export type BrowserSetAnnotateModeResult =
  | { ok: true }
  | { ok: false; reason: BrowserGrabRejectReason }

export const GRAB_BUDGET = {
  textSnippetMaxLength: 200,
  nearbyTextEntryMaxLength: 200,
  nearbyTextMaxEntries: 10,
  htmlSnippetMaxLength: 4096,
  ancestorPathMaxEntries: 10,
  nearbyElementsMaxEntries: 6,
  nearbyElementMaxLength: 160,
  selectorMaxLength: 700,
  pathMaxLength: 900,
  cssClassesMaxLength: 500,
  selectedTextMaxLength: 500,
  sourceFileMaxLength: 500,
  reactComponentsMaxLength: 500,
  annotationCommentMaxLength: 2000,
  annotationsMaxPerPage: 20,
  attributesMaxCount: 32,
} as const

export const GRAB_SAFE_ATTRIBUTE_NAMES = new Set([
  'id',
  'class',
  'name',
  'type',
  'role',
  'href',
  'src',
  'alt',
  'title',
  'placeholder',
  'for',
  'action',
  'method',
])

export function isAriaAttribute(name: string): boolean {
  return name.startsWith('aria-')
}

export const GRAB_SECRET_PATTERNS = [
  'access_token',
  'auth_token',
  'api_key',
  'apikey',
  'client_secret',
  'oauth_state',
  'x-amz-',
  'session_id',
  'sessionid',
  'csrf',
  'secret',
  'password',
  'passwd',
]

export const GRAB_STYLE_PROPERTIES: readonly (keyof BrowserGrabComputedStyles)[] = [
  'display',
  'position',
  'width',
  'height',
  'margin',
  'padding',
  'color',
  'backgroundColor',
  'border',
  'borderRadius',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'textAlign',
  'zIndex',
]

export function isBrowserAnnotationIntent(value: unknown): value is BrowserAnnotationIntent {
  return (
    value === 'fix' ||
    value === 'change' ||
    value === 'question' ||
    value === 'approve'
  )
}

export function normalizeAnnotationComment(
  comment: string,
  maxLength = GRAB_BUDGET.annotationCommentMaxLength,
): string | null {
  const trimmed = comment.trim()
  if (!trimmed) return null
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed
}
