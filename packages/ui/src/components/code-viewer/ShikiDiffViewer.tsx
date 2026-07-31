/**
 * ShikiDiffViewer - Diff viewer using @pierre/diffs (Shiki-based)
 *
 * Platform-agnostic component for displaying file diffs with:
 * - Unified or split diff view
 * - Syntax highlighting via Shiki
 * - Light/dark theme support
 * - Line-level diff highlighting
 */

import * as React from 'react'
import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import {
  FileDiff,
  type FileDiffMetadata,
  type FileDiffProps,
  type DiffLineAnnotation,
} from '@pierre/diffs/react'
import {
  parseDiffFromFile,
  DIFFS_TAG_NAME,
  type FileContents,
  type SelectedLineRange,
  type GetHoveredLineResult,
} from '@pierre/diffs'
import { cn } from '../../lib/utils'
import { LANGUAGE_MAP } from './language-map'
import { registerCraftShikiThemes } from './registerShikiThemes'

/** Which diff side a line event/annotation targets, in Pierre's vocabulary. */
export type DiffAnnotationSide = 'deletions' | 'additions'

/** Diff-line pointer emitted by Pierre's mouse handlers (stable old/new identity). */
export interface DiffLinePointer {
  lineNumber: number
  side: DiffAnnotationSide
}

// Register the diffs-container custom element if not already registered
// This is necessary because the React component renders a custom element
if (typeof HTMLElement !== 'undefined' && !customElements.get(DIFFS_TAG_NAME)) {
  class FileDiffContainer extends HTMLElement {
    constructor() {
      super()
      if (this.shadowRoot != null) return
      this.attachShadow({ mode: 'open' })
    }
  }
  customElements.define(DIFFS_TAG_NAME, FileDiffContainer)
}

// Register custom themes once per runtime.
registerCraftShikiThemes()

export interface ShikiDiffViewerProps<TAnnotation = undefined> {
  /** Original (before) content */
  original: string
  /** Modified (after) content */
  modified: string
  /** File path - used for language detection and display */
  filePath?: string
  /** Language for syntax highlighting (auto-detected from filePath if not provided) */
  language?: string
  /** Diff style: 'unified' (stacked) or 'split' (side-by-side) */
  diffStyle?: 'unified' | 'split'
  /** Theme mode */
  theme?: 'light' | 'dark'
  /** Shiki theme name (e.g., 'dracula', 'github-dark'). When provided, uses the matching
   *  Shiki theme natively. Falls back to craft-dark/craft-light (transparent bg) if not set. */
  shikiTheme?: string
  /** Disable background highlighting on changed lines */
  disableBackground?: boolean
  /** Whether to hide pierre's native file header (filename + stats). Default: true */
  disableFileHeader?: boolean
  /** Callback when the file header is clicked (e.g. to open the file in an editor).
   *  When provided, the header becomes clickable with cursor: pointer. */
  onFileHeaderClick?: (filePath: string) => void
  /** Callback when ready */
  onReady?: () => void
  /** Additional class names */
  className?: string

  // --- Line annotations & interaction (diff-line feedback) ---
  /**
   * Annotations anchored to specific old (`deletions`) / new (`additions`) diff
   * lines. Rendered inline via {@link renderAnnotation}. Line identity is stable
   * across renders as long as the underlying diff is unchanged.
   */
  lineAnnotations?: DiffLineAnnotation<TAnnotation>[]
  /** Render an inline annotation body for a given anchored line. */
  renderAnnotation?: (annotation: DiffLineAnnotation<TAnnotation>) => React.ReactNode
  /**
   * Render a hover utility (e.g. an "add comment" affordance) for the currently
   * hovered diff line. Receives an accessor returning the hovered line + side.
   */
  renderHoverUtility?: (
    getHoveredLine: () => GetHoveredLineResult<'diff'> | undefined,
  ) => React.ReactNode
  /** Selected diff line range (for highlighting an in-progress selection). */
  selectedLines?: SelectedLineRange | null
  /** Fired when a diff line's gutter number is clicked (stable old/new pointer). */
  onLineNumberClick?: (pointer: DiffLinePointer) => void
  /** Fired when a diff line body is clicked (stable old/new pointer). */
  onLineClick?: (pointer: DiffLinePointer) => void
}

/**
 * Calculate addition/deletion stats from a FileDiffMetadata
 * Useful for displaying change counts in headers
 */
export function getDiffStats(fileDiff: FileDiffMetadata): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const hunk of fileDiff.hunks) {
    additions += hunk.additionCount
    deletions += hunk.deletionCount
  }
  return { additions, deletions }
}

function getLanguageFromPath(filePath: string, explicit?: string): string {
  if (explicit) return explicit
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  return LANGUAGE_MAP[ext] || 'text'
}

/**
 * ShikiDiffViewer - Shiki-based diff viewer component
 */
export function ShikiDiffViewer<TAnnotation = undefined>({
  original,
  modified,
  filePath = 'file',
  language,
  diffStyle = 'unified',
  theme = 'light',
  shikiTheme,
  disableBackground = false,
  disableFileHeader = true,
  onFileHeaderClick,
  onReady,
  className,
  lineAnnotations,
  renderAnnotation,
  renderHoverUtility,
  selectedLines,
  onLineNumberClick,
  onLineClick,
}: ShikiDiffViewerProps<TAnnotation>) {
  const hasCalledReady = useRef(false)
  const [isReady, setIsReady] = useState(false)

  // Resolve language
  const resolvedLang = useMemo(() => {
    return language || getLanguageFromPath(filePath)
  }, [language, filePath])

  // Create file contents objects for the diff parser
  const oldFile: FileContents = useMemo(() => ({
    name: filePath,
    contents: original,
    lang: resolvedLang as any,
  }), [filePath, original, resolvedLang])

  const newFile: FileContents = useMemo(() => ({
    name: filePath,
    contents: modified,
    lang: resolvedLang as any,
  }), [filePath, modified, resolvedLang])

  // Parse the diff
  const fileDiff: FileDiffMetadata = useMemo(() => {
    return parseDiffFromFile(oldFile, newFile)
  }, [oldFile, newFile])

  // Diff options - use the app's Shiki theme if available, otherwise fall back
  // to craft-dark/craft-light which have transparent bg for CSS variable theming
  const resolvedThemeName = shikiTheme || (theme === 'dark' ? 'craft-dark' : 'craft-light')
  // When onFileHeaderClick is provided, inject CSS to make the header look clickable
  const unsafeCSS = onFileHeaderClick
    ? '[data-diffs-header] { cursor: pointer; } [data-diffs-header]:hover [data-title] { text-decoration: underline; }'
    : undefined

  // Keep the latest click callbacks in refs so the options object (and thus the
  // underlying pierre instance) does not churn on every parent render.
  const onLineNumberClickRef = useRef(onLineNumberClick)
  onLineNumberClickRef.current = onLineNumberClick
  const onLineClickRef = useRef(onLineClick)
  onLineClickRef.current = onLineClick

  const enableLineEvents = !!onLineNumberClick || !!onLineClick
  const enableHoverUtility = !!renderHoverUtility

  const options: FileDiffProps<TAnnotation>['options'] = useMemo(() => ({
    theme: resolvedThemeName,
    diffStyle,
    diffIndicators: 'bars',
    disableBackground,
    lineDiffType: 'word',
    overflow: 'scroll',
    disableFileHeader,
    themeType: theme === 'dark' ? 'dark' : 'light',
    unsafeCSS,
    enableHoverUtility,
    ...(enableLineEvents
      ? {
          onLineNumberClick: (props) =>
            onLineNumberClickRef.current?.({
              lineNumber: props.lineNumber,
              side: props.annotationSide,
            }),
          onLineClick: (props) =>
            onLineClickRef.current?.({
              lineNumber: props.lineNumber,
              side: props.annotationSide,
            }),
        }
      : {}),
  }), [
    resolvedThemeName,
    theme,
    diffStyle,
    disableBackground,
    disableFileHeader,
    unsafeCSS,
    enableHoverUtility,
    enableLineEvents,
  ])

  // Call onReady after first render
  useEffect(() => {
    if (!hasCalledReady.current && onReady) {
      hasCalledReady.current = true
      // Give Shiki time to highlight
      const timer = setTimeout(() => {
        setIsReady(true)
        onReady()
      }, 100)
      return () => {
        clearTimeout(timer)
        hasCalledReady.current = false // Reset so re-mounts (including StrictMode) re-arm the timer
      }
    }
  }, [onReady, original, modified, fileDiff])

  // Attach a click listener to the file header inside pierre's shadow DOM.
  // We query for the <diffs-container> custom element, then find [data-diffs-header]
  // inside its shadowRoot. This lets the filename be clickable without modifying pierre.
  const containerRef = useRef<HTMLDivElement>(null)
  const onFileHeaderClickRef = useRef(onFileHeaderClick)
  onFileHeaderClickRef.current = onFileHeaderClick

  useEffect(() => {
    if (!onFileHeaderClick || disableFileHeader) return

    // Wait briefly for pierre to render the header into the shadow DOM
    const timer = setTimeout(() => {
      const diffsContainer = containerRef.current?.querySelector(DIFFS_TAG_NAME)
      const header = diffsContainer?.shadowRoot?.querySelector('[data-diffs-header]')
      if (!header) return

      const handleClick = () => {
        onFileHeaderClickRef.current?.(filePath)
      }
      header.addEventListener('click', handleClick)
      // Store cleanup ref so we can remove listener
      ;(header as any).__craftClickCleanup = () => header.removeEventListener('click', handleClick)
    }, 150)

    return () => {
      clearTimeout(timer)
      const diffsContainer = containerRef.current?.querySelector(DIFFS_TAG_NAME)
      const header = diffsContainer?.shadowRoot?.querySelector('[data-diffs-header]')
      if (header) {
        ;(header as any).__craftClickCleanup?.()
      }
    }
  }, [filePath, disableFileHeader, onFileHeaderClick])

  // Use CSS variable so custom themes are respected
  const backgroundColor = 'var(--background)'

  return (
    <div
      ref={containerRef}
      className={cn(
        'h-full w-full overflow-auto transition-opacity duration-200',
        className
      )}
      style={{
        backgroundColor,
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 13,
        lineHeight: 1.6,
      }}
    >
      <FileDiff<TAnnotation>
        fileDiff={fileDiff}
        options={options}
        lineAnnotations={lineAnnotations}
        renderAnnotation={renderAnnotation}
        renderHoverUtility={renderHoverUtility}
        selectedLines={selectedLines}
        className="min-h-full h-full"
      />
    </div>
  )
}
