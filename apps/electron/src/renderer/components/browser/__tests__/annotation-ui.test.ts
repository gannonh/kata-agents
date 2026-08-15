import { describe, expect, it } from 'bun:test'
import type { BrowserPageAnnotation } from '@kata-sh/shared/protocol'
import {
  annotationListLabel,
  copyAnnotationMarkdown,
  isAnnotateModeActive,
  markdownForBrowserAnnotations,
  sendAnnotationMarkdown,
  sessionPickerLabel,
  shouldEnableAnnotateMode,
  isAnnotateChromeDisabled,
  workspaceSessionsForPicker,
  type AnnotationSessionOption,
} from '../annotation-ui'

function makeSession(
  overrides: Partial<AnnotationSessionOption> & Pick<AnnotationSessionOption, 'id' | 'workspaceId'>,
): AnnotationSessionOption {
  return {
    ...overrides,
  }
}

function makeAnnotation(overrides?: Partial<BrowserPageAnnotation>): BrowserPageAnnotation {
  return {
    id: 'annotation-1',
    browserPageId: 'page-1',
    comment: 'Make this primary action more obvious.',
    intent: 'change',
    createdAt: '2026-05-15T00:00:00.000Z',
    payload: {
      page: {
        sanitizedUrl: 'https://example.com/pricing',
        title: 'Pricing',
        viewportWidth: 1280,
        viewportHeight: 720,
        scrollX: 0,
        scrollY: 0,
        devicePixelRatio: 2,
        capturedAt: '2026-05-15T00:00:00.000Z',
      },
      target: {
        tagName: 'button',
        selector: 'main > button.primary',
        textSnippet: 'Start free trial',
        htmlSnippet: '<button class="primary">Start free trial</button>',
        attributes: { class: 'primary' },
        accessibility: {
          role: 'button',
          accessibleName: 'Start free trial',
          ariaLabel: null,
          ariaLabelledBy: null,
        },
        rectViewport: { x: 1, y: 2, width: 3, height: 4 },
        rectPage: { x: 1, y: 2, width: 3, height: 4 },
        computedStyles: {
          display: 'flex',
          position: 'relative',
          width: '10px',
          height: '10px',
          margin: '0px',
          padding: '0px',
          color: 'rgb(0, 0, 0)',
          backgroundColor: 'rgb(255, 255, 255)',
          border: '0px none',
          borderRadius: '0px',
          fontFamily: 'sans-serif',
          fontSize: '14px',
          fontWeight: '400',
          lineHeight: '20px',
          textAlign: 'left',
          zIndex: 'auto',
        },
      },
      nearbyText: [],
      ancestorPath: [],
      screenshot: null,
    },
    ...overrides,
  }
}

describe('annotation UI helpers', () => {
  it('toggles annotate mode off while selecting or composing', () => {
    expect(shouldEnableAnnotateMode('idle')).toBe(true)
    expect(shouldEnableAnnotateMode('selecting')).toBe(false)
    expect(shouldEnableAnnotateMode('composing')).toBe(false)
    expect(isAnnotateModeActive('idle')).toBe(false)
    expect(isAnnotateModeActive('selecting')).toBe(true)
    expect(isAnnotateChromeDisabled(true)).toBe(true)
    expect(isAnnotateChromeDisabled(false, true)).toBe(true)
    expect(isAnnotateChromeDisabled(false, false)).toBe(false)
  })

  it('filters picker sessions to the active workspace', () => {
    const sessions = [
      makeSession({ id: 'local', workspaceId: 'ws-1', name: 'Local', lastMessageAt: 2 }),
      makeSession({ id: 'other', workspaceId: 'ws-2', name: 'Other', lastMessageAt: 9 }),
      makeSession({ id: 'hidden', workspaceId: 'ws-1', name: 'Hidden', hidden: true, lastMessageAt: 8 }),
      makeSession({ id: 'archived', workspaceId: 'ws-1', name: 'Archived', isArchived: true, lastMessageAt: 7 }),
      makeSession({ id: 'older', workspaceId: 'ws-1', preview: 'older preview', lastMessageAt: 1 }),
    ]
    expect(workspaceSessionsForPicker(sessions, null)).toEqual([])
    expect(workspaceSessionsForPicker(sessions, 'ws-1').map((item) => item.id)).toEqual([
      'local',
      'older',
    ])
    expect(sessionPickerLabel(sessions[4]!)).toBe('older preview')
  })

  it('formats copy/send markdown without screenshots or secrets', () => {
    expect(markdownForBrowserAnnotations([])).toBeNull()
    const markdown = markdownForBrowserAnnotations([makeAnnotation()])
    expect(markdown).toContain('## Page feedback:')
    expect(markdown).toContain('Make this primary action more obvious.')
    expect(markdown).toContain('**Browser instance id:** page-1')
    expect(markdown).not.toMatch(/screenshot|password|data:image/i)
    expect(annotationListLabel(makeAnnotation())).toBe('Start free trial')
  })

  it('copies and sends the built markdown through the provided actions', async () => {
    const markdown = markdownForBrowserAnnotations([makeAnnotation()])
    const writes: string[] = []
    const sent: Array<{ sessionId: string; content: string }> = []
    expect(await copyAnnotationMarkdown(null, async (value) => { writes.push(value) })).toBe(false)
    expect(markdown).toBeTruthy()
    if (!markdown) return
    expect(await copyAnnotationMarkdown(markdown, async (value) => { writes.push(value) })).toBe(true)
    expect(writes).toEqual([markdown])
    expect(sendAnnotationMarkdown(null, 'session-1', (sessionId, content) => {
      sent.push({ sessionId, content })
    })).toBe(false)
    expect(sendAnnotationMarkdown(markdown, 'session-1', (sessionId, content) => {
      sent.push({ sessionId, content })
    })).toBe(true)
    expect(sent).toEqual([{ sessionId: 'session-1', content: markdown! }])
  })
})
