import { describe, expect, it } from 'bun:test'
import type { GitActionKind, GitActionDisabledReason } from '@kata-sh/shared/git'
import type { GitHubCapabilityStatus } from '@kata-sh/shared/protocol'
import {
  primaryActionLabelKey,
  disabledExplanation,
  githubSetupGuidance,
} from '../git-action-labels'

describe('primaryActionLabelKey', () => {
  const kinds: GitActionKind[] = [
    'commit',
    'commit-push',
    'commit-push-pr',
    'push',
    'push-pr',
    'create-pr',
    'pull',
    'view-pr',
    'disabled',
  ]
  it('returns a git.action.* key for every action kind', () => {
    for (const kind of kinds) {
      expect(primaryActionLabelKey(kind)).toMatch(/^git\.action\./)
    }
  })
  it('maps compound actions distinctly', () => {
    expect(primaryActionLabelKey('commit-push')).toBe('git.action.commitPush')
    expect(primaryActionLabelKey('commit-push-pr')).toBe('git.action.commitPushPr')
    expect(primaryActionLabelKey('push-pr')).toBe('git.action.pushPr')
  })
})

describe('disabledExplanation', () => {
  const reasons: (GitActionDisabledReason | undefined)[] = [
    'busy',
    'no-status',
    'non-git',
    'detached',
    'conflict',
    'diverged',
    'setup-required',
    'up-to-date',
    undefined,
  ]
  it('always returns both a label and a hint key', () => {
    for (const reason of reasons) {
      const { labelKey, hintKey } = disabledExplanation(reason)
      expect(labelKey).toMatch(/^git\.action\.disabled\./)
      expect(hintKey).toMatch(/^git\.action\.hint\./)
    }
  })
  it('falls back to up-to-date for an unknown reason', () => {
    expect(disabledExplanation(undefined).labelKey).toBe('git.action.disabled.upToDate')
  })
})

describe('githubSetupGuidance', () => {
  const authed: GitHubCapabilityStatus = { installed: true, authenticated: true, host: 'github.com' }

  it('returns null for non-github providers', () => {
    expect(githubSetupGuidance('gitlab', { installed: false, authenticated: false, host: null })).toBeNull()
  })

  it('returns null while capability is still loading', () => {
    expect(githubSetupGuidance('github', null)).toBeNull()
  })

  it('returns null when gh is installed and authenticated', () => {
    expect(githubSetupGuidance('github', authed)).toBeNull()
  })

  it('surfaces the install detail when gh is missing', () => {
    const g = githubSetupGuidance('github', {
      installed: false,
      authenticated: false,
      host: 'github.com',
      detail: 'gh is not installed.',
    })
    expect(g?.labelKey).toBe('git.github.installRequired')
    expect(g?.detail).toMatch(/not installed/)
  })

  it('surfaces the authenticate detail when gh is installed but not authenticated', () => {
    const g = githubSetupGuidance('github', {
      installed: true,
      authenticated: false,
      host: 'github.com',
      detail: 'Run `gh auth login --hostname github.com` to authenticate.',
    })
    expect(g?.labelKey).toBe('git.github.authRequired')
    expect(g?.detail).toMatch(/gh auth login/)
  })

  it('falls back to a default detail when none is provided', () => {
    const g = githubSetupGuidance('github', { installed: false, authenticated: false, host: null })
    expect(g?.detail).toBeTruthy()
  })
})
