import { describe, expect, test } from 'bun:test'
import type { RepositoryContext } from '@kata-sh/shared/protocol'
import {
  getGitContextRefreshKey,
  refreshGitContext,
  type GitContextRefreshState,
} from '../git-context'

function contextFor(branch: string): RepositoryContext {
  return {
    isGitRepository: true,
    repositoryRoot: '/repo',
    gitCommonDir: '/repo/.git',
    currentBranch: branch,
    detached: false,
    headSha: null,
    defaultRef: 'main',
    remotes: [],
    primaryRemote: null,
    provider: 'other',
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

describe('Git context refresh', () => {
  test('changes its request identity when sessionId changes in the same directory', () => {
    const featureSession = getGitContextRefreshKey({
      flagEnabled: true,
      workingDirectory: '/repo',
      sessionId: 'feature-session',
      isFocusedPanel: true,
    })
    const mainSession = getGitContextRefreshKey({
      flagEnabled: true,
      workingDirectory: '/repo',
      sessionId: 'main-session',
      isFocusedPanel: true,
    })

    expect(mainSession).not.toBe(featureSession)
  })

  test('changes its request identity when an existing panel gains focus', () => {
    const unfocused = getGitContextRefreshKey({
      flagEnabled: true,
      workingDirectory: '/repo',
      sessionId: 'same-session',
      isFocusedPanel: false,
    })
    const focused = getGitContextRefreshKey({
      flagEnabled: true,
      workingDirectory: '/repo',
      sessionId: 'same-session',
      isFocusedPanel: true,
    })

    expect(focused).not.toBe(unfocused)
  })

  test('changes its request identity when a failed lookup is retried', () => {
    const initial = getGitContextRefreshKey({
      flagEnabled: true,
      workingDirectory: '/repo',
      sessionId: 'same-session',
      isFocusedPanel: true,
      refreshToken: 0,
    })
    const retry = getGitContextRefreshKey({
      flagEnabled: true,
      workingDirectory: '/repo',
      sessionId: 'same-session',
      isFocusedPanel: true,
      refreshToken: 1,
    })

    expect(retry).not.toBe(initial)
  })

  test('reports a failed lookup as an error so the caller can retry', async () => {
    const states: GitContextRefreshState[] = []
    const cancel = refreshGitContext(
      {
        flagEnabled: true,
        workingDirectory: '/repo',
        sessionId: 'failed-session',
        isFocusedPanel: true,
      },
      async () => {
        throw new Error('Git unavailable')
      },
      (state) => states.push(state),
    )

    await Promise.resolve()
    await Promise.resolve()
    expect(states.at(-1)?.status).toBe('error')
    cancel()
  })

  test('refreshes the same directory for a new session and ignores the old result', async () => {
    const first = deferred<RepositoryContext>()
    const second = deferred<RepositoryContext>()
    const requests: string[] = []
    const states: GitContextRefreshState[] = []
    const getContext = (directory: string) => {
      requests.push(directory)
      return requests.length === 1 ? first.promise : second.promise
    }

    const cancelFirst = refreshGitContext(
      {
        flagEnabled: true,
        workingDirectory: '/repo',
        sessionId: 'feature-session',
        isFocusedPanel: true,
      },
      getContext,
      (state) => states.push(state),
    )
    cancelFirst()

    const secondKey = getGitContextRefreshKey({
      flagEnabled: true,
      workingDirectory: '/repo',
      sessionId: 'main-session',
      isFocusedPanel: true,
    })
    const cancelSecond = refreshGitContext(
      {
        flagEnabled: true,
        workingDirectory: '/repo',
        sessionId: 'main-session',
        isFocusedPanel: true,
      },
      getContext,
      (state) => states.push(state),
    )

    expect(requests).toEqual(['/repo', '/repo'])
    expect(states.at(-1)).toEqual({ requestKey: secondKey, context: null, status: 'loading' })

    first.resolve(contextFor('feature'))
    await Promise.resolve()
    expect(states.some((state) => state.context?.currentBranch === 'feature')).toBe(false)

    second.resolve(contextFor('main'))
    await Promise.resolve()
    expect(states.at(-1)).toEqual({
      requestKey: secondKey,
      context: contextFor('main'),
      status: 'ready',
    })
    cancelSecond()
  })
})
