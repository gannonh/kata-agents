import { describe, expect, it } from 'bun:test'
import {
  resolveGitAction,
  buildGitMenu,
  type GitActionResolverInput,
} from '../action-state'
import type { GitStatusSnapshot, PullRequestSummary } from '../../protocol/git'

function snapshot(overrides: Partial<GitStatusSnapshot> = {}): GitStatusSnapshot {
  return {
    repositoryRoot: '/repo',
    checkoutPath: '/repo',
    isGitRepository: true,
    currentBranch: 'feature',
    detached: false,
    defaultRef: 'main',
    baseRef: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    publishableCommitCount: 0,
    baseDeltaCount: 0,
    primaryRemote: 'origin',
    provider: 'github',
    entries: [],
    operationInProgress: null,
    blockedReason: null,
    ...overrides,
  }
}

function dirtyEntry(path = 'a.ts', conflicted = false) {
  return { path, type: 'modified' as const, conflicted }
}

const openPr: PullRequestSummary = {
  number: 7,
  url: 'https://github.com/o/r/pull/7',
  title: 'PR',
  state: 'open',
  baseRef: 'main',
  headRef: 'feature',
}

function input(overrides: Partial<GitActionResolverInput> = {}): GitActionResolverInput {
  return {
    busy: false,
    status: snapshot(),
    pullRequest: null,
    pullRequestsAvailable: true,
    ...overrides,
  }
}

describe('resolveGitAction — rule 1 (disabled preconditions)', () => {
  it('busy → disabled/busy', () => {
    const r = resolveGitAction(input({ busy: true }))
    expect(r).toEqual({ kind: 'disabled', disabled: true, disabledReason: 'busy' })
  })
  it('missing status → disabled/no-status', () => {
    expect(resolveGitAction(input({ status: null })).disabledReason).toBe('no-status')
  })
  it('non-Git → disabled/non-git', () => {
    expect(
      resolveGitAction(input({ status: snapshot({ isGitRepository: false }) })).disabledReason,
    ).toBe('non-git')
  })
  it('missing branch → disabled/detached', () => {
    expect(
      resolveGitAction(input({ status: snapshot({ currentBranch: null }) })).disabledReason,
    ).toBe('detached')
  })
  it('detached HEAD → disabled/detached', () => {
    expect(
      resolveGitAction(
        input({ status: snapshot({ detached: true, currentBranch: null }) }),
      ).disabledReason,
    ).toBe('detached')
  })
})

describe('resolveGitAction — rule 2 (conflict / divergence)', () => {
  it('conflict → disabled/conflict', () => {
    const r = resolveGitAction(
      input({ status: snapshot({ entries: [dirtyEntry('a.ts', true)] }) }),
    )
    expect(r.disabledReason).toBe('conflict')
  })
  it('divergence (ahead>0 and behind>0) → disabled/diverged', () => {
    const r = resolveGitAction(
      input({ status: snapshot({ upstream: 'origin/feature', ahead: 1, behind: 1 }) }),
    )
    expect(r.disabledReason).toBe('diverged')
  })
})

describe('resolveGitAction — rules 3-4 (behind upstream)', () => {
  it('behind + dirty + not ahead → Commit', () => {
    const r = resolveGitAction(
      input({
        status: snapshot({ upstream: 'origin/feature', behind: 2, entries: [dirtyEntry()] }),
      }),
    )
    expect(r.kind).toBe('commit')
  })
  it('behind + clean + not ahead → Pull', () => {
    const r = resolveGitAction(
      input({ status: snapshot({ upstream: 'origin/feature', behind: 2 }) }),
    )
    expect(r.kind).toBe('pull')
  })
})

describe('resolveGitAction — rules 5-7 (dirty)', () => {
  it('dirty + no remote → Commit', () => {
    const r = resolveGitAction(
      input({ status: snapshot({ primaryRemote: null, entries: [dirtyEntry()] }) }),
    )
    expect(r.kind).toBe('commit')
  })
  it('dirty on default branch → Commit & push with default-branch confirmation', () => {
    const r = resolveGitAction(
      input({ status: snapshot({ currentBranch: 'main', entries: [dirtyEntry()] }) }),
    )
    expect(r.kind).toBe('commit-push')
    expect(r.requiresDefaultBranchConfirmation).toBe(true)
  })
  it('dirty on branch with open PR → Commit & push (no default confirmation)', () => {
    const r = resolveGitAction(
      input({ status: snapshot({ entries: [dirtyEntry()] }), pullRequest: openPr }),
    )
    expect(r.kind).toBe('commit-push')
    expect(r.requiresDefaultBranchConfirmation).toBe(false)
  })
  it('dirty feature branch, remote, no PR, gh available → Commit, push & PR', () => {
    const r = resolveGitAction(input({ status: snapshot({ entries: [dirtyEntry()] }) }))
    expect(r.kind).toBe('commit-push-pr')
  })
  it('dirty feature branch, remote, no PR, gh unavailable → Commit & push', () => {
    const r = resolveGitAction(
      input({ status: snapshot({ entries: [dirtyEntry()] }), pullRequestsAvailable: false }),
    )
    expect(r.kind).toBe('commit-push')
  })
})

describe('resolveGitAction — rules 8-9 (clean, no upstream, publishable)', () => {
  it('publishable on default branch → Push (+confirm)', () => {
    const r = resolveGitAction(
      input({ status: snapshot({ currentBranch: 'main', publishableCommitCount: 3 }) }),
    )
    expect(r.kind).toBe('push')
    expect(r.requiresDefaultBranchConfirmation).toBe(true)
  })
  it('publishable on feature branch, gh available → Push & create PR', () => {
    const r = resolveGitAction(
      input({ status: snapshot({ publishableCommitCount: 3, baseDeltaCount: 3 }) }),
    )
    expect(r.kind).toBe('push-pr')
  })
  it('publishable on feature branch, gh unavailable → Push', () => {
    const r = resolveGitAction(
      input({
        status: snapshot({ publishableCommitCount: 3, baseDeltaCount: 3 }),
        pullRequestsAvailable: false,
      }),
    )
    expect(r.kind).toBe('push')
  })
})

describe('resolveGitAction — rules 10-11 (clean, ahead of upstream)', () => {
  it('ahead on default branch → Push (+confirm)', () => {
    const r = resolveGitAction(
      input({
        status: snapshot({ currentBranch: 'main', upstream: 'origin/main', ahead: 2 }),
      }),
    )
    expect(r.kind).toBe('push')
    expect(r.requiresDefaultBranchConfirmation).toBe(true)
  })
  it('ahead on feature branch, no PR → Push & create PR', () => {
    const r = resolveGitAction(
      input({
        status: snapshot({ upstream: 'origin/feature', ahead: 2, baseDeltaCount: 2 }),
      }),
    )
    expect(r.kind).toBe('push-pr')
  })
})

describe('resolveGitAction — rules 12-14 (clean end states)', () => {
  it('clean, not ahead, ahead of base, no PR → Create PR', () => {
    const r = resolveGitAction(
      input({
        status: snapshot({ upstream: 'origin/feature', ahead: 0, baseDeltaCount: 4 }),
      }),
    )
    expect(r.kind).toBe('create-pr')
  })
  it('clean, open PR, no push/pull work → View PR', () => {
    const r = resolveGitAction(
      input({
        status: snapshot({ upstream: 'origin/feature', ahead: 0, baseDeltaCount: 4 }),
        pullRequest: openPr,
      }),
    )
    expect(r.kind).toBe('view-pr')
  })
  it('clean, local commits, no remote → disabled/setup-required', () => {
    const r = resolveGitAction(
      input({ status: snapshot({ primaryRemote: null, baseDeltaCount: 2 }) }),
    )
    expect(r.disabledReason).toBe('setup-required')
  })
  it('fully up-to-date → disabled/up-to-date', () => {
    const r = resolveGitAction(
      input({ status: snapshot({ upstream: 'origin/feature', ahead: 0, baseDeltaCount: 0 }) }),
    )
    expect(r.disabledReason).toBe('up-to-date')
  })
})

describe('buildGitMenu — independent action validity', () => {
  it('is empty when busy', () => {
    expect(buildGitMenu(input({ busy: true }))).toEqual({
      commit: false,
      push: false,
      createPr: false,
      viewPr: false,
    })
  })
  it('is empty for non-Git / detached', () => {
    expect(buildGitMenu(input({ status: snapshot({ isGitRepository: false }) })).commit).toBe(false)
    expect(buildGitMenu(input({ status: snapshot({ detached: true, currentBranch: null }) })).push).toBe(
      false,
    )
  })
  it('enables Commit for committable dirty state, not for conflict', () => {
    expect(buildGitMenu(input({ status: snapshot({ entries: [dirtyEntry()] }) })).commit).toBe(true)
    expect(
      buildGitMenu(input({ status: snapshot({ entries: [dirtyEntry('a.ts', true)] }) })).commit,
    ).toBe(false)
  })
  it('enables Push for ahead of configured upstream, not when behind', () => {
    expect(
      buildGitMenu(input({ status: snapshot({ upstream: 'origin/feature', ahead: 1 }) })).push,
    ).toBe(true)
    expect(
      buildGitMenu(
        input({ status: snapshot({ upstream: 'origin/feature', ahead: 1, behind: 1 }) }),
      ).push,
    ).toBe(false)
  })
  it('enables Push for no-upstream publishable commits', () => {
    expect(
      buildGitMenu(input({ status: snapshot({ publishableCommitCount: 2 }) })).push,
    ).toBe(true)
  })
  it('enables Create PR for clean base-delta branch with no open PR', () => {
    expect(buildGitMenu(input({ status: snapshot({ baseDeltaCount: 2 }) })).createPr).toBe(true)
    // dirty → not a create-pr menu candidate
    expect(
      buildGitMenu(input({ status: snapshot({ baseDeltaCount: 2, entries: [dirtyEntry()] }) }))
        .createPr,
    ).toBe(false)
    // open PR → View PR instead of Create PR
    expect(
      buildGitMenu(input({ status: snapshot({ baseDeltaCount: 2 }), pullRequest: openPr }))
        .createPr,
    ).toBe(false)
  })
  it('enables View PR when an open PR exists', () => {
    expect(buildGitMenu(input({ pullRequest: openPr })).viewPr).toBe(true)
  })
  it('gates Create PR on GitHub availability', () => {
    expect(
      buildGitMenu(input({ status: snapshot({ baseDeltaCount: 2 }), pullRequestsAvailable: false }))
        .createPr,
    ).toBe(false)
  })
})
