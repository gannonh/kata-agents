import { describe, expect, it } from 'bun:test'
import type { GitActionKind, GitActionDisabledReason } from '@kata-sh/shared/git'
import { primaryActionLabelKey, disabledExplanation } from '../git-action-labels'

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
