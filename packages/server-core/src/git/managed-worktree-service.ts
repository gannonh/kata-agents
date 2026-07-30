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
  SessionCheckoutV1,
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

/**
 * Requesting-session placeholder for reconciliation-driven removal. Only records
 * with no live owners are reclaimed, so the ownership guard in `inspectRemoval`
 * (which excludes the requester from the other-owner count) sees an empty owner
 * set either way — this identifies the actor without impersonating a session.
 */
const RECONCILE_ACTOR = '__reconcile__'

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

export interface ReconcileParams {
  /** IDs of sessions that currently exist (persisted). */
  knownSessionIds: Set<string>
  /**
   * Persisted checkout metadata by session ID, used to repair derivable owner
   * references (a session whose checkout points at a worktree it no longer
   * owns in the registry).
   */
  sessionCheckouts?: Map<string, SessionCheckoutV1>
}

export interface ReconcileReport {
  recordsInspected: number
  /** Owner references removed because the owning session no longer exists. */
  droppedOwnerRefs: number
  /** Owner references restored from persisted session checkout metadata. */
  repairedOwnerRefs: number
  /** Records marked `missing` (checkout absent from disk and Git). */
  markedMissing: number
  /** Records marked `blocked` (ambiguous state that must not be auto-deleted). */
  markedBlocked: number
  /** Unowned, clean checkouts reclaimed (removed with their temporary branch). */
  reclaimedUnowned: number
  /** Unowned checkouts retained because they still hold work. */
  retainedUnownedWithWork: number
}

/** A single entry from `git worktree list --porcelain`. */
export interface WorktreeListEntry {
  path: string
  /** Short branch name, or null when detached. */
  branch: string | null
}

/**
 * Parse `git worktree list --porcelain` output into path/branch entries.
 * Records are separated by a blank line; each has a `worktree <path>` line and
 * either a `branch refs/heads/<name>` line or a `detached` line.
 */
export function parseWorktreeListPorcelain(output: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = []
  let current: { path: string; branch: string | null } | null = null
  for (const raw of output.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current)
      current = { path: line.slice('worktree '.length).trim(), branch: null }
    } else if (line.startsWith('branch ') && current) {
      const full = line.slice('branch '.length).trim()
      current.branch = full.startsWith('refs/heads/') ? full.slice('refs/heads/'.length) : full
    }
    // `detached` leaves branch null; other lines (HEAD/bare/locked) are ignored.
  }
  if (current) entries.push(current)
  return entries
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
   *
   * `options.dryRun` runs every guard — ownership, the `force` requirement, and
   * identity revalidation — and returns the identical blocked result without
   * touching the worktree, registry, or branch. Session deletion uses it to
   * decide *before* it deletes anything that removal will be allowed, so a
   * blocked removal can never leave a deleted session or an orphaned checkout
   * behind (spec: AC18–AC19).
   */
  async removeWorktree(
    managedWorktreeId: string,
    requestingSessionId: string,
    options?: { force?: boolean; dryRun?: boolean },
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

    // Identity revalidation: never delete a checkout unless it is a genuine
    // managed worktree under the Kata worktree root, on the expected branch,
    // and sharing the recorded Git common directory. A `force` flag governs
    // uncommitted/unique work — it does NOT bypass identity safety.
    const identity = await this.validateRemovalIdentity(rec)
    if (!identity.ok) {
      return {
        removed: false,
        branchPruned: false,
        blocked: true,
        blockedReason: identity.reason,
      }
    }

    // Every guard passed. A dry run stops here, reporting that removal would be
    // allowed without performing it.
    if (options?.dryRun) {
      return { removed: false, branchPruned: false, blocked: false }
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

  /**
   * Startup reconciliation. Compares registry records against persisted session
   * ownership and the live `git worktree list --porcelain` for each repository.
   *
   * - Drops owner references for sessions that no longer exist.
   * - Repairs derivable owner references from persisted session checkout metadata.
   * - Marks a record `missing` when its checkout is absent from disk and Git.
   * - Marks a record `blocked` when the on-disk branch diverges from the expected
   *   branch (ambiguous external change).
   *
   * Never deletes a registry record or a checkout directory; ambiguous state is
   * left for explicit recovery.
   */
  async reconcile(params: ReconcileParams): Promise<ReconcileReport> {
    const report: ReconcileReport = {
      recordsInspected: 0,
      droppedOwnerRefs: 0,
      repairedOwnerRefs: 0,
      markedMissing: 0,
      markedBlocked: 0,
      reclaimedUnowned: 0,
      retainedUnownedWithWork: 0,
    }
    const records = this.registry.list()
    report.recordsInspected = records.length
    if (records.length === 0) return report

    // Cache `git worktree list` per repository root so we run it once per repo.
    const worktreeListCache = new Map<string, Map<string, WorktreeListEntry>>()
    const getWorktreeList = async (
      repositoryRoot: string,
    ): Promise<Map<string, WorktreeListEntry> | null> => {
      if (worktreeListCache.has(repositoryRoot)) {
        return worktreeListCache.get(repositoryRoot)!
      }
      try {
        const res = await runGit(['worktree', 'list', '--porcelain'], {
          cwd: repositoryRoot,
          okExitCodes: [128],
        })
        if (res.exitCode !== 0) {
          worktreeListCache.set(repositoryRoot, new Map())
          return null
        }
        const byPath = new Map<string, WorktreeListEntry>()
        for (const entry of parseWorktreeListPorcelain(res.stdout)) {
          byPath.set(resolvePath(entry.path), entry)
          byPath.set(safeRealpath(entry.path), entry)
        }
        worktreeListCache.set(repositoryRoot, byPath)
        return byPath
      } catch {
        worktreeListCache.set(repositoryRoot, new Map())
        return null
      }
    }

    for (const rec of records) {
      // 1. Drop dead owner references.
      const beforeOwners = rec.ownerSessionIds.length
      const liveOwners = rec.ownerSessionIds.filter((s) => params.knownSessionIds.has(s))
      report.droppedOwnerRefs += beforeOwners - liveOwners.length

      // 2. Repair derivable owner references from persisted session checkouts.
      if (params.sessionCheckouts) {
        for (const [sessionId, checkout] of params.sessionCheckouts) {
          if (
            checkout.managedWorktreeId === rec.managedWorktreeId &&
            params.knownSessionIds.has(sessionId) &&
            !liveOwners.includes(sessionId)
          ) {
            liveOwners.push(sessionId)
            report.repairedOwnerRefs += 1
          }
        }
      }
      if (liveOwners.length !== beforeOwners || report.repairedOwnerRefs > 0) {
        rec.ownerSessionIds = liveOwners
      }

      // 3. Compare against disk + git worktree list.
      const worktreePresentOnDisk = existsSync(rec.checkoutPath)
      const list = await getWorktreeList(rec.repositoryRoot)
      const listedEntry =
        list?.get(resolvePath(rec.checkoutPath)) ?? list?.get(safeRealpath(rec.checkoutPath))

      let nextState = rec.state
      if (!worktreePresentOnDisk && !listedEntry) {
        nextState = 'missing'
        report.markedMissing += 1
      } else if (listedEntry && listedEntry.branch && listedEntry.branch !== rec.expectedBranch) {
        // The checkout exists but is on an unexpected branch — ambiguous.
        nextState = 'blocked'
        report.markedBlocked += 1
      } else if (worktreePresentOnDisk && !listedEntry) {
        // On disk but not a registered worktree — ambiguous, do not touch it.
        nextState = 'blocked'
        report.markedBlocked += 1
      } else if (listedEntry && rec.state !== 'ready') {
        // Healthy again after being marked missing/preparing.
        nextState = 'ready'
      }
      rec.state = nextState
      this.registry.upsert(rec)

      // Reclaim leaked checkouts. A record with no live owners can no longer be
      // reached through any session, and nothing else removes one — so without
      // this it would sit on disk forever. Reachable when the removal step of a
      // session deletion is blocked or interrupted after the session is already
      // gone (see the deletion ordering in SessionManager).
      //
      // `removeWorktree` is reused rather than reimplemented so identity safety
      // cannot diverge between the two callers, and `force` is deliberately NOT
      // passed: that guard is exactly what separates a clean leak from a
      // checkout still holding work. Records already `blocked` or `missing` are
      // skipped by the `ready` condition.
      if (liveOwners.length === 0 && nextState === 'ready') {
        const result = await this.removeWorktree(rec.managedWorktreeId, RECONCILE_ACTOR)
        if (result.removed) {
          report.reclaimedUnowned += 1
        } else {
          // Never removed silently: the work stays on disk and the record is
          // marked so the state is visible rather than inferred from a
          // directory nobody can reach.
          report.retainedUnownedWithWork += 1
          rec.state = 'blocked'
          this.registry.upsert(rec)
        }
      }
    }

    return report
  }

  /**
   * Revalidate a managed-worktree record before deletion. The checkout must be
   * contained under the configured Kata worktree root; when it still exists on
   * disk it must be a live worktree of the recorded Git common directory and on
   * the expected `kata-agent/<token>` branch. A checkout already gone from disk
   * is safe to reconcile away (registry + branch prune only).
   */
  private async validateRemovalIdentity(
    rec: ManagedWorktreeRecord,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!this.isUnderWorktreeRoot(rec.checkoutPath)) {
      return {
        ok: false,
        reason: 'Refusing to remove a checkout outside the Kata managed-worktree root.',
      }
    }
    if (!existsSync(rec.checkoutPath)) {
      // Nothing to delete on disk; registry cleanup / branch prune only.
      return { ok: true }
    }
    let ctx
    try {
      ctx = await this.repositoryService.getContext(rec.checkoutPath)
    } catch {
      return { ok: false, reason: 'Unable to verify the worktree identity before removal.' }
    }
    if (!ctx.isGitRepository || !ctx.gitCommonDir) {
      return { ok: false, reason: 'Checkout path is not a Git worktree; refusing removal.' }
    }
    if (safeRealpath(ctx.gitCommonDir) !== safeRealpath(rec.gitCommonDir)) {
      return {
        ok: false,
        reason: 'Worktree Git common directory does not match the recorded repository.',
      }
    }
    if (ctx.currentBranch !== rec.expectedBranch) {
      return {
        ok: false,
        reason: `Worktree is on an unexpected branch (${ctx.currentBranch ?? 'detached'} != ${rec.expectedBranch}); refusing removal.`,
      }
    }
    return { ok: true }
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
