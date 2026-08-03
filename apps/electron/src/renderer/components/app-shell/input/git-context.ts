import type { RepositoryContext } from '@kata-sh/shared/protocol'

export interface GitContextRefreshRequest {
  flagEnabled: boolean
  workingDirectory?: string
  sessionId?: string
  /** Refresh when a panel becomes focused without changing session inputs. */
  isFocusedPanel?: boolean
  /** Increment to retry a failed context lookup with the same inputs. */
  refreshToken?: number
}

export type GitContextRefreshStatus = 'loading' | 'ready' | 'error' | 'disabled'

export interface GitContextRefreshState {
  requestKey: string
  context: RepositoryContext | null
  status: GitContextRefreshStatus
}

export type GetGitContext = (workingDirectory: string) => Promise<RepositoryContext>

/** How long a Git-context lookup may take before the refresh reports an error. */
export const GIT_CONTEXT_TIMEOUT_MS = 10_000

/**
 * Race a Git-context lookup against a finite timeout so a hung IPC call
 * rejects into the caller's error path instead of leaving the badge loading
 * forever with no way to retry.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Git context lookup timed out.')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * Identifies the session and checkout inputs used for Git-context discovery.
 * The session ID is intentionally part of the key even when the directory is
 * unchanged: the badge is reused across session selection changes. Panel focus
 * is also included so an already-mounted badge rediscovers Git when it becomes
 * the active panel after an external branch change.
 */
export function getGitContextRefreshKey(request: GitContextRefreshRequest): string {
  return JSON.stringify([
    request.flagEnabled,
    request.workingDirectory ?? null,
    request.sessionId ?? null,
    request.isFocusedPanel ?? null,
    request.refreshToken ?? null,
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
  options?: { timeoutMs?: number },
): () => void {
  const requestKey = getGitContextRefreshKey(request)
  let cancelled = false

  // Clear the previous branch immediately while the new request is pending.
  const canLoad = request.flagEnabled && !!request.workingDirectory
  onState({
    requestKey,
    context: null,
    status: canLoad ? 'loading' : 'disabled',
  })

  if (!canLoad || !request.workingDirectory) {
    return () => {
      cancelled = true
    }
  }

  void withTimeout(
    getContext(request.workingDirectory),
    options?.timeoutMs ?? GIT_CONTEXT_TIMEOUT_MS,
  ).then(
    (context) => {
      if (!cancelled) onState({ requestKey, context, status: 'ready' })
    },
    () => {
      if (!cancelled) onState({ requestKey, context: null, status: 'error' })
    },
  )

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
