import { afterEach, describe, expect, it } from 'bun:test'
import type { GitStatusSnapshot } from '@kata-sh/shared/protocol'
import { appStore } from '../store'
import {
  acquireGitStatus,
  gitStatusAtomFamily,
  releaseGitStatus,
} from '../git-status'

const status: GitStatusSnapshot = {
  repositoryRoot: '/repo',
  checkoutPath: '/repo/.worktrees/feature',
  isGitRepository: true,
  currentBranch: 'kata-agent/12345678',
  detached: false,
  defaultRef: 'main',
  baseRef: 'main',
  upstream: null,
  ahead: 0,
  behind: 0,
  publishableCommitCount: 1,
  baseDeltaCount: 1,
  primaryRemote: 'origin',
  provider: 'github',
  entries: [],
  operationInProgress: null,
  blockedReason: null,
}

afterEach(() => {
  releaseGitStatus('session-1')
  Reflect.deleteProperty(globalThis, 'window')
})

describe('git status store', () => {
  it('publishes an IPC snapshot into the provider-backed app store', async () => {
    Object.assign(globalThis, {
      window: {
        electronAPI: {
          subscribeGitStatus: async () => status,
          unsubscribeGitStatus: async () => {},
          onGitStatusChanged: () => () => {},
        },
      },
    })

    await acquireGitStatus('session-1')

    expect(appStore.get(gitStatusAtomFamily('session-1'))).toMatchObject({
      status,
      loading: false,
      error: null,
    })
  })
})
