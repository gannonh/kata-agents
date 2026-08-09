import { describe, expect, test } from 'bun:test'
import {
  PENDING_NOTES_TEMPLATE,
  hasPendingEntries,
  mergeNotesSections,
  parseNotesSections,
  promoteReleaseNotes,
} from '../promote-release-notes'

const PENDING = `# Pending Release Notes

This file accumulates release notes for the next unreleased version.

## Features

- **Shiny thing** — does something visible ([#33](https://example.test/33)).

## Improvements

## Bug Fixes

- **Crash fix** — no longer crashes.

## Breaking Changes
`

describe('parseNotesSections', () => {
  test('drops the title and prose, keeping sections in order', () => {
    const sections = parseNotesSections(PENDING)
    expect(sections.map((s) => s.title)).toEqual([
      'Features',
      'Improvements',
      'Bug Fixes',
      'Breaking Changes',
    ])
    expect(sections[0].lines).toEqual(['- **Shiny thing** — does something visible ([#33](https://example.test/33)).'])
    expect(sections[1].lines).toEqual([])
  })
})

describe('hasPendingEntries', () => {
  test('true when any section carries a bullet', () => {
    expect(hasPendingEntries(PENDING)).toBe(true)
  })

  test('false for the empty template', () => {
    expect(hasPendingEntries(PENDING_NOTES_TEMPLATE)).toBe(false)
  })

  test('false when sections hold only prose-free whitespace', () => {
    expect(hasPendingEntries('# Pending\n\n## Features\n\n \n\n## Bug Fixes\n')).toBe(false)
  })
})

describe('promoteReleaseNotes', () => {
  test('writes a bare version header keyed to the stable core', () => {
    const result = promoteReleaseNotes(PENDING, '0.10.11-nightly.20260622.40')
    expect(result?.version).toBe('0.10.11')
    expect(result?.filename).toBe('0.10.11.md')
    expect(result?.content.startsWith('# v0.10.11\n')).toBe(true)
  })

  // A nightly of 0.10.11 and the stable 0.10.11 must produce the same filename
  // and version string, so the What's New overlay does not re-prompt users who
  // already saw the notes on nightly.
  test('nightly and stable of the same core agree', () => {
    const nightly = promoteReleaseNotes(PENDING, '0.10.11-nightly.20260622.40')
    const stable = promoteReleaseNotes(PENDING, '0.10.11')
    expect(nightly).toEqual(stable)
  })

  test('preserves every section, including empty ones', () => {
    const content = promoteReleaseNotes(PENDING, '0.10.11')?.content ?? ''
    expect(content).toContain('## Features')
    expect(content).toContain('## Improvements')
    expect(content).toContain('## Bug Fixes')
    expect(content).toContain('## Breaking Changes')
    expect(content).toContain('- **Crash fix** — no longer crashes.')
  })

  test('returns undefined when there is nothing to promote', () => {
    expect(promoteReleaseNotes(PENDING_NOTES_TEMPLATE, '0.10.11')).toBeUndefined()
  })

  test('rejects a version with no X.Y.Z core', () => {
    expect(() => promoteReleaseNotes(PENDING, 'nightly')).toThrow()
  })

  test('is idempotent when re-promoted over its own output', () => {
    const first = promoteReleaseNotes(PENDING, '0.10.11')?.content ?? ''
    const second = promoteReleaseNotes(PENDING, '0.10.11', first)?.content ?? ''
    expect(second).toBe(first)
  })

  test('merges new pending bullets into an already promoted file', () => {
    const existing = '# v0.10.11 — Hand written summary\n\n## Features\n\n- **Older thing** — shipped earlier.\n'
    const merged = promoteReleaseNotes(PENDING, '0.10.11', existing)?.content ?? ''
    // A hand-written summary survives promotion.
    expect(merged.startsWith('# v0.10.11 — Hand written summary\n')).toBe(true)
    expect(merged).toContain('- **Older thing** — shipped earlier.')
    expect(merged).toContain('- **Shiny thing**')
    // Sections only present in the pending file are appended.
    expect(merged).toContain('- **Crash fix** — no longer crashes.')
  })
})

describe('mergeNotesSections', () => {
  test('appends unseen bullets and drops exact duplicates', () => {
    const merged = mergeNotesSections(
      [{ title: 'Features', lines: ['- a', '- b'] }],
      [{ title: 'Features', lines: ['- b', '- c'] }],
    )
    expect(merged).toHaveLength(1)
    expect(merged[0].lines.filter((line) => line.trim())).toEqual(['- a', '- b', '- c'])
  })

  test('keeps existing section order and appends new sections last', () => {
    const merged = mergeNotesSections(
      [{ title: 'Features', lines: ['- a'] }],
      [{ title: 'Bug Fixes', lines: ['- z'] }],
    )
    expect(merged.map((s) => s.title)).toEqual(['Features', 'Bug Fixes'])
  })
})

describe('PENDING_NOTES_TEMPLATE', () => {
  test('carries the canonical empty sections', () => {
    expect(parseNotesSections(PENDING_NOTES_TEMPLATE).map((s) => s.title)).toEqual([
      'Features',
      'Improvements',
      'Bug Fixes',
      'Breaking Changes',
    ])
  })
})
