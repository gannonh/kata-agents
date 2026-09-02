import { basename } from 'node:path'
import { isWorktreeV2Enabled } from '@kata-sh/shared/feature-flags'
import type { KatacodeWorktreeAllocation, KatacodeWorktreeAllocator } from '@kata-sh/shared/katacode'
import type { GitServices } from '../git'

export class KatacodeRepositoryResolutionError extends Error {
  readonly code = 'repository_unresolved' as const
}

export function matchesRepositoryLabel(
  label: string,
  workspaceName: string,
  repositoryRoot: string,
  remotes: readonly { name?: string; url?: string | null }[],
): boolean {
  const rootName = basename(repositoryRoot)
  if (label === workspaceName || label === rootName) return true
  return remotes.some((remote) => {
    const url = remote.url ?? ''
    return remote.name === label
      || url.endsWith(`/${label}.git`)
      || url.endsWith(`:${label}.git`)
      || url.endsWith(`/${label}`)
      || url.endsWith(`:${label}`)
  })
}

function branchLabel(created: { record: { expectedBranch?: string; managedWorktreeId: string } }): string {
  const branch = created.record.expectedBranch
  return branch || `kata-agent/${created.record.managedWorktreeId.slice(-8)}`
}

export function createManagedKatacodeWorktreeAllocator(input: {
  readonly git: GitServices
  readonly workspaceRoot: string
  readonly workspaceName: string
}): KatacodeWorktreeAllocator {
  const { git, workspaceRoot, workspaceName } = input
  const sharedLeases = new Map<string, string>()
  return {
    async allocateIsolated(request) {
      const ctx = await git.repository.getContext(workspaceRoot)
      if (!ctx.isGitRepository || !ctx.repositoryRoot || !ctx.gitCommonDir) {
        throw new KatacodeRepositoryResolutionError('Workspace is not a Git repository')
      }
      if (!matchesRepositoryLabel(request.repositoryLabel, workspaceName, ctx.repositoryRoot, ctx.remotes)) {
        throw new KatacodeRepositoryResolutionError(`Unknown repository label: ${request.repositoryLabel}`)
      }
      const created = await git.worktrees.createWorktree({
        workspaceId: request.workspaceId,
        sessionId: request.ownerSessionId,
        repositoryRoot: ctx.repositoryRoot,
        gitCommonDir: ctx.gitCommonDir,
        baseRef: ctx.defaultRef ?? ctx.currentBranch ?? 'HEAD',
        ...(isWorktreeV2Enabled()
          ? {
            worktreeNameSuffix: `task-${request.ownerTaskId.replace(/[^a-zA-Z0-9]/g, '').slice(-12) || 'katacode'}`,
          }
          : {}),
      })
      return {
        managedWorktreeId: created.record.managedWorktreeId,
        summary: {
          policy: 'isolated',
          repositoryLabel: request.repositoryLabel,
          branchLabel: branchLabel(created),
        },
      } satisfies KatacodeWorktreeAllocation
    },

    async acquireSharedLease(request) {
      const record = await git.registry.get(request.managedWorktreeId)
      if (!record || record.state !== 'ready') {
        throw new KatacodeRepositoryResolutionError('Shared worktree is not ready')
      }
      if (record.workspaceId && record.workspaceId !== request.workspaceId) {
        throw new KatacodeRepositoryResolutionError('Shared worktree belongs to another workspace')
      }
      await git.pathLeases.lease(request.ownerTaskId, record.checkoutPath)
      sharedLeases.set(request.ownerTaskId, record.checkoutPath)
      return {
        managedWorktreeId: record.managedWorktreeId,
        summary: {
          policy: 'shared',
          repositoryLabel: request.repositoryLabel,
          branchLabel: record.expectedBranch || 'HEAD',
        },
        leaseId: request.ownerTaskId,
      } satisfies KatacodeWorktreeAllocation
    },

    release({ ownerTaskId }) {
      const checkoutPath = sharedLeases.get(ownerTaskId)
      if (!checkoutPath) return
      git.pathLeases.release(ownerTaskId, checkoutPath)
      sharedLeases.delete(ownerTaskId)
    },
  }
}
