import { describe, test, expect } from 'bun:test'
import { MutationLock } from '../mutation-lock'

describe('MutationLock', () => {
  test('serializes operations for the same common directory', async () => {
    const lock = new MutationLock()
    const order: string[] = []
    const op = (id: string, ms: number) =>
      lock.withLock('/repo/.git', async () => {
        order.push(`start-${id}`)
        await new Promise((r) => setTimeout(r, ms))
        order.push(`end-${id}`)
      })
    await Promise.all([op('a', 30), op('b', 5), op('c', 5)])
    // Each op fully completes before the next starts.
    expect(order).toEqual(['start-a', 'end-a', 'start-b', 'end-b', 'start-c', 'end-c'])
  })

  test('runs operations for different common directories concurrently', async () => {
    const lock = new MutationLock()
    const order: string[] = []
    const op = (dir: string, id: string, ms: number) =>
      lock.withLock(dir, async () => {
        order.push(`start-${id}`)
        await new Promise((r) => setTimeout(r, ms))
        order.push(`end-${id}`)
      })
    await Promise.all([op('/repo1/.git', 'a', 20), op('/repo2/.git', 'b', 5)])
    // b (different dir) starts before a finishes.
    expect(order.indexOf('start-b')).toBeLessThan(order.indexOf('end-a'))
  })

  test('a failing operation does not poison the queue', async () => {
    const lock = new MutationLock()
    await expect(
      lock.withLock('/repo/.git', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    const result = await lock.withLock('/repo/.git', async () => 'ok')
    expect(result).toBe('ok')
  })
})
