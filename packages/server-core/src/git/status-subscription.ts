/**
 * GitStatusSubscription — coalesced, workspace-routed Git status polling.
 *
 * Responsibilities (spec: GitStatusSubscription):
 * - Coalesce status work by checkout path so linked worktrees / shared
 *   checkouts poll once regardless of how many surfaces subscribe.
 * - Poll at an interval no longer than three seconds while at least one Git
 *   surface is subscribed, so external Git changes render within the
 *   five-second acceptance bound.
 * - Refresh immediately after app Git actions and agent turn completion.
 * - Publish workspace-routed status-change events carrying the session ID so
 *   multi-panel clients bind the event to the focused session panel.
 *
 * The class is transport-agnostic: it takes injected `getStatus`,
 * `resolveSession`, and `publish` callbacks plus an optional timer factory, so
 * it can be unit-tested with a manual clock.
 */

import type {
  GitStatusChangeReason,
  GitStatusChangedEvent,
  GitStatusSnapshot,
} from '@kata-sh/shared/protocol'

/** Cancel handle returned by the timer factory. */
export type CancelTimer = () => void

export type TimerFactory = (fn: () => void, ms: number) => CancelTimer

export interface GitStatusSubscriptionDeps {
  /** Read a status snapshot for a checkout directory. */
  getStatus: (dir: string, options?: { baseRef?: string | null }) => Promise<GitStatusSnapshot>
  /** Resolve a session ID to its active checkout path + owning workspace. */
  resolveSession: (
    sessionId: string,
  ) => Promise<{ checkoutPath: string; workspaceId: string; baseRef?: string | null } | null>
  /** Publish a workspace-routed status-change event. */
  publish: (event: GitStatusChangedEvent, workspaceId: string) => void
  /** Poll interval; must be ≤ 3000ms per the acceptance bound. Default 3000. */
  pollIntervalMs?: number
  /** Injectable timer for tests. Defaults to setInterval/clearInterval. */
  timerFactory?: TimerFactory
}

interface CheckoutState {
  checkoutPath: string
  /** Managed worktree base ref for PR-delta counting, if known for this checkout. */
  baseRef: string | null
  /** clientId → set of session IDs subscribed by that client on this checkout. */
  subscribers: Map<string, Set<string>>
  /** sessionId → owning workspace, used to route change events. */
  sessionWorkspace: Map<string, string>
  lastSignature: string | null
  cancelTimer: CancelTimer | null
  polling: boolean
  pendingReason: GitStatusChangeReason | null
}

const DEFAULT_POLL_INTERVAL_MS = 3000

function defaultTimerFactory(fn: () => void, ms: number): CancelTimer {
  const id = setInterval(fn, ms)
  return () => clearInterval(id)
}

/** Stable signature over the status fields the Changes surface renders. */
export function statusSignature(s: GitStatusSnapshot): string {
  return JSON.stringify({
    r: s.isGitRepository,
    b: s.currentBranch,
    d: s.detached,
    u: s.upstream,
    a: s.ahead,
    be: s.behind,
    // Publish-state fields drive the header action resolver, so a change in any
    // of them must emit a status event even when the file list is unchanged
    // (e.g. after a push clears the publishable/ahead counts).
    pc: s.publishableCommitCount,
    bd: s.baseDeltaCount,
    def: s.defaultRef,
    baseR: s.baseRef,
    rem: s.primaryRemote,
    prov: s.provider,
    add: s.additions ?? null,
    del: s.deletions ?? null,
    op: s.operationInProgress,
    blk: s.blockedReason,
    e: s.entries.map((e) => [
      e.path,
      e.previousPath ?? '',
      e.type,
      e.indexState ?? '',
      e.worktreeState ?? '',
      e.additions ?? -1,
      e.deletions ?? -1,
      e.binary ? 1 : 0,
      e.conflicted ? 1 : 0,
    ]),
  })
}

export class GitStatusSubscription {
  private readonly checkouts = new Map<string, CheckoutState>()
  private readonly sessionToCheckout = new Map<string, string>()
  private readonly getStatus: GitStatusSubscriptionDeps['getStatus']
  private readonly resolveSession: GitStatusSubscriptionDeps['resolveSession']
  private readonly publish: GitStatusSubscriptionDeps['publish']
  private readonly pollIntervalMs: number
  private readonly timerFactory: TimerFactory

  constructor(deps: GitStatusSubscriptionDeps) {
    this.getStatus = deps.getStatus
    this.resolveSession = deps.resolveSession
    this.publish = deps.publish
    this.pollIntervalMs = Math.min(deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS)
    this.timerFactory = deps.timerFactory ?? defaultTimerFactory
  }

  /**
   * Subscribe a client's Git surface to a session's checkout. Returns the
   * current snapshot; starts coalesced polling if this is the first subscriber
   * on the checkout.
   */
  async subscribe(clientId: string, sessionId: string): Promise<GitStatusSnapshot> {
    const resolved = await this.resolveSession(sessionId)
    if (!resolved) {
      throw new Error(`Cannot resolve checkout for session ${sessionId}.`)
    }
    const { checkoutPath, workspaceId } = resolved
    const baseRef = resolved.baseRef ?? null

    // If the session moved to a different checkout, drop the stale mapping first.
    const prev = this.sessionToCheckout.get(sessionId)
    if (prev && prev !== checkoutPath) {
      this.removeSession(clientId, sessionId)
    }

    let state = this.checkouts.get(checkoutPath)
    const isNew = !state
    if (!state) {
      state = {
        checkoutPath,
        baseRef,
        subscribers: new Map(),
        sessionWorkspace: new Map(),
        lastSignature: null,
        cancelTimer: null,
        polling: false,
        pendingReason: null,
      }
      this.checkouts.set(checkoutPath, state)
    }

    let set = state.subscribers.get(clientId)
    if (!set) {
      set = new Set()
      state.subscribers.set(clientId, set)
    }
    set.add(sessionId)
    state.sessionWorkspace.set(sessionId, workspaceId)
    this.sessionToCheckout.set(sessionId, checkoutPath)

    const status = await this.getStatus(checkoutPath, { baseRef: state.baseRef })
    state.lastSignature = statusSignature(status)
    if (isNew) this.startTimer(state)
    return status
  }

  /** Remove a single (client, session) subscription. */
  unsubscribe(clientId: string, sessionId: string): void {
    this.removeSession(clientId, sessionId)
  }

  /** Remove every subscription held by a client (e.g. on disconnect). */
  unsubscribeClient(clientId: string): void {
    for (const state of Array.from(this.checkouts.values())) {
      const set = state.subscribers.get(clientId)
      if (!set) continue
      for (const sessionId of Array.from(set)) {
        this.removeSession(clientId, sessionId)
      }
    }
  }

  /** Immediately re-poll the checkout for a session (app action / turn done). */
  async refresh(sessionId: string, reason: GitStatusChangeReason = 'app-action'): Promise<void> {
    const checkoutPath = this.sessionToCheckout.get(sessionId)
    if (!checkoutPath) return
    const state = this.checkouts.get(checkoutPath)
    if (state) await this.poll(state, reason)
  }

  /** Immediately re-poll a checkout by path (mutation serialized by common dir). */
  async refreshCheckout(
    checkoutPath: string,
    reason: GitStatusChangeReason = 'app-action',
  ): Promise<void> {
    const state = this.checkouts.get(checkoutPath)
    if (state) await this.poll(state, reason)
  }

  /** Number of distinct checkouts currently polled (for tests / observability). */
  get activeCheckoutCount(): number {
    return this.checkouts.size
  }

  /** True when the checkout for a session is currently subscribed. */
  isSubscribed(sessionId: string): boolean {
    return this.sessionToCheckout.has(sessionId)
  }

  /** Stop all polling and clear state. */
  dispose(): void {
    for (const state of this.checkouts.values()) {
      state.cancelTimer?.()
    }
    this.checkouts.clear()
    this.sessionToCheckout.clear()
  }

  private startTimer(state: CheckoutState): void {
    if (state.cancelTimer) return
    state.cancelTimer = this.timerFactory(() => {
      void this.poll(state, 'external')
    }, this.pollIntervalMs)
  }

  private removeSession(clientId: string, sessionId: string): void {
    const checkoutPath = this.sessionToCheckout.get(sessionId)
    if (!checkoutPath) return
    const state = this.checkouts.get(checkoutPath)
    if (!state) return
    const set = state.subscribers.get(clientId)
    if (set) {
      set.delete(sessionId)
      if (set.size === 0) state.subscribers.delete(clientId)
    }
    const stillSubscribed = Array.from(state.subscribers.values()).some((s) => s.has(sessionId))
    if (!stillSubscribed) {
      state.sessionWorkspace.delete(sessionId)
      this.sessionToCheckout.delete(sessionId)
    }
    if (state.subscribers.size === 0) {
      state.cancelTimer?.()
      state.cancelTimer = null
      this.checkouts.delete(checkoutPath)
    }
  }

  private async poll(state: CheckoutState, reason: GitStatusChangeReason): Promise<void> {
    if (state.polling) {
      // Coalesce: remember the highest-priority reason for a follow-up poll.
      state.pendingReason = reason
      return
    }
    state.polling = true
    try {
      const status = await this.getStatus(state.checkoutPath, { baseRef: state.baseRef })
      const sig = statusSignature(status)
      if (sig !== state.lastSignature) {
        state.lastSignature = sig
        for (const [sessionId, workspaceId] of state.sessionWorkspace) {
          this.publish({ sessionId, status, reason }, workspaceId)
        }
      }
    } catch {
      /* transient failure; the next interval retries */
    } finally {
      state.polling = false
      const pending = state.pendingReason
      if (pending && this.checkouts.get(state.checkoutPath) === state) {
        state.pendingReason = null
        await this.poll(state, pending)
      }
    }
  }
}
