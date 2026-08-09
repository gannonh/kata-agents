import { describe, expect, test } from 'bun:test'
import { shouldAcquireSingleInstanceLock } from '../single-instance-policy'

describe('shouldAcquireSingleInstanceLock', () => {
  test('source development runtime does not acquire the lock', () => {
    expect(shouldAcquireSingleInstanceLock(false, false)).toBe(false)
  })

  test('packaged development runtime does not acquire the lock', () => {
    expect(shouldAcquireSingleInstanceLock(true, true)).toBe(false)
  })

  test('ordinary packaged runtime acquires the lock', () => {
    expect(shouldAcquireSingleInstanceLock(true, false)).toBe(true)
  })
})
