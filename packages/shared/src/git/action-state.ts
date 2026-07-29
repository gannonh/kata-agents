/**
 * Pure Git action-state resolver + independent menu builder (spec: AC12,
 * "Git action control"). This is the normative local equivalent of Kata Code's
 * `resolveQuickAction` / `buildMenuItems`.
 *
 * `resolveGitAction` walks the spec's ordered decision list and returns the
 * single primary action (or a disabled explanatory state); the first matching
 * rule wins. `buildGitMenu` independently reports which discrete Commit / Push /
 * Create-PR / View-PR actions are currently valid, since the adjacent menu may
 * expose an action even when it is not the primary one.
 *
 * Both functions are pure and transport/React-agnostic so the behavior is
 * fully truth-table testable (spec: "State resolution is a pure tested
 * function").
 */

import type { GitStatusSnapshot, PullRequestSummary } from '../protocol/git'

/** Primary/menu action kinds the header Git control can offer. */
export type GitActionKind =
  | 'commit'
  | 'commit-push'
  | 'commit-push-pr'
  | 'push'
  | 'push-pr'
  | 'create-pr'
  | 'pull'
  | 'view-pr'
  | 'disabled'

/** Why the primary action is disabled (drives the explanatory copy + hint). */
export type GitActionDisabledReason =
  | 'busy'
  | 'no-status'
  | 'non-git'
  | 'detached'
  | 'conflict'
  | 'diverged'
  | 'setup-required'
  | 'up-to-date'

export interface GitActionResolverInput {
  /** A Git mutation is currently in flight. */
  busy: boolean
  /** Latest status snapshot, or null while it is still loading. */
  status: GitStatusSnapshot | null
  /** Open pull request for the current branch, when one was detected. */
  pullRequest: PullRequestSummary | null
  /**
   * Whether GitHub pull-request actions are usable: a GitHub remote with `gh`
   * installed and authenticated for the host (spec: AC15). When false, PR-
   * including actions degrade to their commit/push equivalents.
   */
  pullRequestsAvailable: boolean
}

export interface GitActionResolution {
  kind: GitActionKind
  disabled: boolean
  disabledReason?: GitActionDisabledReason
  /** True when the action mutates the default branch and needs confirmation. */
  requiresDefaultBranchConfirmation?: boolean
}

export interface GitMenuState {
  commit: boolean
  push: boolean
  createPr: boolean
  viewPr: boolean
}

interface Derived {
  isGit: boolean
  branch: string | null
  detached: boolean
  dirty: boolean
  hasConflict: boolean
  upstream: boolean
  ahead: number
  behind: number
  hasRemote: boolean
  publishable: number
  baseDelta: number
  isDefaultBranch: boolean
  hasOpenPr: boolean
  /** Default branch or a branch with an open PR (spec vocabulary). */
  onDefaultOrPr: boolean
  /** A PR can be created now (GitHub available and no open PR yet). */
  canCreatePr: boolean
}

function derive(input: GitActionResolverInput): Derived | null {
  const { status, pullRequest, pullRequestsAvailable } = input
  if (!status) return null
  const branch = status.currentBranch
  const dirty = status.entries.length > 0
  const hasConflict = status.entries.some((e) => e.conflicted)
  const upstream = status.upstream != null
  const hasRemote = status.primaryRemote != null
  const isDefaultBranch = branch != null && status.defaultRef != null && branch === status.defaultRef
  const hasOpenPr = pullRequest != null && pullRequest.state === 'open'
  return {
    isGit: status.isGitRepository,
    branch,
    detached: status.detached,
    dirty,
    hasConflict,
    upstream,
    ahead: status.ahead,
    behind: status.behind,
    hasRemote,
    publishable: status.publishableCommitCount,
    baseDelta: status.baseDeltaCount,
    isDefaultBranch,
    hasOpenPr,
    onDefaultOrPr: isDefaultBranch || hasOpenPr,
    canCreatePr: pullRequestsAvailable && !hasOpenPr,
  }
}

function disabled(reason: GitActionDisabledReason): GitActionResolution {
  return { kind: 'disabled', disabled: true, disabledReason: reason }
}

function action(
  kind: GitActionKind,
  requiresDefaultBranchConfirmation = false,
): GitActionResolution {
  return { kind, disabled: false, requiresDefaultBranchConfirmation }
}

/**
 * Resolve the primary Git action for the current status. Implements the spec's
 * ordered decision list; the first matching rule wins.
 */
export function resolveGitAction(input: GitActionResolverInput): GitActionResolution {
  // Rule 1: busy / missing status / non-Git / missing branch / detached HEAD.
  if (input.busy) return disabled('busy')
  const d = derive(input)
  if (!d) return disabled('no-status')
  if (!d.isGit) return disabled('non-git')
  if (!d.branch || d.detached) return disabled('detached')

  // Rule 2: conflict or upstream divergence (ahead > 0 and behind > 0).
  if (d.hasConflict) return disabled('conflict')
  if (d.ahead > 0 && d.behind > 0) return disabled('diverged')

  // Rule 3: configured upstream behind, dirty, not ahead → Commit (preserve work).
  if (d.upstream && d.behind > 0 && d.dirty && d.ahead === 0) return action('commit')

  // Rule 4: configured upstream behind, clean, not ahead → Pull (ff-only).
  if (d.upstream && d.behind > 0 && !d.dirty && d.ahead === 0) return action('pull')

  // Rule 5: dirty with no primary remote → Commit.
  if (d.dirty && !d.hasRemote) return action('commit')

  // Rule 6: dirty on default branch or a branch with an open PR → Commit & push.
  if (d.dirty && d.onDefaultOrPr) return action('commit-push', d.isDefaultBranch)

  // Rule 7: dirty feature branch, primary remote, no open PR → Commit, push & PR.
  if (d.dirty && d.hasRemote && !d.onDefaultOrPr) {
    return action(d.canCreatePr ? 'commit-push-pr' : 'commit-push')
  }

  // Rule 8: clean, no upstream, remote, publishable commits, default/PR branch → Push (+upstream).
  if (!d.dirty && !d.upstream && d.hasRemote && d.publishable > 0 && d.onDefaultOrPr) {
    return action('push', d.isDefaultBranch)
  }

  // Rule 9: clean, no upstream, remote, publishable commits, feature branch, no PR → Push & create PR.
  if (!d.dirty && !d.upstream && d.hasRemote && d.publishable > 0 && !d.onDefaultOrPr) {
    return action(d.canCreatePr ? 'push-pr' : 'push')
  }

  // Rule 10: clean, ahead of configured upstream, default/PR branch → Push.
  if (!d.dirty && d.upstream && d.ahead > 0 && d.onDefaultOrPr) {
    return action('push', d.isDefaultBranch)
  }

  // Rule 11: clean, ahead of configured upstream, feature branch, no PR → Push & create PR.
  if (!d.dirty && d.upstream && d.ahead > 0 && !d.onDefaultOrPr) {
    return action(d.canCreatePr ? 'push-pr' : 'push')
  }

  // Rule 12: clean, not ahead of upstream, ahead of PR base, remote, no open PR → Create PR.
  if (!d.dirty && d.ahead === 0 && d.baseDelta > 0 && d.hasRemote && d.canCreatePr) {
    return action('create-pr')
  }

  // Rule 13: clean with an open PR and no push/pull work → View PR.
  if (!d.dirty && d.hasOpenPr && d.ahead === 0 && d.behind === 0) {
    return action('view-pr')
  }

  // Rule 14: otherwise disabled — setup-required when local commits have no
  // remote to publish to, else up-to-date.
  if (!d.hasRemote && d.baseDelta > 0) return disabled('setup-required')
  return disabled('up-to-date')
}

/**
 * Independent menu builder. Each entry reports whether that discrete action is
 * currently valid on its own, regardless of which action is primary.
 */
export function buildGitMenu(input: GitActionResolverInput): GitMenuState {
  const empty: GitMenuState = { commit: false, push: false, createPr: false, viewPr: false }
  if (input.busy) return empty
  const d = derive(input)
  if (!d || !d.isGit || !d.branch || d.detached) return empty

  // Commit: any committable dirty state (never with unmerged/conflict entries).
  const commit = d.dirty && !d.hasConflict

  // Push: a primary remote exists and there is something to publish
  // (configured-upstream ahead, or no-upstream publishable commits), with no
  // behind/conflict state.
  const push =
    d.hasRemote &&
    !d.hasConflict &&
    d.behind === 0 &&
    ((d.upstream && d.ahead > 0) || (!d.upstream && d.publishable > 0))

  // Create PR: clean branch with a base delta and no open PR (includes the
  // no-upstream case whose action pushes first). Requires GitHub availability.
  const createPr = d.canCreatePr && !d.dirty && !d.hasConflict && d.baseDelta > 0

  // View PR: an open PR exists.
  const viewPr = d.hasOpenPr

  return { commit, push, createPr, viewPr }
}
