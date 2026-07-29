/**
 * ManagedWorktreeService — create, own, inspect, and remove managed worktrees.
 *
 * Worktree directories live beneath the owning server's Kata config root, never
 * inside the repository:
 *   <worktreeRoot>/<workspace-id>/<repo-key>/<token>/
 * `repo-key` is the first 16 hex of SHA-256 over the normalized real Git
 * common-directory path; `token` is 8 hex chars shared by the path and the
 * `kata-agent/<token>` branch. Mutations serialize by Git common directory.
 */

import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { join, relative, isAbsolute, resolve as resolvePath } from 'node:path'
import type {
  ManagedWorktreeRecord,
  WorktreeIncludeResult,
  WorktreeRemovalRisk,
  WorktreeRemovalResult,
} from '@kata-sh/shared/protocol'
import { runGit, GitCommandError } from './command-runner'
import { RepositoryService } from './repository-service'
import { MutationLock } from './mutation-lock'
import { WorktreeRegistry, computeRepoKey, generateToken, removeDir } from './worktree-registry'
import { applyWorktreeInclude } from './worktree-include'

const MAX_TOKEN_RETRIES = 5

export class WorktreeCreationError extends Error {
  readonly code: string
  constructor(message: string, code = 'WORKTREE_CREATE_FAILED') {
    super(message)
    this.name = 'WorktreeCreationError'
    this.code = code
  }
}

export interface CreateWorktreeParams {
  workspaceId: string
  sessionId: string
  repositoryRoot: string
  gitCommonDir: string
  baseRef: string
}

export interface CreateWorktreeResult {
  record: ManagedWorktreeRecord
  include: WorktreeIncludeResult
}

export class ManagedWorktreeService {
  constructor(
    private readonly worktreeRoot: string,
    private readonly registry: WorktreeRegistry,
    private readonly repositoryService: RepositoryService,
    private readonly mutationLock: MutationLock,
  ) {}

  getRegistry(): WorktreeRegistry {
    return this.registry
  }

  getOwnerCount(id: string): number {
    return this.registry.getOwnerCount(id)
  }

  /** True when `path` is contained within the configured worktree root. */
  isUnderWorktreeRoot(path: string): boolean {
    const root = resolvePath(this.worktreeRoot)
    const p = resolvePath(path)
    const rel = relative(root, p)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  }

  /**
   * Create a managed worktree and its temporary `kata-agent/<token>` branch.
   * Serializes by Git common directory. On failure, cleans up a still-clean
   * provisional worktree/branch; if cleanup fails the registry record is left
   * `blocked` for explicit recovery.
   */
  async createWorktree(params: CreateWorktreeParams): Promise<CreateWorktreeResult> {
    const { workspaceId, sessionId, repositoryRoot, gitCommonDir, baseRef } = params

    // Validate base ref exists before taking the lock.
    await this.assertRefExists(repositoryRoot, baseRef)

    return this.mutationLock.withLock(gitCommonDir, async () => {
      const realCommonDir = safeRealpath(gitCommonDir)
      const repoKey = computeRepoKey(realCommonDir)

      let lastError: unknown
      for (let attempt = 0; attempt < MAX_TOKEN_RETRIES; attempt++) {
        const token = generateToken()
        const branch = `kata-agent/${token}`
        const worktreePath = join(this.worktreeRoot, workspaceId, repoKey, token)

        // Collision check: both branch and path must be free.
        if (existsSync(worktreePath)) continue
        if (await this.branchExists(repositoryRoot, branch)) continue

        const managedWorktreeId = `${repoKey}-${token}`
        const provisional: ManagedWorktreeRecord = {
          managedWorktreeId,
          repositoryRoot: resolvePath(repositoryRoot),
          gitCommonDir: realCommonDir,
          checkoutPath: resolvePath(worktreePath),
          baseRef,
          expectedBranch: branch,
          createdAt: Date.now(),
          ownerSessionIds: [sessionId],
          state: 'preparing',
        }
        this.registry.upsert(provisional)

        try {
          mkdirSync(join(this.worktreeRoot, workspaceId, repoKey), { recursive: true })
          await runGit(['worktree', 'add', '-b', branch, worktreePath, baseRef], {
            cwd: repositoryRoot,
            timeoutMs: 120_000,
          })

          let include: WorktreeIncludeResult = {
            copiedFileCount: 0,
            skippedSymlinks: 0,
            totalBytes: 0,
          }
          try {
            include = await applyWorktreeInclude(repositoryRoot, worktreePath)
          } catch (includeErr) {
            // .worktreeinclude limit or copy failure: tear down the still-clean
            // worktree and surface the error.
            await this.cleanupProvisional(repositoryRoot, worktreePath, branch, managedWorktreeId)
            throw includeErr
          }

          const ready: ManagedWorktreeRecord = { ...provisional, checkoutPath: safeRealpath(worktreePath), state: 'ready' }
          this.registry.upsert(ready)
          return { record: ready, include }
        } catch (err) {
          if (err instanceof GitCommandError) {
            // If the branch/path already existed, retry with a new token.
            const retryable = /already exists|already checked out|is already used/i.test(err.stderr)
            await this.cleanupProvisional(repositoryRoot, worktreePath, branch, managedWorktreeId)
            if (retryable) {
              lastError = err
              continue
            }
          }
          throw err
        }
      }

      throw new WorktreeCreationError(
        `Failed to create a managed worktree after ${MAX_TOKEN_RETRIES} attempts${lastError instanceof Error ? `: ${lastError.message}` : ''}`,
        'WORKTREE_TOKEN_COLLISION',
      )
    })
  }

  addOwner(managedWorktreeId: string, sessionId: string): void {
    this.registry.addOwner(managedWorktreeId, sessionId)
  }

  removeOwner(managedWorktreeId: string, sessionId: string): void {
    this.registry.removeOwner(managedWorktreeId, sessionId)
  }

  /** Inspect removal risk for a worktree from the perspective of a session. */
  async inspectRemoval(
    managedWorktreeId: string,
    requestingSessionId: string,
  ): Promise<WorktreeRemovalRisk> {
    const rec = this.registry.get(managedWorktreeId)
    if (!rec) {
      return {
        managedWorktreeId,
        exists: false,
        ownerSessionIds: [],
        otherOwnerCount: 0,
        uncommittedFileCount: 0,
        unpushedCommitCount: 0,
        branchHasUniqueWork: false,
        blocked: false,
      }
    }

    const otherOwners = rec.ownerSessionIds.filter((s) => s !== requestingSessionId)
    const exists = existsSync(rec.checkoutPath)

    let uncommittedFileCount = 0
    let unpushedCommitCount = 0
    let branchHasUniqueWork = false
    if (exists) {
      try {
        const status = await this.repositoryService.getStatus(rec.checkoutPath)
        uncommittedFileCount = status.entries.length
      } catch {
        /* ignore */
      }
      if (rec.baseRef) {
        unpushedCommitCount = await this.repositoryService.countCommitsAhead(
          rec.checkoutPath,
          rec.baseRef,
        )
        branchHasUniqueWork = unpushedCommitCount > 0
      }
    }

    const blocked = otherOwners.length > 0
    return {
      managedWorktreeId,
      exists,
      ownerSessionIds: rec.ownerSessionIds,
      otherOwnerCount: otherOwners.length,
      uncommittedFileCount,
      unpushedCommitCount,
      branchHasUniqueWork,
      blocked,
      blockedReason: blocked ? 'Another session still owns this worktree.' : undefined,
    }
  }

  /**
   * Remove a managed worktree. Blocked while another session owns it. The
   * temporary branch is pruned only when it has no unique work. Destructive
   * removal (uncommitted/unique work) requires `force`.
   */
  async removeWorktree(
    managedWorktreeId: string,
    requestingSessionId: string,
    options?: { force?: boolean },
  ): Promise<WorktreeRemovalResult> {
    const rec = this.registry.get(managedWorktreeId)
    if (!rec) {
      return { removed: false, branchPruned: false, blocked: false }
    }

    const risk = await this.inspectRemoval(managedWorktreeId, requestingSessionId)
    if (risk.blocked) {
      return {
        removed: false,
        branchPruned: false,
        blocked: true,
        blockedReason: risk.blockedReason,
      }
    }
    if (!options?.force && (risk.uncommittedFileCount > 0 || risk.branchHasUniqueWork)) {
      return {
        removed: false,
        branchPruned: false,
        blocked: true,
        blockedReason:
          'Worktree has uncommitted or unique work. Confirm destructive removal to proceed.',
      }
    }

    return this.mutationLock.withLock(rec.gitCommonDir, async () => {
      this.registry.setState(managedWorktreeId, 'removing')
      // Remove the worktree registration + directory.
      try {
        await runGit(['worktree', 'remove', '--force', rec.checkoutPath], {
          cwd: rec.repositoryRoot,
          okExitCodes: [128],
        })
      } catch {
        /* fall through to manual cleanup */
      }
      removeDir(rec.checkoutPath)
      try {
        await runGit(['worktree', 'prune'], { cwd: rec.repositoryRoot, okExitCodes: [128] })
      } catch {
        /* ignore */
      }

      // Prune the temporary branch only when it has no unique work.
      let branchPruned = false
      if (!risk.branchHasUniqueWork) {
        try {
          const res = await runGit(['branch', '-D', rec.expectedBranch], {
            cwd: rec.repositoryRoot,
            okExitCodes: [1, 128],
          })
          branchPruned = res.exitCode === 0
        } catch {
          /* ignore */
        }
      }

      this.registry.remove(managedWorktreeId)
      return { removed: true, branchPruned, blocked: false }
    })
  }

  private async cleanupProvisional(
    repositoryRoot: string,
    worktreePath: string,
    branch: string,
    managedWorktreeId: string,
  ): Promise<void> {
    let clean = true
    try {
      await runGit(['worktree', 'remove', '--force', worktreePath], {
        cwd: repositoryRoot,
        okExitCodes: [128],
      })
    } catch {
      clean = false
    }
    if (!removeDir(worktreePath)) clean = false
    try {
      await runGit(['worktree', 'prune'], { cwd: repositoryRoot, okExitCodes: [128] })
    } catch {
      /* ignore */
    }
    try {
      await runGit(['branch', '-D', branch], { cwd: repositoryRoot, okExitCodes: [1, 128] })
    } catch {
      clean = false
    }
    if (clean) {
      this.registry.remove(managedWorktreeId)
    } else {
      // Retain a blocked registry record for explicit recovery.
      this.registry.setState(managedWorktreeId, 'blocked')
    }
  }

  private async assertRefExists(repositoryRoot: string, ref: string): Promise<void> {
    try {
      const res = await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
        cwd: repositoryRoot,
        okExitCodes: [1],
      })
      if (res.exitCode !== 0) {
        throw new WorktreeCreationError(`Base ref "${ref}" not found.`, 'BASE_REF_NOT_FOUND')
      }
    } catch (err) {
      if (err instanceof WorktreeCreationError) throw err
      throw new WorktreeCreationError(`Base ref "${ref}" could not be resolved.`, 'BASE_REF_NOT_FOUND')
    }
  }

  private async branchExists(repositoryRoot: string, branch: string): Promise<boolean> {
    try {
      const res = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
        cwd: repositoryRoot,
        okExitCodes: [1],
      })
      return res.exitCode === 0
    } catch {
      return false
    }
  }
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolvePath(p)
  }
}
