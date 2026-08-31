import { describe, expect, it } from 'bun:test'
import { isPotentiallyCatastrophicRegex, regexTestBounded } from './regex-safety.ts'

describe('regex-safety', () => {
  it('classifies nested quantifiers as catastrophic', () => {
    expect(isPotentiallyCatastrophicRegex('(a+)+$')).toBe(true)
    expect(isPotentiallyCatastrophicRegex('^done$')).toBe(false)
    expect(isPotentiallyCatastrophicRegex('foo.*bar')).toBe(false)
  })

  it('interrupts unbounded regex evaluation', () => {
    const started = Date.now()
    expect(regexTestBounded('(a+)+$', `${'a'.repeat(24)}b`)).toBe(false)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(regexTestBounded('^done$', 'done')).toBe(true)
    expect(regexTestBounded('foo.*bar', 'fooXbar')).toBe(true)
    expect(regexTestBounded('(', 'x')).toBe(false)
  })
})
