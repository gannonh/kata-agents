import type { KatacodeWorktreePolicy, KatacodeWorktreeSummary } from '@kata-sh/core';

export interface KatacodeWorktreeAllocation {
  readonly managedWorktreeId: string;
  readonly summary: KatacodeWorktreeSummary;
  readonly leaseId?: string;
}

export interface KatacodeWorktreeAllocator {
  allocateIsolated(input: {
    readonly workspaceId: string;
    readonly ownerTaskId: string;
    readonly ownerSessionId: string;
    readonly repositoryLabel: string;
  }): Promise<KatacodeWorktreeAllocation>;

  acquireSharedLease(input: {
    readonly workspaceId: string;
    readonly ownerTaskId: string;
    readonly ownerSessionId: string;
    readonly managedWorktreeId: string;
    readonly repositoryLabel: string;
  }): Promise<KatacodeWorktreeAllocation>;

  /** Release a shared-checkout lease when the owning task becomes terminal. Isolated allocators may omit this. */
  release?(input: {
    readonly ownerTaskId: string;
  }): void;
}

export class SharedWorktreeRequiresApprovalError extends Error {
  readonly code = 'shared_worktree_approval_required' as const;
}
