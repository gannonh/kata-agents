/**
 * GitActionService — safe commit / pull / push mutations (spec: AC13, AC14,
 * AC16, "Selected-file commit transaction").
 *
 * V1 never force-pushes, resets history/working-tree, rebases, merges, or auto-
 * resolves conflicts. The only history-adjacent operation is the path-limited
 * real-index reconciliation after a selected-file commit, which updates index
 * entries for the committed paths only and never changes working-tree files or
 * branch history.
 *
 * Every method returns a structured {@link GitActionResult} so callers can
 * report per-stage progress and partial success. Mutations should be serialized
 * by Git common directory (see MutationLock) by the caller.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import type {
  GitActionResult,
  GitActionStageResult,
  GitWorkingTreeEntry,
} from '@kata-sh/shared/protocol'
import { runGit, GitCommandError } from './command-runner'
import type { RepositoryService } from './repository-service'

export interface GitCommitParams {
  /** Checkout directory (repository root or a path within it). */
  dir: string
  /** Commit message; committed verbatim through hooks. */
  message: string
  /**
   * Repository-relative paths to commit. Undefined/empty commits every changed
   * path. Renames are expanded server-side into their old + new paths.
   */
  paths?: string[]
}

export class GitActionService {
  constructor(private readonly repository: RepositoryService) {}

  /**
   * Commit only the selected whole-file paths while preserving unrelated staged
   * index entries, using the normative temporary-index transaction.
   */
  async commit(params: GitCommitParams): Promise<GitActionResult> {
    const root = await this.resolveRoot(params.dir)
    if (!root) return single(failure('commit', 'Not a Git repository.'))

    const message = params.message.trim()
    if (!message) return single(failure('commit', 'A commit message is required.'))

    // Resolve the selected paths + expand renames from the current status.
    const status = await this.repository.getStatus(root)
    if (status.entries.length === 0) {
      return single(failure('commit', 'There are no changes to commit.'))
    }
    const expanded = expandSelectedPaths(status.entries, params.paths)
    if (expanded.length === 0) {
      return single(failure('commit', 'No matching changed files were selected.'))
    }

    // Step 1: capture HEAD (may be null on an unborn branch).
    const headBefore = await revParse(root, 'HEAD')

    // Snapshot the real index up front; only selected paths may change (step 5).
    const indexBefore = await indexEntries(root)

    // Step 2: secure temporary index initialized from HEAD.
    const tmpDir = mkdtempSync(join(tmpdir(), 'kata-git-idx-'))
    const tmpIndex = join(tmpDir, 'index')
    const idxEnv = { GIT_INDEX_FILE: tmpIndex }

    try {
      if (headBefore) {
        await runGit(['read-tree', 'HEAD'], { cwd: root, env: idxEnv })
      } else {
        // Unborn branch: start from an empty index.
        await runGit(['read-tree', '--empty'], { cwd: root, env: idxEnv })
      }

      // Step 3: stage only the expanded selected paths into the temp index.
      await runGit(['add', '-A', '--', ...expanded], { cwd: root, env: idxEnv })

      // Step 4: require a non-empty cached diff, re-check HEAD, then commit the
      // temp index (running normal hooks).
      const cached = await runGit(['diff', '--cached', '--quiet'], {
        cwd: root,
        env: idxEnv,
        okExitCodes: [1],
      })
      if (cached.exitCode === 0) {
        return single(failure('commit', 'The selected files have no changes to commit.'))
      }
      const headCheck = await revParse(root, 'HEAD')
      if (headCheck !== headBefore) {
        return single(failure('commit', 'HEAD moved during the commit; aborted for safety.'))
      }

      await runGit(['commit', '-F', '-'], { cwd: root, env: idxEnv, input: message })

      // Step 5: verify HEAD advanced, then reconcile only selected paths in the
      // REAL index (no GIT_INDEX_FILE).
      const newCommit = await revParse(root, 'HEAD')
      if (!newCommit || newCommit === headBefore) {
        return single(failure('commit', 'Commit did not advance HEAD.'))
      }

      const recovery = `git reset -q HEAD -- ${expanded.map(quoteForDisplay).join(' ')}`
      const reconciled = await this.reconcileRealIndex(root, newCommit, expanded)
      const commitStage: GitActionStageResult = {
        stage: 'commit',
        status: 'succeeded',
        detail: newCommit.slice(0, 8),
      }
      if (!reconciled) {
        // Partial success: the commit stands, but the real index still shows the
        // committed paths as staged. Surface the manual recovery command.
        commitStage.recoveryCommand = recovery
      } else {
        // Safety assertion: unrelated staged entries must be unchanged.
        const indexAfter = await indexEntries(root)
        if (!unrelatedIndexPreserved(indexBefore, indexAfter, expanded)) {
          commitStage.recoveryCommand = recovery
          commitStage.detail = `${newCommit.slice(0, 8)} (verify staged changes)`
        }
      }
      return { stages: [commitStage], commitSha: newCommit }
    } catch (err) {
      return single(failure('commit', describeError(err)))
    } finally {
      // Step 6: remove the temporary index on every exit path.
      try {
        rmSync(tmpDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }

  /** Fast-forward-only pull. Never merges or rebases on divergence. */
  async pull(dir: string): Promise<GitActionResult> {
    const root = await this.resolveRoot(dir)
    if (!root) return single(failure('pull', 'Not a Git repository.'))
    try {
      await runGit(['pull', '--ff-only'], { cwd: root, timeoutMs: 120_000 })
      return { stages: [{ stage: 'pull', status: 'succeeded' }] }
    } catch (err) {
      const msg = err instanceof GitCommandError ? err.stderr || err.message : describeError(err)
      const detail = /non-fast-forward|not possible to fast-forward|diverg/i.test(msg)
        ? 'The branch has diverged from its upstream. Reconcile manually; V1 will not merge or rebase.'
        : /no tracking information|no upstream|there is no candidate/i.test(msg)
          ? 'No upstream is configured for this branch.'
          : msg
      return single(failure('pull', detail))
    }
  }

  /** Push the current branch, configuring upstream tracking when absent. */
  async push(dir: string): Promise<GitActionResult> {
    const root = await this.resolveRoot(dir)
    if (!root) return single(failure('push', 'Not a Git repository.'))
    const ctx = await this.repository.getContext(root)
    if (!ctx.currentBranch || ctx.detached) {
      return single(failure('push', 'Cannot push a detached HEAD.'))
    }
    if (!ctx.primaryRemote) {
      return single(failure('push', 'No remote is configured for this repository.'))
    }
    const hasUpstream = await this.hasUpstream(root)
    const args = hasUpstream
      ? ['push']
      : ['push', '-u', ctx.primaryRemote, ctx.currentBranch]
    try {
      await runGit(args, { cwd: root, timeoutMs: 120_000 })
      return { stages: [{ stage: 'push', status: 'succeeded' }] }
    } catch (err) {
      const msg = err instanceof GitCommandError ? err.stderr || err.message : describeError(err)
      const detail = /non-fast-forward|rejected|fetch first|behind/i.test(msg)
        ? 'Push was rejected because the remote has newer commits. Pull first; V1 will not force-push.'
        : msg
      return single(failure('push', detail))
    }
  }

  // --- internals -----------------------------------------------------------

  private async resolveRoot(dir: string): Promise<string | null> {
    const ctx = await this.repository.getContext(dir)
    return ctx.isGitRepository ? ctx.repositoryRoot : null
  }

  private async hasUpstream(root: string): Promise<boolean> {
    try {
      const res = await runGit(
        ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
        { cwd: root, okExitCodes: [128] },
      )
      return res.exitCode === 0 && res.stdout.trim().length > 0
    } catch {
      return false
    }
  }

  /**
   * Path-limited reconciliation of the real index to the new commit. Retries
   * once on failure; returns false when both attempts fail so the caller can
   * report partial success with a recovery command.
   */
  private async reconcileRealIndex(
    root: string,
    newCommit: string,
    expanded: string[],
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await runGit(['reset', '-q', newCommit, '--', ...expanded], { cwd: root })
        return true
      } catch {
        /* retry once */
      }
    }
    return false
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function single(stage: GitActionStageResult): GitActionResult {
  return { stages: [stage] }
}

function failure(stage: GitActionStageResult['stage'], error: string): GitActionStageResult {
  return { stage, status: 'failed', error }
}

function describeError(err: unknown): string {
  if (err instanceof GitCommandError) return err.stderr || err.message
  return err instanceof Error ? err.message : String(err)
}

async function revParse(dir: string, ref: string): Promise<string | null> {
  const res = await runGit(['rev-parse', '--verify', '--quiet', ref], {
    cwd: dir,
    okExitCodes: [1, 128],
  })
  if (res.exitCode !== 0) return null
  return res.stdout.trim() || null
}

/** Full real-index snapshot: path → `mode sha stage`. */
async function indexEntries(dir: string): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const res = await runGit(['ls-files', '--stage', '-z'], { cwd: dir, okExitCodes: [128] })
  if (res.exitCode !== 0) return map
  for (const rec of res.stdout.split('\0')) {
    if (!rec) continue
    const m = rec.match(/^(\d+) ([0-9a-f]+) (\d)\t(.*)$/s)
    if (!m) continue
    map.set(m[4]!, `${m[1]} ${m[2]} ${m[3]}`)
  }
  return map
}

/**
 * True when every index entry outside the selected paths is content-identical
 * before and after the operation (spec: preserve unrelated staged entries).
 */
export function unrelatedIndexPreserved(
  before: Map<string, string>,
  after: Map<string, string>,
  selected: string[],
): boolean {
  const skip = new Set(selected)
  const paths = new Set<string>([...before.keys(), ...after.keys()])
  for (const path of paths) {
    if (skip.has(path)) continue
    if (before.get(path) !== after.get(path)) return false
  }
  return true
}

/**
 * Expand the selected repository-relative paths into the concrete set to stage,
 * adding the old path of any selected rename/copy so the pair is atomic. Empty
 * selection means "all changed paths".
 */
export function expandSelectedPaths(
  entries: GitWorkingTreeEntry[],
  selected: string[] | undefined,
): string[] {
  const byPath = new Map<string, GitWorkingTreeEntry>()
  for (const e of entries) byPath.set(e.path, e)

  const chosen =
    selected && selected.length > 0
      ? entries.filter((e) => selected.includes(e.path) || (e.previousPath && selected.includes(e.previousPath)))
      : entries

  const out = new Set<string>()
  for (const e of chosen) {
    out.add(e.path)
    if (e.previousPath) out.add(e.previousPath)
  }
  // Preserve any explicitly-selected path even if it wasn't a status entry key.
  if (selected) {
    for (const p of selected) {
      if (byPath.has(p)) out.add(p)
    }
  }
  return Array.from(out)
}

/** Shell-display quoting for a path in the recovery command hint (display only). */
function quoteForDisplay(path: string): string {
  return /[\s"'\\]/.test(path) ? `'${path.replace(/'/g, "'\\''")}'` : path
}
