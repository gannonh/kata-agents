/**
 * Renderer-side Git status store for the Changes surfaces.
 *
 * A single coalesced subscription per session is shared by every Git surface
 * (the header affordance and the Changes panel). Reference counting means we
 * subscribe on the first surface that opens and unsubscribe when the last one
 * closes (spec: subscribe on open; unsubscribe when the last surface closes).
 *
 * The server publishes workspace-routed `onGitStatusChanged` events; a single
 * global listener fans those out into the per-session atom so external/poll
 * changes render within the five-second acceptance bound (AC9).
 */

import { atom } from 'jotai'
import { atomFamily } from 'jotai/utils'
import type { GitStatusSnapshot } from '@kata-sh/shared/protocol'
import { appStore } from './store'

export interface GitStatusState {
  status: GitStatusSnapshot | null
  loading: boolean
  error: string | null
  lastUpdatedAt: number | null
}

const INITIAL: GitStatusState = {
  status: null,
  loading: false,
  error: null,
  lastUpdatedAt: null,
}

/** Per-session Git status atom. Re-renders only consumers of that session. */
export const gitStatusAtomFamily = atomFamily((_sessionId: string) =>
  atom<GitStatusState>(INITIAL),
)

const refcounts = new Map<string, number>()
let globalUnsubscribe: (() => void) | null = null

function setState(sessionId: string, next: GitStatusState): void {
  appStore.set(gitStatusAtomFamily(sessionId), next)
}

function patchState(sessionId: string, patch: Partial<GitStatusState>): void {
  const current = appStore.get(gitStatusAtomFamily(sessionId))
  appStore.set(gitStatusAtomFamily(sessionId), { ...current, ...patch })
}

function ensureGlobalListener(): void {
  if (globalUnsubscribe) return
  const api = window.electronAPI
  if (!api?.onGitStatusChanged) return
  globalUnsubscribe = api.onGitStatusChanged((event) => {
    // Ignore events for sessions no surface is currently bound to.
    if (!refcounts.has(event.sessionId)) return
    setState(event.sessionId, {
      status: event.status,
      loading: false,
      error: null,
      lastUpdatedAt: Date.now(),
    })
  })
}

function teardownGlobalListenerIfIdle(): void {
  if (refcounts.size === 0 && globalUnsubscribe) {
    globalUnsubscribe()
    globalUnsubscribe = null
  }
}

/**
 * Acquire a status subscription for a session. The first acquirer performs the
 * network subscribe and seeds the snapshot; later acquirers just bump the
 * refcount and read the shared atom.
 */
export async function acquireGitStatus(sessionId: string): Promise<void> {
  const count = refcounts.get(sessionId) ?? 0
  refcounts.set(sessionId, count + 1)
  ensureGlobalListener()
  if (count > 0) return

  const api = window.electronAPI
  if (!api?.subscribeGitStatus) return
  patchState(sessionId, { loading: true, error: null })
  try {
    const snapshot = await api.subscribeGitStatus(sessionId)
    // A release may have raced ahead of the await; only publish if still held.
    if (refcounts.has(sessionId)) {
      setState(sessionId, {
        status: snapshot,
        loading: false,
        error: null,
        lastUpdatedAt: Date.now(),
      })
    }
  } catch (err) {
    if (refcounts.has(sessionId)) {
      patchState(sessionId, {
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

/** Release a status subscription. The last releaser tears down the network subscription. */
export function releaseGitStatus(sessionId: string): void {
  const count = refcounts.get(sessionId) ?? 0
  if (count <= 1) {
    refcounts.delete(sessionId)
    window.electronAPI?.unsubscribeGitStatus?.(sessionId)?.catch?.(() => {})
    setState(sessionId, INITIAL)
    teardownGlobalListenerIfIdle()
  } else {
    refcounts.set(sessionId, count - 1)
  }
}

/**
 * Force an immediate refresh for a session (app-issued Git actions, agent turn
 * completion). Re-subscribing is idempotent server-side and returns the latest
 * snapshot. No-op when nothing is subscribed.
 */
export async function refreshGitStatus(sessionId: string): Promise<void> {
  if (!refcounts.has(sessionId)) return
  const api = window.electronAPI
  if (!api?.subscribeGitStatus) return
  try {
    const snapshot = await api.subscribeGitStatus(sessionId)
    if (refcounts.has(sessionId)) {
      setState(sessionId, {
        status: snapshot,
        loading: false,
        error: null,
        lastUpdatedAt: Date.now(),
      })
    }
  } catch {
    /* keep the previous snapshot on transient refresh failure */
  }
}
