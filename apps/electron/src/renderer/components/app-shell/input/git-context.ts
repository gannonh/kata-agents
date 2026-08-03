import type { RepositoryContext } from '@kata-sh/shared/protocol'

export interface GitContextRefreshRequest {
  flagEnabled: boolean
  workingDirectory?: string
  sessionId?: string
}

export interface GitContextRefreshState {
  requestKey: string
  context: RepositoryContext | null
}

export type GetGitContext = (workingDirectory: string) => Promise<RepositoryContext>

/**
 * Identifies the session and checkout inputs used for Git-context discovery.
 * The session ID is intentionally part of the key even when the directory is
 * unchanged: the badge is reused across session selection changes.
 */
export function getGitContextRefreshKey(request: GitContextRefreshRequest): string {
  return JSON.stringify([
    request.flagEnabled,
    request.workingDirectory ?? null,
    request.sessionId ?? null,
  ])
}

/**
 * Start one Git-context discovery request and return its cancellation callback.
 * Callers should invoke the callback from the effect cleanup so an older
 * session cannot publish its branch after the selected session changes.
 */
export function refreshGitContext(
  request: GitContextRefreshRequest,
  getContext: GetGitContext,
  onState: (state: GitContextRefreshState) => void,
): () => void {
  const requestKey = getGitContextRefreshKey(request)
  let cancelled = false

  // Clear the previous branch immediately while the new request is pending.
  onState({ requestKey, context: null })

  if (!request.flagEnabled || !request.workingDirectory) {
    return () => {
      cancelled = true
    }
  }

  void getContext(request.workingDirectory)
    .then((context) => {
      if (!cancelled) onState({ requestKey, context })
    })
    .catch(() => {
      if (!cancelled) onState({ requestKey, context: null })
    })

  return () => {
    cancelled = true
  }
}

/** Renderer-side default used by WorkspaceCheckoutBadge. */
export const getLiveGitContext: GetGitContext = (workingDirectory) => {
  const getter = window.electronAPI?.getGitContext
  if (!getter) {
    return Promise.reject(new Error('Git context API is unavailable.'))
  }
  return getter(workingDirectory)
}
