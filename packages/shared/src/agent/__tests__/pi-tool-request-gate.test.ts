import { describe, expect, it } from 'bun:test'
import { PiToolRequestGate } from '../pi-tool-request-gate.ts'

describe('PiToolRequestGate', () => {
  it('accepts one credential-bound sequence and rejects replay, gaps, and other credentials', () => {
    const gate = new PiToolRequestGate()
    gate.activate('runtime-secret')

    expect(gate.accept('runtime-secret', 1)).toBe(true)
    expect(gate.accept('runtime-secret', 1)).toBe(false)
    expect(gate.accept('runtime-secret', 3)).toBe(false)
    expect(gate.accept('other-secret', 2)).toBe(false)
    expect(gate.accept('runtime-secret', 2)).toBe(true)
  })

  it('rejects revoked credentials and restarts the sequence for a new subprocess', () => {
    const gate = new PiToolRequestGate()
    gate.activate('first-secret')
    expect(gate.accept('first-secret', 1)).toBe(true)

    gate.revoke()
    expect(gate.accept('first-secret', 2)).toBe(false)

    gate.activate('second-secret')
    expect(gate.accept('first-secret', 1)).toBe(false)
    expect(gate.accept('second-secret', 1)).toBe(true)
  })
})
