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
import { isWorktreeV2Enabled } from '@kata-sh/shared/feature-flags'
import type {
  GitWorkingTreeEntry,
  ManagedWorktreeRecord,
  ManagedWorktreeRecordV2,
  ManagedWorktreeRecordVersioned,
  ManagedWorktreeSummary,
  ManagedWorktreeSummaryV2,
  ManagedWorktreeSummaryVersioned,
  SessionCheckout,
  WorktreeRemovalConfirmation,
  WorktreeIncludeResult,
  WorktreeRemovalRisk,
  WorktreeRemovalResult,
} from '@kata-sh/shared/protocol'
import { runGit, GitCommandError } from './command-runner'
import { RepositoryService } from './repository-service'
import { MutationLock } from './mutation-lock'
import {
  WorktreeRegistry,
  computeRepoKey,
  generateToken,
  removeDir,
  type WorktreeOwnerBindResult,
  type WorktreeRemovalBeginResult,
} from './worktree-registry'
import { applyWorktreeInclude } from './worktree-include'
import type { WorktreeSettingsSnapshot } from '@kata-sh/shared/protocol'

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

/**
 * Convert a user-controlled branch suffix into a path leaf fragment. The
 * branch/display name itself is never changed; this value is only a bounded,
 * path-safe hint combined with a random internal token.
 */
function filesystemSafeDisplayFragment(name: string): string {
  const fragment = name
    .normalize('NFC')
    .replace(/[\\/]+/g, '-')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '')
    .slice(0, 80)
  return fragment || 'worktree'
}

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
  /** V2 branch suffix/display name. Omitted for the exact V1 token flow. */
  worktreeNameSuffix?: string
}

export interface CreateWorktreeResult {
  /** V1 creation returns the legacy record shape; V2 returns the named record. */
  record: ManagedWorktreeRecord | ManagedWorktreeRecordV2
  include: WorktreeIncludeResult
}

interface ProvisionalCreation {
  worktreeCreated: boolean
  /** True only after this transaction observed that its requested branch was absent. */
  branchCreated: boolean
  /** Exact OID recorded immediately after this transaction created the branch. */
  createdBranchOid: string | null
}

export interface WorktreeRootProvider {
  /** Capture the root/version used by one materialization operation. */
  getSnapshot(): WorktreeSettingsSnapshot
  /** V1 fallback root when persisted V2 settings are ineffective. */
  getDefaultRoot?(): string
  /** Revalidate a captured policy against the selected source before creation. */
  validateForCreation?(snapshot: WorktreeSettingsSnapshot, repositoryRoot: string): void
}

export interface ReconcileParams {
  /** IDs of sessions that currently exist (persisted). */
  knownSessionIds: Set<string>
  /**
   * Persisted checkout metadata by session ID, used to repair derivable owner
   * references (a session whose checkout points at a worktree it no longer
   * owns in the registry).
   */
  sessionCheckouts?: Map<string, SessionCheckout>
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
  private readonly worktreeRootProvider: WorktreeRootProvider

  constructor(
    worktreeRoot: string | WorktreeRootProvider,
    private readonly registry: WorktreeRegistry,
    private readonly repositoryService: RepositoryService,
    private readonly mutationLock: MutationLock,
  ) {
    this.worktreeRootProvider = typeof worktreeRoot === 'string'
      ? {
          getSnapshot: () => ({
            schemaVersion: 1,
            serverId: 'local',
            version: 0,
            materializationRoot: resolvePath(worktreeRoot),
            capturedAt: Date.now(),
            autoDeleteEnabled: true,
            retentionLimit: 15,
          }),
          getDefaultRoot: () => resolvePath(worktreeRoot),
        }
      : worktreeRoot
  }

  getWorktreeRoot(): string {
    return this.getEffectiveRootSnapshot().materializationRoot
  }

  private getEffectiveRootSnapshot(): WorktreeSettingsSnapshot {
    if (isWorktreeV2Enabled()) return this.worktreeRootProvider.getSnapshot()
    const defaultRoot = this.worktreeRootProvider.getDefaultRoot?.()
    if (defaultRoot) {
      return {
        schemaVersion: 1,
        serverId: 'local',
        version: 0,
        materializationRoot: resolvePath(defaultRoot),
        capturedAt: Date.now(),
        autoDeleteEnabled: true,
        retentionLimit: 15,
      }
    }
    return this.worktreeRootProvider.getSnapshot()
  }

  getRegistry(): WorktreeRegistry {
    return this.registry
  }

  getOwnerCount(id: string): number {
    return this.registry.getOwnerCount(id)
  }

  /** True when `path` is contained within the configured worktree root. */
  isUnderWorktreeRoot(path: string, allowedRoot = this.getWorktreeRoot()): boolean {
    // Git may report macOS temporary paths through /private/var while the
    // configured root was created through /var. Canonicalize both sides before
    // containment checks so the safety guard does not reject its own checkout.
    // Never follow a root symlink here: a root swap must fail closed rather
    // than authorize a checkout in an unrelated destination.
    const rootPath = resolvePath(allowedRoot)
    if (this.isSymlink(rootPath)) return false
    const root = safeRealpath(rootPath)
    if (root !== rootPath) return false
    const p = safeRealpath(path)
    const rel = relative(root, p)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  }

  /**
   * Owning workspace of a registry record. Prefers the persisted field; legacy
   * records (persisted before `workspaceId` existed) derive it from the
   * `<worktreeRoot>/<workspace-id>/<repo-key>/<token>` layout.
   */
  workspaceIdOf(record: ManagedWorktreeRecordVersioned): string | null {
    if (record.workspaceId) return record.workspaceId
    const recordRoot = 'materializationRoot' in record
      ? record.materializationRoot
      : this.getWorktreeRoot()
    const rel = relative(safeRealpath(recordRoot), safeRealpath(record.checkoutPath))
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
    // `relative()` uses the platform separator: backslash-delimited paths on
    // Windows must split the same way or the whole relative path is returned.
    const firstSegment = rel.split(/[\\/]/)[0]
    return firstSegment || null
  }

  /**
   * Ready managed worktrees a new session in `workspaceId` may bind to: same
   * workspace AND same repository (by Git common directory) as the caller's
   * working directory. Worktrees from other workspaces or unrelated
   * repositories are never offered, and non-ready records (preparing/missing/
   * blocked/removing) are excluded so a session cannot attach to a checkout
   * that is not currently usable.
   */
  listManagedWorktrees(
    workspaceId: string,
    gitCommonDir: string,
    excludeWorktreeId?: string,
  ): ManagedWorktreeSummaryVersioned[] {
    const repoKey = computeRepoKey(safeRealpath(gitCommonDir))
    return this.registry
      .list()
      .filter(
        (rec) =>
          rec.state === 'ready' &&
          rec.managedWorktreeId !== excludeWorktreeId &&
          this.workspaceIdOf(rec) === workspaceId &&
          computeRepoKey(safeRealpath(rec.gitCommonDir)) === repoKey,
      )
      .map((rec): ManagedWorktreeSummaryVersioned => {
        const legacy: ManagedWorktreeSummary = {
          managedWorktreeId: rec.managedWorktreeId,
          checkoutPath: rec.checkoutPath,
          expectedBranch: rec.expectedBranch,
          baseRef: rec.baseRef,
          ownerCount: rec.ownerSessionIds.length,
          state: rec.state,
        }
        const versioned = rec as unknown as ManagedWorktreeRecord | ManagedWorktreeRecordV2
        // The fixed registry upgrades legacy records to V2 storage, but V1
        // discovery must retain its exact public summary until V2 is effective.
        if (!isWorktreeV2Enabled() || versioned.schemaVersion !== 2) return legacy

        const v2 = versioned
        const summary: ManagedWorktreeSummaryV2 = {
          schemaVersion: 2,
          managedWorktreeId: v2.managedWorktreeId,
          checkoutPath: v2.checkoutPath,
          displayName: v2.displayName,
          expectedBranch: v2.expectedBranch,
          materializationRoot: v2.materializationRoot,
          baseRef: v2.baseRef,
          ownerCount: v2.ownerSessionIds.length,
          state: v2.state,
        }
        return summary
      })
  }

  /**
   * Create a managed worktree and its branch. V1 uses the generated
   * `kata-agent/<token>` identity; V2 uses the exact requested
   * `kata-agent/<name>` identity and a separate random path token.
   * Serializes by Git common directory. On failure, compensation removes only
   * artifacts recorded as created by this transaction; if compensation cannot
   * prove ownership, the registry record is left `blocked` for recovery.
   */
  async createWorktree(params: CreateWorktreeParams): Promise<CreateWorktreeResult> {
    const {
      workspaceId,
      sessionId,
      repositoryRoot,
      gitCommonDir,
      baseRef,
      worktreeNameSuffix,
    } = params
    const named = worktreeNameSuffix !== undefined
    if (named && typeof worktreeNameSuffix !== 'string') {
      throw new WorktreeCreationError(
        'Worktree name must be a string.',
        'WORKTREE_NAME_INVALID',
      )
    }
    if (named && !isWorktreeV2Enabled()) {
      throw new WorktreeCreationError(
        'Git worktree V2 capability is unavailable on this server.',
        'GIT_WORKTREE_V2_UNAVAILABLE',
      )
    }

    // Validate base ref exists before taking the lock.
    await this.assertRefExists(repositoryRoot, baseRef)

    return this.mutationLock.withLock(gitCommonDir, async () => {
      // Capture one immutable root snapshot before deriving the destination.
      // A later settings update affects only subsequent materializations.
      const rootSnapshot = this.getEffectiveRootSnapshot()
      if (isWorktreeV2Enabled()) {
        this.worktreeRootProvider.validateForCreation?.(rootSnapshot, repositoryRoot)
      }
      // Snapshots are already canonicalized by the settings provider. Keep
      // this path lexical until the no-follow destination validation runs so a
      // root replaced by a symlink cannot be silently followed.
      const materializationRoot = resolvePath(rootSnapshot.materializationRoot)
      const realCommonDir = safeRealpath(gitCommonDir)
      const repoKey = computeRepoKey(realCommonDir)
      const requestedBranch = named ? `kata-agent/${worktreeNameSuffix}` : null
      if (requestedBranch) {
        // Validate the requested identity before creating any destination
        // directories, then repeat the check immediately before Git mutation.
        await this.assertNamedBranchAvailable(repositoryRoot, requestedBranch)
      }
      if (!workspaceId || workspaceId === '.' || workspaceId === '..' || /[\\/]/.test(workspaceId)) {
        throw new WorktreeCreationError(
          'Managed-worktree workspace identity is not a safe path component.',
          'WORKTREE_DESTINATION_UNSAFE',
        )
      }
      const destinationRoot = this.prepareDestinationRoot(materializationRoot, workspaceId, repoKey)
      const displayFragment = named
        ? filesystemSafeDisplayFragment(worktreeNameSuffix!)
        : null

      let lastError: unknown
      for (let attempt = 0; attempt < MAX_TOKEN_RETRIES; attempt++) {
        const token = generateToken()
        const branch = requestedBranch ?? `kata-agent/${token}`
        const leaf = displayFragment ? `${displayFragment}-${token}` : token
        const worktreePath = join(destinationRoot, leaf)

        // Collision check: both branch and path must be free. A broken
        // symlink is also occupied: never let Git follow it outside the root.
        if (existsSync(worktreePath) || this.isSymlink(worktreePath)) continue
        if (!named && (await this.branchExists(repositoryRoot, branch))) continue
        if (named) {
          // Another writer may be using Git directly rather than Kata's lock;
          // recheck the requested ref immediately before recording a
          // provisional transaction. A requested branch collision is visible,
          // never silently renamed to another branch.
          await this.assertNamedBranchAvailable(repositoryRoot, branch)
        }

        const managedWorktreeId = `${repoKey}-${token}`
        const createdAt = Date.now()
        const provisional: ManagedWorktreeRecord | ManagedWorktreeRecordV2 = named
          ? {
              schemaVersion: 2,
              managedWorktreeId,
              workspaceId,
              repositoryRoot: resolvePath(repositoryRoot),
              gitCommonDir: realCommonDir,
              checkoutPath: resolvePath(worktreePath),
              baseRef,
              expectedBranch: branch,
              displayName: worktreeNameSuffix!,
              materializationRoot,
              createdAt,
              lastUsedAt: createdAt,
              ownerSessionIds: [sessionId],
              state: 'preparing',
            }
          : {
              managedWorktreeId,
              workspaceId,
              repositoryRoot: resolvePath(repositoryRoot),
              gitCommonDir: realCommonDir,
              checkoutPath: resolvePath(worktreePath),
              baseRef,
              expectedBranch: branch,
              createdAt,
              ownerSessionIds: [sessionId],
              state: 'preparing',
            }
        this.registry.upsert(provisional)
        const transaction: ProvisionalCreation = {
          worktreeCreated: false,
          branchCreated: false,
          createdBranchOid: null,
        }

        try {
          // Recheck every destination component immediately before Git creates
          // the checkout. The post-add identity check below closes the
          // remaining external symlink-swap window.
          const revalidatedDestinationRoot = this.prepareDestinationRoot(
            materializationRoot,
            workspaceId,
            repoKey,
          )
          if (revalidatedDestinationRoot !== destinationRoot) {
            throw new WorktreeCreationError(
              'Managed-worktree destination changed during creation.',
              'WORKTREE_DESTINATION_UNSAFE',
            )
          }
          if (named) await this.assertNamedBranchAvailable(repositoryRoot, branch)
          // Capture the requested base OID immediately before Git creates the
          // branch. If an external actor changes the new ref before the first
          // ownership read, the created ref will no longer match this proof and
          // compensation must retain it instead of treating it as ours.
          const expectedBaseOid = await this.assertRefExists(repositoryRoot, baseRef)
          await runGit(['worktree', 'add', '--no-track', '-b', branch, worktreePath, baseRef], {
            cwd: repositoryRoot,
            timeoutMs: 120_000,
          })
          transaction.worktreeCreated = true
          const createdBranchOid = await this.getBranchOid(repositoryRoot, branch)
          if (!createdBranchOid || createdBranchOid !== expectedBaseOid) {
            throw new WorktreeCreationError(
              'The created branch identity could not be verified safely.',
              'WORKTREE_BRANCH_OWNERSHIP_UNKNOWN',
            )
          }
          transaction.branchCreated = true
          transaction.createdBranchOid = createdBranchOid

          const createdContext = await this.repositoryService.getContext(worktreePath)
          if (
            !createdContext.isGitRepository ||
            !createdContext.gitCommonDir ||
            safeRealpath(createdContext.gitCommonDir) !== realCommonDir ||
            createdContext.currentBranch !== branch ||
            createdContext.headSha !== createdBranchOid ||
            !this.isUnderWorktreeRoot(worktreePath, materializationRoot)
          ) {
            throw new WorktreeCreationError(
              'Git created a managed checkout with an unexpected identity or destination.',
              'WORKTREE_DESTINATION_UNSAFE',
            )
          }

          // .worktreeinclude limit or copy failure is handled by the outer
          // creation compensation, which tears down the still-clean checkout.
          const include = await applyWorktreeInclude(repositoryRoot, worktreePath)
          const ready: ManagedWorktreeRecord | ManagedWorktreeRecordV2 = named
            ? {
                ...(provisional as ManagedWorktreeRecordV2),
                checkoutPath: safeRealpath(worktreePath),
                state: 'ready',
                lastUsedAt: Date.now(),
              }
            : {
                ...(provisional as ManagedWorktreeRecord),
                checkoutPath: safeRealpath(worktreePath),
                state: 'ready',
              }
          this.registry.upsert(ready)
          return { record: ready, include }
        } catch (err) {
          const branchCollision = this.isBranchCollisionError(err)
          const pathCollision = this.isPathCollisionError(err)
          await this.cleanupProvisional(
            repositoryRoot,
            worktreePath,
            branch,
            managedWorktreeId,
            transaction,
          )
          if ((branchCollision || pathCollision) && !named) {
            lastError = err
            continue
          }
          if (branchCollision && named) {
            throw new WorktreeCreationError(
              `The requested worktree branch "${branch}" is already in use.`,
              'WORKTREE_BRANCH_COLLISION',
            )
          }
          // A V2 path is an internal random-ID collision, not an identity
          // collision. Retry it with another path while keeping the requested
          // branch unchanged.
          if (pathCollision && named) continue
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
    const result: WorktreeOwnerBindResult = this.registry.addOwnerIfReady(managedWorktreeId, sessionId)
    if (result.status === 'missing') {
      throw new Error('Managed worktree record not found.')
    }
    if (result.status === 'not-ready') {
      throw new Error(`Managed worktree cannot add an owner while it is ${result.state}.`)
    }
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
    rec: ManagedWorktreeRecordVersioned,
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

    const initialCommonDir = rec.gitCommonDir
    return this.mutationLock.withLock(initialCommonDir, async () => {
      // The registry is shared across server processes. Re-read it after the
      // Git lock is acquired so a stale in-memory record cannot authorize a
      // removal using an old path, owner set, or common directory.
      const current = this.registry.get(managedWorktreeId)
      if (!current) {
        return { removed: false, branchPruned: false, blocked: false }
      }
      if (safeRealpath(current.gitCommonDir) !== safeRealpath(initialCommonDir)) {
        return {
          removed: false,
          branchPruned: false,
          blocked: true,
          blockedReason: 'Managed worktree repository identity changed during removal.',
        }
      }
      const rec = current

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

      // Claim the record in the same locked registry transaction that checks
      // ownership and readiness. addOwnerIfReady() uses that transaction too,
      // so a late owner either lands before this claim (and blocks removal) or
      // is rejected after the record becomes removing.
      const removalBegin: WorktreeRemovalBeginResult = this.registry.beginRemoval(
        managedWorktreeId,
        requestingSessionId,
        requestingSessionId === RECONCILE_ACTOR,
      )
      if (removalBegin.status !== 'started') {
        let blockedReason: string
        switch (removalBegin.status) {
          case 'other-owner':
            blockedReason = 'Another session still owns this worktree.'
            break
          case 'not-owner':
            blockedReason = 'Worktree ownership changed during removal. Inspect it again before removing it.'
            break
          case 'not-ready':
            blockedReason = `Worktree cannot begin removal while it is ${removalBegin.state}.`
            break
          case 'missing':
            blockedReason = 'Managed worktree record disappeared during removal.'
            break
        }
        return {
          removed: false,
          branchPruned: false,
          blocked: true,
          blockedReason,
        }
      }

      // Remove the worktree registration + directory. V2 lifecycle callers use
      // the exported low-level `removeCheckoutFiles` (which always preserves
      // the branch); this V1 path prunes the branch afterwards when it has no
      // unique work.
      const released = await removeCheckoutFiles(rec.repositoryRoot, rec.checkoutPath)
      if (!released) {
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
      // Keep the exact registry snapshot used for reconciliation. The final
      // write is conditional so a concurrent owner bind or removal claim is
      // never overwritten by this stale async inspection.
      const observed: ManagedWorktreeRecordVersioned = {
        ...rec,
        ownerSessionIds: [...rec.ownerSessionIds],
      }

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
      } else if (listedEntry && rec.state !== 'ready' && rec.state !== 'removing') {
        // Healthy again after being marked missing/preparing/blocked. An
        // in-flight removal is never reopened by reconciliation.
        nextState = 'ready'
      }
      rec.state = nextState
      if (!this.registry.upsertIfUnchanged(observed, rec)) {
        // Another lifecycle operation won the registry race. Do not use this
        // stale inspection to reclaim or re-mark the checkout.
        continue
      }

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
          const blockedRecord: ManagedWorktreeRecordVersioned = {
            ...rec,
            state: 'blocked',
            ownerSessionIds: [...rec.ownerSessionIds],
          }
          // Do not overwrite a late owner reference (or a concurrent removal
          // outcome) with this stale reconciliation snapshot.
          this.registry.upsertIfUnchanged(rec, blockedRecord)
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
    rec: ManagedWorktreeRecordVersioned,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const recordRoot = 'materializationRoot' in rec
      ? rec.materializationRoot
      : this.getWorktreeRoot()
    if (!this.isUnderWorktreeRoot(rec.checkoutPath, recordRoot)) {
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

  /**
   * Revalidate a managed-worktree record before a NEW session binds to it.
   * Registry state is cached: a record last marked `ready` may have had its
   * checkout deleted, moved, switched to another branch, or replaced at the
   * same path since. Verify the live checkout is still a Git worktree of the
   * recorded common directory and still on the expected branch, so a new
   * session is never persisted with a stale path that fails on its first
   * prompt or points at a checkout other than the selected one.
   */
  async revalidateShareable(
    rec: ManagedWorktreeRecordVersioned,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!existsSync(rec.checkoutPath)) {
      return { ok: false, reason: 'Managed worktree checkout no longer exists on disk.' }
    }
    let ctx
    try {
      ctx = await this.repositoryService.getContext(rec.checkoutPath)
    } catch {
      return { ok: false, reason: 'Unable to verify the managed worktree identity before sharing.' }
    }
    if (!ctx.isGitRepository || !ctx.gitCommonDir) {
      return { ok: false, reason: 'Checkout path is not a Git worktree; refusing to share it.' }
    }
    if (safeRealpath(ctx.gitCommonDir) !== safeRealpath(rec.gitCommonDir)) {
      return {
        ok: false,
        reason: 'Managed worktree Git common directory does not match the recorded repository.',
      }
    }
    if (ctx.currentBranch !== rec.expectedBranch) {
      return {
        ok: false,
        reason: `Managed worktree is on an unexpected branch (${ctx.currentBranch ?? 'detached'} != ${rec.expectedBranch}); refusing to share it.`,
      }
    }
    return { ok: true }
  }

  private isSymlink(path: string): boolean {
    try {
      return lstatSync(path).isSymbolicLink()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw new WorktreeCreationError(
        `Unable to inspect managed-worktree destination: ${path}`,
        'WORKTREE_DESTINATION_UNSAFE',
      )
    }
  }

  /**
   * Create and verify the non-leaf destination components without following
   * symlinks. The final path is intentionally left absent for `git worktree
   * add`; Git identity + root containment are verified immediately afterwards.
   */
  private prepareDestinationRoot(
    materializationRoot: string,
    workspaceId: string,
    repoKey: string,
  ): string {
    let root = resolvePath(materializationRoot)
    try {
      if (this.isSymlink(root)) {
        throw new WorktreeCreationError(
          'Managed-worktree materialization root must not be a symlink.',
          'WORKTREE_DESTINATION_UNSAFE',
        )
      }
      mkdirSync(root, { recursive: true })
      if (this.isSymlink(root) || safeRealpath(root) !== root) {
        throw new WorktreeCreationError(
          'Managed-worktree materialization root changed through a symlink.',
          'WORKTREE_DESTINATION_UNSAFE',
        )
      }
      const rootStat = lstatSync(root)
      if (!rootStat.isDirectory()) {
        throw new WorktreeCreationError(
          'Managed-worktree materialization root is not a directory.',
          'WORKTREE_DESTINATION_UNSAFE',
        )
      }
      const destination = resolvePath(root, workspaceId, repoKey)
      const rel = relative(root, destination)
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
        throw new WorktreeCreationError(
          'Managed-worktree destination escapes the configured root.',
          'WORKTREE_DESTINATION_UNSAFE',
        )
      }
      let current = root
      for (const component of rel.split(/[\\/]+/).filter(Boolean)) {
        current = join(current, component)
        if (!existsSync(current)) mkdirSync(current)
        if (this.isSymlink(current)) {
          throw new WorktreeCreationError(
            'Managed-worktree destination contains a symlink component.',
            'WORKTREE_DESTINATION_UNSAFE',
          )
        }
        const stat = lstatSync(current)
        if (!stat.isDirectory()) {
          throw new WorktreeCreationError(
            'Managed-worktree destination contains a non-directory component.',
            'WORKTREE_DESTINATION_UNSAFE',
          )
        }
        if (safeRealpath(current) !== resolvePath(current)) {
          throw new WorktreeCreationError(
            'Managed-worktree destination changed through a symlink.',
            'WORKTREE_DESTINATION_UNSAFE',
          )
        }
      }
      return current
    } catch (error) {
      if (error instanceof WorktreeCreationError) throw error
      throw new WorktreeCreationError(
        `Unable to prepare managed-worktree destination: ${error instanceof Error ? error.message : String(error)}`,
        'WORKTREE_DESTINATION_UNSAFE',
      )
    }
  }

  private async cleanupProvisional(
    repositoryRoot: string,
    worktreePath: string,
    branch: string,
    managedWorktreeId: string,
    transaction: ProvisionalCreation,
  ): Promise<void> {
    let clean = true
    if (transaction.worktreeCreated || existsSync(worktreePath) || this.isSymlink(worktreePath)) {
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
    }

    // Never delete a branch merely because its name was requested. A branch is
    // removable only when this transaction recorded that it created the ref,
    // captured its exact OID, and a fresh compare-and-swap check still sees the
    // same OID. An external replacement is retained and the registry is left
    // blocked for explicit recovery.
    if (transaction.branchCreated) {
      if (!transaction.createdBranchOid) {
        clean = false
      } else {
        let currentOid: string | null
        try {
          currentOid = await this.getBranchOid(repositoryRoot, branch)
        } catch {
          clean = false
          currentOid = null
        }
        if (currentOid === null) {
          // Another actor already removed the request-owned branch.
        } else if (currentOid !== transaction.createdBranchOid) {
          clean = false
        } else {
          try {
            await runGit(['branch', '-D', branch], {
              cwd: repositoryRoot,
              okExitCodes: [1, 128],
            })
            if ((await this.getBranchOid(repositoryRoot, branch)) !== null) clean = false
          } catch {
            clean = false
          }
        }
      }
    }

    if (clean) {
      this.registry.remove(managedWorktreeId)
    } else {
      // Retain a blocked registry record for explicit recovery.
      this.registry.setState(managedWorktreeId, 'blocked')
    }
  }

  private async assertNamedBranchAvailable(
    repositoryRoot: string,
    branch: string,
  ): Promise<void> {
    const suffix = branch.startsWith('kata-agent/') ? branch.slice('kata-agent/'.length) : ''
    if (!suffix || suffix.trim() !== suffix || suffix.includes('\0')) {
      throw new WorktreeCreationError(
        'Worktree name must be non-empty and must not have leading or trailing whitespace.',
        'WORKTREE_NAME_INVALID',
      )
    }
    let formatResult
    try {
      formatResult = await runGit(['check-ref-format', '--branch', branch], {
        cwd: repositoryRoot,
        okExitCodes: [1, 128],
      })
    } catch (error) {
      if (error instanceof GitCommandError && (error.exitCode === 1 || error.exitCode === 128)) {
        throw new WorktreeCreationError(
          `Worktree name "${suffix}" is not a valid Git branch suffix.`,
          'WORKTREE_NAME_INVALID',
        )
      }
      throw error
    }
    if (formatResult.exitCode !== 0) {
      throw new WorktreeCreationError(
        `Worktree name "${suffix}" is not a valid Git branch suffix.`,
        'WORKTREE_NAME_INVALID',
      )
    }

    let refs
    try {
      refs = await runGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], {
        cwd: repositoryRoot,
      })
    } catch (error) {
      throw new WorktreeCreationError(
        'Unable to inspect existing Git branches before creating the worktree.',
        'WORKTREE_BRANCH_INSPECTION_FAILED',
      )
    }
    const requestedLower = branch.toLocaleLowerCase()
    const collision = refs.stdout
      .split(/\r?\n/)
      .map((ref) => ref.trim())
      .find((ref) => ref && ref.toLocaleLowerCase() === requestedLower)
    if (collision) {
      throw new WorktreeCreationError(
        `The requested worktree branch "${branch}" is already in use.`,
        'WORKTREE_BRANCH_COLLISION',
      )
    }
  }

  private isBranchCollisionError(error: unknown): boolean {
    if (error instanceof WorktreeCreationError) return error.code === 'WORKTREE_BRANCH_COLLISION'
    if (!(error instanceof GitCommandError)) return false
    const text = `${error.message} ${error.stderr}`
    return (
      /branch named .* already exists|already checked out|is already used by worktree/i.test(text) ||
      (text.includes('cannot lock ref') && text.includes('refs/heads/'))
    )
  }

  private isPathCollisionError(error: unknown): boolean {
    if (!(error instanceof GitCommandError)) return false
    return /worktree .*already exists|path .*already exists|already exists at/i.test(
      `${error.message} ${error.stderr}`,
    )
  }

  private async assertRefExists(repositoryRoot: string, ref: string): Promise<string> {
    try {
      const res = await runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
        cwd: repositoryRoot,
        okExitCodes: [1],
      })
      const oid = res.stdout.trim()
      if (res.exitCode !== 0 || !oid) {
        throw new WorktreeCreationError(`Base ref "${ref}" not found.`, 'BASE_REF_NOT_FOUND')
      }
      return oid
    } catch (err) {
      if (err instanceof WorktreeCreationError) throw err
      throw new WorktreeCreationError(`Base ref "${ref}" could not be resolved.`, 'BASE_REF_NOT_FOUND')
    }
  }

  private async getBranchOid(repositoryRoot: string, branch: string): Promise<string | null> {
    const res = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd: repositoryRoot,
      okExitCodes: [1, 128],
    })
    return res.exitCode === 0 ? res.stdout.trim() || null : null
  }

  private async branchExists(repositoryRoot: string, branch: string): Promise<boolean> {
    try {
      return (await this.getBranchOid(repositoryRoot, branch)) !== null
    } catch {
      return false
    }
  }
}

export function safeRealpath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolvePath(p)
  }
}

/**
 * Low-level checkout release used by V1 removal and every V2 lifecycle
 * transaction. Removes the Git worktree registration and directory, then
 * prunes stale registrations. The branch is always preserved. Returns true
 * only when the checkout is provably gone.
 */
export async function removeCheckoutFiles(repositoryRoot: string, checkoutPath: string): Promise<boolean> {
  try {
    await runGit(['worktree', 'remove', '--force', checkoutPath], {
      cwd: repositoryRoot,
      okExitCodes: [128],
    })
  } catch {
    /* fall through to manual cleanup */
  }
  removeDir(checkoutPath)
  try {
    await runGit(['worktree', 'prune'], { cwd: repositoryRoot, okExitCodes: [128] })
  } catch {
    /* ignore */
  }
  // Removal is only complete when the checkout is actually gone. Both the git
  // command and the manual fallback can fail — a locked worktree, a permission
  // problem, a process holding the directory — and neither surfaces as a
  // throw. Callers keep the registry record and report honestly instead of
  // claiming a removal that did not happen.
  return !existsSync(checkoutPath)
}
