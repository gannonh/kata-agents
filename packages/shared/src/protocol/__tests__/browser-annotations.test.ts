import { describe, expect, it } from 'bun:test'
import {
  GRAB_BUDGET,
  GRAB_SAFE_ATTRIBUTE_NAMES,
  GRAB_SECRET_PATTERNS,
  GRAB_STYLE_PROPERTIES,
  isAriaAttribute,
  isBrowserAnnotationIntent,
  normalizeAnnotationComment,
} from '../browser-annotations'

describe('browser annotation contracts', () => {
  it('bounds annotation comments and rejects empty ones', () => {
    expect(normalizeAnnotationComment('   ')).toBeNull()
    expect(normalizeAnnotationComment('\n\t')).toBeNull()
    expect(normalizeAnnotationComment('  Make the CTA clearer.  ')).toBe('Make the CTA clearer.')
    const oversized = `x${'y'.repeat(GRAB_BUDGET.annotationCommentMaxLength)}`
    expect(normalizeAnnotationComment(oversized)).toHaveLength(GRAB_BUDGET.annotationCommentMaxLength)
  })

  it('accepts only the documented intents', () => {
    expect(isBrowserAnnotationIntent('change')).toBe(true)
    expect(isBrowserAnnotationIntent('fix')).toBe(true)
    expect(isBrowserAnnotationIntent('question')).toBe(true)
    expect(isBrowserAnnotationIntent('approve')).toBe(true)
    expect(isBrowserAnnotationIntent('bug')).toBe(false)
    expect(isBrowserAnnotationIntent('')).toBe(false)
  })

  it('keeps secret patterns precise enough not to match ordinary CSS', () => {
    expect(GRAB_SECRET_PATTERNS).toContain('password')
    expect(GRAB_SECRET_PATTERNS).toContain('access_token')
    expect(GRAB_SECRET_PATTERNS).not.toContain('code')
    expect(GRAB_SECRET_PATTERNS).not.toContain('state')
    expect(GRAB_SECRET_PATTERNS).not.toContain('token')
  })

  it('allowlists safe attributes and aria-* names', () => {
    expect(GRAB_SAFE_ATTRIBUTE_NAMES.has('id')).toBe(true)
    expect(GRAB_SAFE_ATTRIBUTE_NAMES.has('onclick')).toBe(false)
    expect(isAriaAttribute('aria-label')).toBe(true)
    expect(isAriaAttribute('class')).toBe(false)
  })

  it('curates computed styles used in review notes', () => {
    expect(GRAB_STYLE_PROPERTIES).toContain('fontSize')
    expect(GRAB_STYLE_PROPERTIES).toContain('backgroundColor')
    expect(GRAB_BUDGET.annotationsMaxPerPage).toBe(20)
    expect(GRAB_BUDGET.htmlSnippetMaxLength).toBe(4096)
    expect(GRAB_BUDGET.attributesMaxCount).toBe(32)
  })
})
