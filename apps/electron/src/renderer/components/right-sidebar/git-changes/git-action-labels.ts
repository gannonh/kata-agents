/**
 * Pure mapping from resolver output to i18n keys for the header Git control.
 *
 * Keeping this out of the component makes the label/explanation contract unit-
 * testable and ensures every action kind and disabled reason has copy.
 */

import type { GitActionKind, GitActionDisabledReason } from '@kata-sh/shared/git'
import type { GitHubCapabilityStatus } from '@kata-sh/shared/protocol'

/** i18n key for a primary action's button label. */
export function primaryActionLabelKey(kind: GitActionKind): string {
  switch (kind) {
    case 'commit':
      return 'git.action.commit'
    case 'commit-push':
      return 'git.action.commitPush'
    case 'commit-push-pr':
      return 'git.action.commitPushPr'
    case 'push':
      return 'git.action.push'
    case 'push-pr':
      return 'git.action.pushPr'
    case 'create-pr':
      return 'git.action.createPr'
    case 'pull':
      return 'git.action.pull'
    case 'view-pr':
      return 'git.action.viewPr'
    case 'disabled':
      return 'git.action.disabled'
  }
}

/** i18n keys for a disabled state's short label and explanatory hint. */
export function disabledExplanation(reason: GitActionDisabledReason | undefined): {
  labelKey: string
  hintKey: string
} {
  switch (reason) {
    case 'busy':
      return { labelKey: 'git.action.disabled.busy', hintKey: 'git.action.hint.busy' }
    case 'no-status':
      return { labelKey: 'git.action.disabled.noStatus', hintKey: 'git.action.hint.noStatus' }
    case 'non-git':
      return { labelKey: 'git.action.disabled.nonGit', hintKey: 'git.action.hint.nonGit' }
    case 'detached':
      return { labelKey: 'git.action.disabled.detached', hintKey: 'git.action.hint.detached' }
    case 'conflict':
      return { labelKey: 'git.action.disabled.conflict', hintKey: 'git.action.hint.conflict' }
    case 'diverged':
      return { labelKey: 'git.action.disabled.diverged', hintKey: 'git.action.hint.diverged' }
    case 'setup-required':
      return {
        labelKey: 'git.action.disabled.setupRequired',
        hintKey: 'git.action.hint.setupRequired',
      }
    case 'up-to-date':
    default:
      return { labelKey: 'git.action.disabled.upToDate', hintKey: 'git.action.hint.upToDate' }
  }
}

export interface GitHubSetupGuidance {
  /** i18n key for the short affordance label. */
  labelKey: string
  /**
   * Actionable detail sourced from GitHubCliService (e.g. the exact
   * `gh auth login` command). Shown verbatim — it is a CLI command hint, not a
   * translatable UI string, matching how action errors are surfaced.
   */
  detail: string
}

/**
 * Compute actionable GitHub setup guidance for the header control. Returns null
 * when PR actions are available or not applicable; otherwise surfaces the
 * capability detail from GitHubCliService so the UI shows *why* PR actions are
 * unavailable and how to fix it (spec: AC15 — "Missing Git, remote, `gh`, or
 * authentication produces actionable guidance without changing repository
 * state") instead of silently hiding PR actions.
 */
export function githubSetupGuidance(
  provider: string | undefined,
  capability: GitHubCapabilityStatus | null,
): GitHubSetupGuidance | null {
  if (provider !== 'github' || !capability) return null
  if (capability.installed && capability.authenticated) return null
  if (!capability.installed) {
    return {
      labelKey: 'git.github.installRequired',
      detail: capability.detail ?? 'GitHub CLI (gh) is not installed on the workspace machine.',
    }
  }
  return {
    labelKey: 'git.github.authRequired',
    detail: capability.detail ?? 'GitHub CLI (gh) is not authenticated for this host.',
  }
}
