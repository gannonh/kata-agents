import { describe, expect, it } from 'bun:test'
import { GRAB_BUDGET, type BrowserPageAnnotation } from '@kata-sh/shared/protocol'
import { createBrowserAnnotationStore } from '../store'

function makeAnnotation(
  pageId: string,
  id: string,
  overrides?: Partial<BrowserPageAnnotation>,
): BrowserPageAnnotation {
  return {
    id,
    browserPageId: pageId,
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
        selector: 'main.pricing > button.primary',
        elementPath: 'main > .pricing > button',
        textSnippet: 'Start free trial',
        htmlSnippet: '<button class="primary">Start free trial</button>',
        attributes: { class: 'primary', type: 'button' },
        accessibility: {
          role: 'button',
          accessibleName: 'Start free trial',
          ariaLabel: null,
          ariaLabelledBy: null,
        },
        rectViewport: { x: 400, y: 300, width: 148, height: 44 },
        rectPage: { x: 400, y: 300, width: 148, height: 44 },
        computedStyles: {
          display: 'inline-flex',
          position: 'relative',
          width: '148px',
          height: '44px',
          margin: '0px',
          padding: '12px 24px',
          color: 'rgb(255, 255, 255)',
          backgroundColor: 'rgb(99, 102, 241)',
          border: '0px none',
          borderRadius: '8px',
          fontFamily: 'Geist, sans-serif',
          fontSize: '16px',
          fontWeight: '600',
          lineHeight: '20px',
          textAlign: 'center',
          zIndex: 'auto',
        },
      },
      nearbyText: ['Pro'],
      ancestorPath: ['section', 'main'],
      screenshot: null,
    },
    ...overrides,
  }
}

describe('browser annotation store', () => {
  it('rejects notes without a non-empty comment', () => {
    const store = createBrowserAnnotationStore()
    expect(store.add(makeAnnotation('page-a', 'a1', { comment: '   ' }))).toBeNull()
    expect(store.list('page-a')).toEqual([])
  })

  it('persists multiple notes per instance and isolates instances', () => {
    const store = createBrowserAnnotationStore()
    store.add(makeAnnotation('page-a', 'a1'))
    store.add(makeAnnotation('page-a', 'a2', { comment: 'Second note', intent: 'fix' }))
    store.add(makeAnnotation('page-b', 'b1', { comment: 'Other instance' }))

    expect(store.list('page-a').map((item) => item.id)).toEqual(['a1', 'a2'])
    expect(store.list('page-b').map((item) => item.id)).toEqual(['b1'])
    expect(store.list('page-a')[1]?.intent).toBe('fix')
  })

  it('drops screenshots and caps comments at the store boundary', () => {
    const store = createBrowserAnnotationStore()
    const oversized = 'a'.repeat(GRAB_BUDGET.annotationCommentMaxLength + 12)
    store.add({
      ...makeAnnotation('page-a', 'a1', { comment: oversized }),
      payload: {
        ...makeAnnotation('page-a', 'a1').payload,
        screenshot: {
          mimeType: 'image/png',
          dataUrl: 'data:image/png;base64,abc',
          width: 1,
          height: 1,
        },
      } as unknown as BrowserPageAnnotation['payload'],
    })

    const stored = store.list('page-a')[0]
    expect(stored?.comment).toHaveLength(GRAB_BUDGET.annotationCommentMaxLength)
    expect(stored?.payload.screenshot).toBeNull()
  })

  it('caps stored annotations per instance to the newest notes', () => {
    const store = createBrowserAnnotationStore()
    for (let index = 0; index < GRAB_BUDGET.annotationsMaxPerPage + 3; index += 1) {
      store.add(makeAnnotation('page-a', `annotation-${index}`, { comment: `Note ${index}` }))
    }
    const annotations = store.list('page-a')
    expect(annotations).toHaveLength(GRAB_BUDGET.annotationsMaxPerPage)
    expect(annotations[0]?.id).toBe('annotation-3')
    expect(annotations.at(-1)?.id).toBe(`annotation-${GRAB_BUDGET.annotationsMaxPerPage + 2}`)
  })

  it('deletes an individual note and clears all notes for an instance', () => {
    const store = createBrowserAnnotationStore()
    store.add(makeAnnotation('page-a', 'a1'))
    store.add(makeAnnotation('page-a', 'a2', { comment: 'Keep me' }))
    store.add(makeAnnotation('page-b', 'b1', { comment: 'Other' }))

    expect(store.delete('page-a', 'a1')).toBe(true)
    expect(store.list('page-a').map((item) => item.id)).toEqual(['a2'])
    store.clear('page-a')
    expect(store.list('page-a')).toEqual([])
    expect(store.list('page-b')).toHaveLength(1)
  })
})
