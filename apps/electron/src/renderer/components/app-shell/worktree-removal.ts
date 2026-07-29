/**
 * Pure helpers for the delete-session managed-worktree removal choice
 * (spec: AC18–AC19).
 *
 * Session deletion and managed-worktree removal are separate choices. Removal is
 * blocked while another session owns the worktree, and a removal that would
 * destroy uncommitted files or unique/unpushed commits requires an explicit
 * destructive confirmation that names the affected counts. The temporary
 * `kata-agent/<token>` branch is pruned only when it has no unique work.
 *
 * Kept free of React so the decision logic is unit-testable in isolation.
 */

import type { CheckoutMode, WorktreeRemovalRisk } from '@kata-sh/shared/protocol'

export interface WorktreeRemovalSummary {
  /** Removal is blocked because another session still owns the worktree. */
  blocked: boolean
  blockedReason?: string
  /** Removal would destroy uncommitted or unique work → explicit confirm. */
  destructive: boolean
  uncommittedFileCount: number
  unpushedCommitCount: number
  branchHasUniqueWork: boolean
  /** The temporary branch is pruned only when it has no unique work. */
  branchWillBePruned: boolean
  /** Number of other sessions still owning the worktree (drives the block copy). */
  otherOwnerCount: number
}

export function summarizeWorktreeRemoval(risk: WorktreeRemovalRisk): WorktreeRemovalSummary {
  return {
    blocked: risk.blocked,
    blockedReason: risk.blockedReason,
    destructive: !risk.blocked && (risk.uncommittedFileCount > 0 || risk.branchHasUniqueWork),
    uncommittedFileCount: risk.uncommittedFileCount,
    unpushedCommitCount: risk.unpushedCommitCount,
    branchHasUniqueWork: risk.branchHasUniqueWork,
    branchWillBePruned: !risk.branchHasUniqueWork,
    otherOwnerCount: risk.otherOwnerCount,
  }
}

/**
 * Whether the managed-worktree removal choice should be offered at all for a
 * session. Only managed worktrees that still exist are removable; a missing
 * checkout has nothing to remove (its recovery path is separate).
 */
export function canOfferWorktreeRemoval(risk: WorktreeRemovalRisk | null): boolean {
  return !!risk && risk.exists
}

/** Which confirmation a delete-session request should go through. */
export type DeleteConfirmation =
  /** The richer dialog that also offers managed-worktree removal. */
  | 'managed-worktree-dialog'
  /** The ordinary native "delete this session?" confirmation. */
  | 'native-confirm'
  /** No confirmation: an empty session with nothing to lose. */
  | 'skip'

/**
 * Resolve which confirmation a delete-session request needs.
 *
 * The managed-worktree dialog takes precedence over the empty-session shortcut.
 * Checkout preparation is only allowed *before* the first send, so a session can
 * hold a managed worktree and still be empty — the user may have prepared one
 * explicitly, or the first send may have failed after preparation succeeded.
 * Skipping the dialog for those deleted the session with no remaining way to
 * reach its checkout, orphaning the worktree and its temporary branch under the
 * Kata data directory.
 */
export function resolveDeleteConfirmation(input: {
  /** No assistant reply and no name yet. */
  isEmpty: boolean
  /** `session.checkout.mode`, when the Git workspace feature is enabled. */
  checkoutMode?: CheckoutMode | null
}): DeleteConfirmation {
  if (input.checkoutMode === 'managed-worktree') return 'managed-worktree-dialog'
  return input.isEmpty ? 'skip' : 'native-confirm'
}
