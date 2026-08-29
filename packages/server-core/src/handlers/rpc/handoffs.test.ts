import { describe, expect, it } from 'bun:test'
import { HandoffWaitRegistry } from './handoffs'

describe('HandoffWaitRegistry', () => {
  it('replaces only the matching client wait and preserves the successor', () => {
    const waits = new HandoffWaitRegistry()
    const first = waits.begin('client-a', 'wait-1')
    const otherClient = waits.begin('client-b', 'wait-1')
    const successor = waits.begin('client-a', 'wait-1')

    expect(first.signal.aborted).toBe(true)
    expect(successor.signal.aborted).toBe(false)
    expect(otherClient.signal.aborted).toBe(false)

    waits.finish('client-a', 'wait-1', first)
    expect(waits.cancelWait('client-a', 'wait-1')).toBe(true)
    expect(successor.signal.aborted).toBe(true)
    expect(otherClient.signal.aborted).toBe(false)
  })

  it('cancels every wait owned by a disconnected client', () => {
    const waits = new HandoffWaitRegistry()
    const first = waits.begin('client-a', 'wait-1')
    const second = waits.begin('client-a', 'wait-2')
    const otherClient = waits.begin('client-b', 'wait-1')

    waits.cancelClient('client-a')

    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(true)
    expect(otherClient.signal.aborted).toBe(false)
    expect(waits.cancelWait('client-a', 'wait-1')).toBe(false)
  })
})
