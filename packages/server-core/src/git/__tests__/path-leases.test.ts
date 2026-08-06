import { describe, test, expect, afterEach } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PathLeaseManager } from '../path-leases'
import { cleanup, makeTmpDir } from './test-helpers'

const cleanups: string[] = []
function tmp(): string {
  const dir = makeTmpDir('kata-path-lease-test-')
  cleanups.push(dir)
  return dir
}
afterEach(() => {
  while (cleanups.length) cleanup(cleanups.pop()!)
})

describe('PathLeaseManager', () => {
  test('leases and releases canonical checkout paths per session', () => {
    const root = tmp()
    const leases = new PathLeaseManager(join(root, 'locks'))
    const checkout = join(root, 'worktrees', 'ws', 'repo', 'token')

    leases.lease('session-1', checkout)
    expect(leases.leasedBy(checkout)).toEqual(['session-1'])
    // A different spelling of the same path resolves to the same lease.
    expect(leases.leasedBy(join(root, 'worktrees', 'ws', 'repo', 'token'))).toEqual([
      'session-1',
    ])

    leases.release('session-1', checkout)
    expect(leases.leasedBy(checkout)).toEqual([])
  })

  test('shared owners both lease one path; a lifecycle actor sees the foreign lease', () => {
    const root = tmp()
    const leases = new PathLeaseManager(join(root, 'locks'))
    const checkout = join(root, 'worktrees', 'ws', 'repo', 'token')

    leases.lease('session-1', checkout)
    leases.lease('session-2', checkout)

    expect(new Set(leases.leasedBy(checkout))).toEqual(new Set(['session-1', 'session-2']))
    expect(leases.hasForeignLease(checkout, new Set(['session-1']))).toBe(true)
    expect(leases.hasForeignLease(checkout, new Set(['session-1', 'session-2']))).toBe(false)
  })

  test('leasing a second path replaces the session previous lease', () => {
    const root = tmp()
    const leases = new PathLeaseManager(join(root, 'locks'))
    const first = join(root, 'first')
    const second = join(root, 'second')

    leases.lease('session-1', first)
    leases.lease('session-1', second)

    expect(leases.leasedBy(first)).toEqual([])
    expect(leases.leasedBy(second)).toEqual(['session-1'])
    expect(leases.leasesForSession('session-1')).toEqual([second])
  })

  test('a second manager instance observes leases written by the first (cross-process)', () => {
    const root = tmp()
    const lockRoot = join(root, 'locks')
    const checkout = join(root, 'worktrees', 'ws', 'repo', 'token')
    const first = new PathLeaseManager(lockRoot)
    const second = new PathLeaseManager(lockRoot)

    first.lease('session-1', checkout)
    expect(second.leasedBy(checkout)).toEqual(['session-1'])

    first.release('session-1', checkout)
    expect(second.leasedBy(checkout)).toEqual([])
  })

  test('releases every lease when a session disappears', () => {
    const root = tmp()
    const leases = new PathLeaseManager(join(root, 'locks'))
    const checkout = join(root, 'worktrees', 'ws', 'repo', 'token')

    leases.lease('session-1', checkout)
    leases.releaseSession('session-1')
    expect(leases.leasedBy(checkout)).toEqual([])
    // Releasing again is a no-op.
    leases.releaseSession('session-1')
  })

  test('ignores foreign marker files that are not lease markers', () => {
    const root = tmp()
    const lockRoot = join(root, 'locks')
    const leases = new PathLeaseManager(lockRoot)
    const checkout = join(root, 'worktrees', 'ws', 'repo', 'token')

    writeFileSync(join(lockRoot, 'unrelated.json'), '{}', 'utf8')
    expect(leases.leasedBy(checkout)).toEqual([])
  })
})
