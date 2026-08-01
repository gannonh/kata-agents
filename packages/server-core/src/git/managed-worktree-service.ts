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

import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { join, relative, isAbsolute, resolve as resolvePath } from 'node:path'
import { createHash } from 'node:crypto'
import type {
  GitWorkingTreeEntry,
  ManagedWorktreeRecord,
  SessionCheckoutV1,
  WorktreeRemovalConfirmation,
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

function matchesRemovalConfirmation(
  risk: WorktreeRemovalRisk,
  confirmation: WorktreeRemovalConfirmation,
): boolean {
  return (
    risk.uncommittedFileCount === confirmation.uncommittedFileCount &&
    risk.unpushedCommitCount === confirmation.unpushedCommitCount &&
    risk.branchHasUniqueWork === confirmation.branchHasUniqueWork &&
    risk.confirmationFingerprint === confirmation.confirmationFingerprint
  )
}

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
    // Git may report macOS temporary paths through /private/var while the
    // configured root was created through /var. Canonicalize both sides before
    // containment checks so the safety guard does not reject its own checkout.
    const root = safeRealpath(this.worktreeRoot)
    const p = safeRealpath(path)
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
    const rec = this.registry.get(managedWorktreeId)
    if (!rec) {
      throw new Error('Managed worktree record not found.')
    }
    if (rec.state !== 'ready') {
      throw new Error(`Managed worktree cannot add an owner while it is ${rec.state}.`)
    }
    this.registry.addOwner(managedWorktreeId, sessionId)
  }

  removeOwner(managedWorktreeId: string, sessionId: string): void {
    this.registry.removeOwner(managedWorktreeId, sessionId)
  }

  /**
   * Bind destructive confirmation to the exact work the server inspected.
   *
   * Aggregate counts are only display copy: a different dirty file or commit
   * can replace the displayed work without changing either count. This digest
   * includes checkout identity, live HEAD/branch, each dirty path and its exact
   * index + working-tree state, and every commit unique to the persisted base
   * ref.
   */
  private async createRemovalConfirmationFingerprint(
    rec: ManagedWorktreeRecord,
    entries: GitWorkingTreeEntry[],
    ignoredPaths: string[],
  ): Promise<string> {
    const hash = createHash('sha256')
    hash.update('kata-worktree-removal-v1\0')
    hash.update(
      `${rec.managedWorktreeId}\0${rec.checkoutPath}\0${rec.gitCommonDir}\0${rec.expectedBranch}\0${rec.baseRef ?? ''}\0`,
    )

    const repositoryIdentity = await runGit(
      ['rev-parse', '--show-toplevel', '--git-common-dir'],
      { cwd: rec.checkoutPath },
    )
    const headIdentity = await runGit(['rev-parse', 'HEAD'], { cwd: rec.checkoutPath })
    const branchIdentity = await runGit(['symbolic-ref', '--quiet', 'HEAD'], {
      cwd: rec.checkoutPath,
      okExitCodes: [1],
    })
    hash.update(repositoryIdentity.stdout)
    hash.update(headIdentity.stdout)
    hash.update(branchIdentity.stdout)
    hash.update('\0')

    // Bind the complete index, not only paths surfaced by the HEAD→working-tree
    // Changes view. This catches staged-only substitutions and preserves
    // unmerged stage entries and executable/symlink modes.
    const indexState = await runGit(['ls-files', '--stage', '-z'], {
      cwd: rec.checkoutPath,
    })
    hash.update(indexState.stdout)
    hash.update('\0')

    const orderedEntries = [...entries].sort((a, b) => {
      const pathOrder = a.path.localeCompare(b.path)
      if (pathOrder !== 0) return pathOrder
      return (a.previousPath ?? '').localeCompare(b.previousPath ?? '')
    })
    for (const entry of orderedEntries) {
      hash.update(
        `${entry.path}\0${entry.previousPath ?? ''}\0${entry.type}\0${entry.indexState ?? ''}\0${entry.worktreeState ?? ''}\0${entry.conflicted ? '1' : '0'}\0`,
      )
      const absolutePath = join(rec.checkoutPath, entry.path)
      try {
        hash.update(lstatSync(absolutePath).mode.toString(8))
        hash.update('\0')
        const object = await runGit(
          ['hash-object', '--no-filters', '--', entry.path],
          { cwd: rec.checkoutPath },
        )
        hash.update(object.stdout.trim())
      } catch (err) {
        if (
          !(err instanceof Error) ||
          !('code' in err) ||
          (err as NodeJS.ErrnoException).code !== 'ENOENT'
        ) {
          throw err
        }
      }
      hash.update('\0')
    }

    // `git status` deliberately omits ignored files, but managed checkouts can
    // contain them through `.worktreeinclude`, tools, or direct user writes.
    // They are still work that a forced directory removal would destroy, so
    // inventory their paths, modes, and content separately from status entries.
    for (const ignoredPath of [...ignoredPaths].sort()) {
      hash.update(`ignored\0${ignoredPath}\0`)
      const absolutePath = join(rec.checkoutPath, ignoredPath)
      try {
        hash.update(lstatSync(absolutePath).mode.toString(8))
        hash.update('\0')
        const object = await runGit(
          ['hash-object', '--no-filters', '--', ignoredPath],
          { cwd: rec.checkoutPath },
        )
        hash.update(object.stdout.trim())
      } catch (err) {
        if (
          !(err instanceof Error) ||
          !('code' in err) ||
          (err as NodeJS.ErrnoException).code !== 'ENOENT'
        ) {
          throw err
        }
      }
      hash.update('\0')
    }

    if (rec.baseRef) {
      const uniqueCommits = await runGit(
        ['rev-list', '--reverse', `${rec.baseRef}..HEAD`],
        { cwd: rec.checkoutPath },
      )
      hash.update(uniqueCommits.stdout)
    }

    return hash.digest('hex')
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
        confirmationFingerprint: createHash('sha256')
          .update(`kata-worktree-removal-v1\0missing\0${managedWorktreeId}`)
          .digest('hex'),
        blocked: false,
      }
    }

    const otherOwners = rec.ownerSessionIds.filter((s) => s !== requestingSessionId)
    const exists = existsSync(rec.checkoutPath)

    let uncommittedFileCount = 0
    let unpushedCommitCount = 0
    let branchHasUniqueWork = false
    let confirmationFingerprint = createHash('sha256')
      .update(`kata-worktree-removal-v1\0absent\0${managedWorktreeId}`)
      .digest('hex')
    if (exists) {
      const status = await this.repositoryService.getStatus(rec.checkoutPath, { strict: true })
      const ignoredFiles = await runGit(
        ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'],
        { cwd: rec.checkoutPath },
      )
      const ignoredPaths = ignoredFiles.stdout.split('\0').filter(Boolean)
      uncommittedFileCount = status.entries.length + ignoredPaths.length
      if (rec.baseRef) {
        unpushedCommitCount = await this.repositoryService.countCommitsAhead(
          rec.checkoutPath,
          rec.baseRef,
        )
        branchHasUniqueWork = unpushedCommitCount > 0
      }
      confirmationFingerprint = await this.createRemovalConfirmationFingerprint(
        rec,
        status.entries,
        ignoredPaths,
      )
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
      confirmationFingerprint,
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
    options?: {
      force?: boolean
      dryRun?: boolean
      expectedConfirmation?: WorktreeRemovalConfirmation
    },
  ): Promise<WorktreeRemovalResult> {
    const rec = this.registry.get(managedWorktreeId)
    if (!rec) {
      return { removed: false, branchPruned: false, blocked: false }
    }

    return this.mutationLock.withLock(rec.gitCommonDir, async () => {
      // Validate static containment/common-directory/branch expectations before
      // taking the authoritative content snapshot. No awaited identity check
      // may run after that snapshot: an external write during such a gap would
      // otherwise be absent from the confirmation and still get deleted.
      const identity = await this.validateRemovalIdentity(rec)
      if (!identity.ok) {
        return {
          removed: false,
          branchPruned: false,
          blocked: true,
          blockedReason: `The worktree could not be inspected safely: ${identity.reason}`,
        }
      }

      // This is the final awaited guard before removal starts. A session-delete
      // dry run or dialog inspection may have happened earlier.
      let risk: WorktreeRemovalRisk
      try {
        risk = await this.inspectRemoval(managedWorktreeId, requestingSessionId)
      } catch (err) {
        return {
          removed: false,
          branchPruned: false,
          blocked: true,
          blockedReason: `The worktree could not be inspected safely: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
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
      if (options?.force && !options.expectedConfirmation) {
        return {
          removed: false,
          branchPruned: false,
          blocked: true,
          blockedReason:
            'The worktree removal confirmation is missing. Inspect the worktree again before removing it.',
        }
      }
      if (
        options?.force &&
        options.expectedConfirmation &&
        !matchesRemovalConfirmation(risk, options.expectedConfirmation)
      ) {
        return {
          removed: false,
          branchPruned: false,
          blocked: true,
          blockedReason:
            'The worktree changed after the removal confirmation. Inspect it again before removing it.',
        }
      }

      // Ownership is mutable registry state and the authoritative inspection
      // performs async Git work. Re-read it synchronously after the last guard
      // await so an owner added during inspection cannot lose its checkout.
      const currentRecord = this.registry.get(managedWorktreeId)
      const currentOwners = currentRecord?.ownerSessionIds ?? []
      const currentOtherOwners = currentOwners.filter(
        owner => owner !== requestingSessionId,
      )
      const requesterStillOwns =
        requestingSessionId === RECONCILE_ACTOR ||
        currentOwners.includes(requestingSessionId)
      if (!currentRecord || !requesterStillOwns || currentOtherOwners.length > 0) {
        return {
          removed: false,
          branchPruned: false,
          blocked: true,
          blockedReason:
            currentOtherOwners.length > 0
              ? 'Another session still owns this worktree.'
              : 'Worktree ownership changed during removal. Inspect it again before removing it.',
        }
      }

      // Every guard passed. A dry run stops here, reporting that removal would
      // be allowed without performing it.
      if (options?.dryRun) {
        return { removed: false, branchPruned: false, blocked: false }
      }

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

      // Removal is only complete when the checkout is actually gone. Both the
      // git command and the manual fallback can fail — a locked worktree, a
      // permission problem, a process holding the directory — and neither
      // surfaces as a throw here.
      //
      // Dropping the registry record in that case would be the worst outcome
      // available: reconciliation reclaims leaked checkouts *from registry
      // records*, so a directory with no record is invisible to every recovery
      // path and leaks permanently. Keep the record, mark it for attention, and
      // report the failure honestly instead of claiming a removal that did not
      // happen. The temporary branch is left alone too — it is still checked out
      // in the surviving worktree.
      if (existsSync(rec.checkoutPath)) {
        this.registry.setState(managedWorktreeId, 'blocked')
        return {
          removed: false,
          branchPruned: false,
          blocked: true,
          blockedReason: `The checkout at ${rec.checkoutPath} could not be removed. It is still tracked, so it can be retried or cleaned up later.`,
        }
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
