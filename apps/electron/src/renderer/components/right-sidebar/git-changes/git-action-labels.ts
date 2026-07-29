/**
 * Pure mapping from resolver output to i18n keys for the header Git control.
 *
 * Keeping this out of the component makes the label/explanation contract unit-
 * testable and ensures every action kind and disabled reason has copy.
 */

import type { GitActionKind, GitActionDisabledReason } from '@kata-sh/shared/git'

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
