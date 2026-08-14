import { describe, expect, it } from 'bun:test'
import { clampGrabPayload } from '../grab-payload'

function makeRawPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    page: {
      sanitizedUrl: 'https://example.com/page?access_token=secret#hash',
      title: 'Example',
      viewportWidth: 1280,
      viewportHeight: 720,
      scrollX: 0,
      scrollY: 0,
      devicePixelRatio: 1,
      capturedAt: '2026-05-15T00:00:00.000Z',
    },
    target: {
      tagName: 'button',
      selector: 'button.primary',
      elementPath: 'main > button.primary',
      fullPath: 'html > body > main > button.primary',
      cssClasses: 'primary',
      nearbyElements: ['span "Label"'],
      selectedText: '',
      isFixed: false,
      reactComponents: '<App> <Button>',
      sourceFile: 'src/Button.tsx:12:4',
      textSnippet: 'Submit',
      htmlSnippet: '<button class="primary">Submit</button>',
      attributes: { class: 'primary', type: 'button' },
      accessibility: {
        role: 'button',
        accessibleName: 'Submit',
        ariaLabel: null,
        ariaLabelledBy: null,
      },
      rectViewport: { x: 10, y: 20, width: 100, height: 40 },
      rectPage: { x: 10, y: 20, width: 100, height: 40 },
      computedStyles: {
        display: 'inline-flex',
        position: 'static',
        width: '100px',
        height: '40px',
        margin: '0px',
        padding: '8px',
        color: 'rgb(0, 0, 0)',
        backgroundColor: 'rgba(0, 0, 0, 0)',
        border: '0px none',
        borderRadius: '0px',
        fontFamily: 'Geist',
        fontSize: '14px',
        fontWeight: '400',
        lineHeight: '20px',
        textAlign: 'center',
        zIndex: 'auto',
      },
    },
    nearbyText: ['Submit'],
    ancestorPath: ['button', 'main'],
    screenshot: { dataUrl: 'data:image/png;base64,abc' },
    ...overrides,
  }
}

describe('clampGrabPayload', () => {
  it('returns null for structurally invalid payloads', () => {
    expect(clampGrabPayload(null)).toBeNull()
    expect(clampGrabPayload({ page: {} })).toBeNull()
    expect(clampGrabPayload({ target: {} })).toBeNull()
  })

  it('strips query strings, screenshots, and secret-bearing fields', () => {
    const payload = clampGrabPayload(
      makeRawPayload({
        target: {
          ...(makeRawPayload().target as Record<string, unknown>),
          cssClasses: 'primary access_token=secret',
          attributes: {
            class: 'primary',
            onclick: 'alert(1)',
            href: 'https://example.com/login?password=secret',
          },
        },
      }),
    )

    expect(payload?.page.sanitizedUrl).toBe('https://example.com/page')
    expect(payload?.screenshot).toBeNull()
    expect(payload?.target.cssClasses).toBe('[redacted]')
    expect(payload?.target.attributes.onclick).toBeUndefined()
    expect(payload?.target.attributes.href).toBe('[redacted]')
  })

  it('redacts secret-bearing annotation metadata fields', () => {
    const payload = clampGrabPayload(
      makeRawPayload({
        target: {
          ...(makeRawPayload().target as Record<string, unknown>),
          elementPath: 'main > button[aria-label="access_token=secret"]',
          fullPath: 'body > main > button#client_secret',
          reactComponents: '<App> <PasswordSecretPanel>',
          sourceFile: 'src/client_secret/Button.tsx:12:4',
          nearbyElements: ['span "api_key=secret"'],
          selectedText: 'password=secret',
          accessibility: {
            role: 'button',
            accessibleName: 'access_token=secret',
            ariaLabel: 'access_token=secret',
            ariaLabelledBy: null,
          },
        },
      }),
    )

    expect(payload?.target.elementPath).toBe('[redacted]')
    expect(payload?.target.fullPath).toBe('[redacted]')
    expect(payload?.target.reactComponents).toBe('[redacted]')
    expect(payload?.target.sourceFile).toBe('[redacted]')
    expect(payload?.target.nearbyElements).toEqual(['[redacted]'])
    expect(payload?.target.selectedText).toBe('[redacted]')
    expect(payload?.target.accessibility.accessibleName).toBe('[redacted]')
    expect(payload?.target.accessibility.ariaLabel).toBe('[redacted]')
  })

  it('redacts password HTML and secret-bearing text snippets', () => {
    const payload = clampGrabPayload(
      makeRawPayload({
        page: {
          ...(makeRawPayload().page as Record<string, unknown>),
          title: 'Login password=hunter2',
        },
        target: {
          ...(makeRawPayload().target as Record<string, unknown>),
          textSnippet: 'password=hunter2',
          htmlSnippet: '<input type="password" value="hunter2">',
        },
        nearbyText: ['welcome', 'api_key=secret'],
      }),
    )
    expect(payload?.page.title).toBe('[redacted]')
    expect(payload?.target.textSnippet).toBe('[redacted]')
    expect(payload?.target.htmlSnippet).toBe('[redacted]')
    expect(payload?.nearbyText).toEqual(['welcome', '[redacted]'])
  })

  it('caps the number of retained attributes at the grab budget', () => {
    const attributes: Record<string, string> = { class: 'primary', type: 'button' }
    for (let index = 0; index < 80; index += 1) {
      attributes[`aria-extra-${index}`] = `value-${index}`
    }
    const payload = clampGrabPayload(
      makeRawPayload({
        target: {
          ...(makeRawPayload().target as Record<string, unknown>),
          attributes,
        },
      }),
    )
    expect(Object.keys(payload?.target.attributes ?? {}).length).toBe(32)
  })

  it('drops executable URL schemes', () => {
    const payload = clampGrabPayload(
      makeRawPayload({
        page: {
          ...(makeRawPayload().page as Record<string, unknown>),
          sanitizedUrl: 'javascript:alert(1)',
        },
      }),
    )
    expect(payload?.page.sanitizedUrl).toBe('')
  })
})
