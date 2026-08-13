import { describe, expect, it } from 'bun:test'
import { GitStatusSubscription, statusSignature } from '../status-subscription'
import type { GitStatusChangedEvent, GitStatusSnapshot } from '@kata-sh/shared/protocol'

function makeSnapshot(overrides: Partial<GitStatusSnapshot> = {}): GitStatusSnapshot {
  return {
    repositoryRoot: '/repo',
    checkoutPath: '/repo',
    isGitRepository: true,
    currentBranch: 'main',
    detached: false,
    defaultRef: 'main',
    baseRef: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    publishableCommitCount: 0,
    baseDeltaCount: 0,
    primaryRemote: null,
    provider: 'unknown',
    entries: [],
    operationInProgress: null,
    blockedReason: null,
    ...overrides,
  }
}

interface Harness {
  sub: GitStatusSubscription
  events: Array<{ event: GitStatusChangedEvent; workspaceId: string }>
  timers: Array<{ fn: () => void; ms: number; cancelled: boolean }>
  setStatus: (dir: string, s: GitStatusSnapshot) => void
  statusCalls: () => string[]
  fireTimers: () => Promise<void>
}

function makeHarness(sessions: Record<string, { checkoutPath: string; workspaceId: string }>): Harness {
  const statuses = new Map<string, GitStatusSnapshot>()
  const calls: string[] = []
  const events: Harness['events'] = []
  const timers: Harness['timers'] = []

  const sub = new GitStatusSubscription({
    getStatus: async (dir) => {
      calls.push(dir)
      return statuses.get(dir) ?? makeSnapshot({ checkoutPath: dir })
    },
    resolveSession: async (sessionId) => sessions[sessionId] ?? null,
    publish: (event, workspaceId) => events.push({ event, workspaceId }),
    pollIntervalMs: 3000,
    timerFactory: (fn, ms) => {
      const t = { fn, ms, cancelled: false }
      timers.push(t)
      return () => {
        t.cancelled = true
      }
    },
  })

  return {
    sub,
    events,
    timers,
    setStatus: (dir, s) => statuses.set(dir, s),
    statusCalls: () => calls,
    fireTimers: async () => {
      for (const t of timers) {
        if (!t.cancelled) t.fn()
      }
      // let the async poll settle
      await new Promise((r) => setTimeout(r, 0))
    },
  }
}

describe('GitStatusSubscription', () => {
  it('polls at an interval no longer than 3s', () => {
    const h = makeHarness({ s1: { checkoutPath: '/repo', workspaceId: 'ws1' } })
    return h.sub.subscribe('c1', 's1').then(() => {
      expect(h.timers).toHaveLength(1)
      expect(h.timers[0]!.ms).toBeLessThanOrEqual(3000)
    })
  })

  it('coalesces two sessions on the same checkout into one poll loop', async () => {
    const h = makeHarness({
      s1: { checkoutPath: '/repo', workspaceId: 'ws1' },
      s2: { checkoutPath: '/repo', workspaceId: 'ws1' },
    })
    await h.sub.subscribe('c1', 's1')
    await h.sub.subscribe('c2', 's2')
    expect(h.sub.activeCheckoutCount).toBe(1)
    expect(h.timers.filter((t) => !t.cancelled)).toHaveLength(1)
  })

  it('publishes a workspace-routed change event per subscribed session when status changes', async () => {
    const h = makeHarness({
      s1: { checkoutPath: '/repo', workspaceId: 'ws1' },
      s2: { checkoutPath: '/repo', workspaceId: 'ws2' },
    })
    await h.sub.subscribe('c1', 's1')
    await h.sub.subscribe('c2', 's2')

    // Change the status, then fire the interval poll.
    h.setStatus('/repo', makeSnapshot({ additions: 5 }))
    await h.fireTimers()

    expect(h.events.length).toBe(2)
    const bySession = new Map(h.events.map((e) => [e.event.sessionId, e]))
    expect(bySession.get('s1')!.workspaceId).toBe('ws1')
    expect(bySession.get('s2')!.workspaceId).toBe('ws2')
    expect(bySession.get('s1')!.event.status.additions).toBe(5)
    expect(bySession.get('s1')!.event.reason).toBe('external')
  })

  it('does not publish when the status signature is unchanged', async () => {
    const h = makeHarness({ s1: { checkoutPath: '/repo', workspaceId: 'ws1' } })
    await h.sub.subscribe('c1', 's1')
    await h.fireTimers()
    expect(h.events).toHaveLength(0)
  })

  it('refreshes immediately with an app-action reason', async () => {
    const h = makeHarness({ s1: { checkoutPath: '/repo', workspaceId: 'ws1' } })
    await h.sub.subscribe('c1', 's1')
    h.setStatus('/repo', makeSnapshot({ additions: 9 }))
    await h.sub.refresh('s1')
    expect(h.events).toHaveLength(1)
    expect(h.events[0]!.event.reason).toBe('app-action')
    expect(h.events[0]!.event.status.additions).toBe(9)
  })

  it('stops polling when the last subscriber unsubscribes', async () => {
    const h = makeHarness({ s1: { checkoutPath: '/repo', workspaceId: 'ws1' } })
    await h.sub.subscribe('c1', 's1')
    h.sub.unsubscribe('c1', 's1')
    expect(h.sub.activeCheckoutCount).toBe(0)
    expect(h.timers[0]!.cancelled).toBe(true)
  })

  it('unsubscribeClient removes every subscription for a client', async () => {
    const h = makeHarness({
      s1: { checkoutPath: '/a', workspaceId: 'ws1' },
      s2: { checkoutPath: '/b', workspaceId: 'ws1' },
    })
    await h.sub.subscribe('c1', 's1')
    await h.sub.subscribe('c1', 's2')
    expect(h.sub.activeCheckoutCount).toBe(2)
    h.sub.unsubscribeClient('c1')
    expect(h.sub.activeCheckoutCount).toBe(0)
  })

  it('keeps polling a shared checkout until all clients unsubscribe', async () => {
    const h = makeHarness({
      s1: { checkoutPath: '/repo', workspaceId: 'ws1' },
      s2: { checkoutPath: '/repo', workspaceId: 'ws1' },
    })
    await h.sub.subscribe('c1', 's1')
    await h.sub.subscribe('c2', 's2')
    h.sub.unsubscribe('c1', 's1')
    expect(h.sub.activeCheckoutCount).toBe(1)
    h.sub.unsubscribe('c2', 's2')
    expect(h.sub.activeCheckoutCount).toBe(0)
  })
})

describe('statusSignature', () => {
  it('changes when entries change', () => {
    const a = statusSignature(makeSnapshot())
    const b = statusSignature(makeSnapshot({ entries: [{ path: 'x', type: 'modified' }] }))
    expect(a).not.toBe(b)
  })

  it('is stable for equivalent snapshots', () => {
    expect(statusSignature(makeSnapshot())).toBe(statusSignature(makeSnapshot()))
  })
})
