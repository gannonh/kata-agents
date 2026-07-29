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

import type { WorktreeRemovalRisk } from '@kata-sh/shared/protocol'

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
