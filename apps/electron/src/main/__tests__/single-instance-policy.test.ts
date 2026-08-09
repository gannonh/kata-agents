import { describe, expect, test } from 'bun:test'
import { findDeepLinkArg, shouldAcquireSingleInstanceLock } from '../single-instance-policy'

describe('shouldAcquireSingleInstanceLock', () => {
  test('source development runtime does not acquire the lock', () => {
    expect(shouldAcquireSingleInstanceLock(false, false)).toBe(false)
  })

  test('source runtime with KATA_DEV_RUNTIME enabled does not acquire the lock', () => {
    expect(shouldAcquireSingleInstanceLock(false, true)).toBe(false)
  })

  test('packaged development runtime acquires its isolated lock', () => {
    expect(shouldAcquireSingleInstanceLock(true, true)).toBe(true)
  })

  test('ordinary packaged runtime acquires the lock', () => {
    expect(shouldAcquireSingleInstanceLock(true, false)).toBe(true)
  })

  test('finds a matching deep link in startup arguments', () => {
    expect(findDeepLinkArg(['--no-sandbox', 'kataagents://action/new-session'], 'kataagents'))
      .toBe('kataagents://action/new-session')
    expect(findDeepLinkArg(['kataagents1://action/new-session'], 'kataagents')).toBeUndefined()
  })
})
