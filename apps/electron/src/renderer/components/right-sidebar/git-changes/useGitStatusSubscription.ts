/**
 * React hook binding a Git surface to a session's coalesced status subscription.
 *
 * Acquiring the subscription on mount and releasing it on unmount implements the
 * spec's "subscribe on open; unsubscribe when the last surface closes" rule via
 * the refcounted manager in `atoms/git-status`. The returned state is the shared
 * per-session atom so the header affordance and the Changes panel stay in sync.
 */

import { useEffect } from 'react'
import { useAtomValue } from 'jotai'
import {
  gitStatusAtomFamily,
  acquireGitStatus,
  releaseGitStatus,
  type GitStatusState,
} from '@/atoms/git-status'

export function useGitStatusSubscription(
  sessionId: string | undefined,
  enabled: boolean,
): GitStatusState {
  const state = useAtomValue(gitStatusAtomFamily(sessionId ?? '__no_session__'))

  useEffect(() => {
    if (!enabled || !sessionId) return
    void acquireGitStatus(sessionId)
    return () => releaseGitStatus(sessionId)
  }, [enabled, sessionId])

  return state
}
