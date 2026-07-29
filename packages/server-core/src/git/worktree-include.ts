/**
 * `.worktreeinclude` handling.
 *
 * A repository may provide `.worktreeinclude` patterns (gitignore syntax) for
 * required gitignored regular files that a fresh worktree needs. Copying:
 * - stays under the source repository (realpath containment),
 * - skips symlinks,
 * - never overwrites existing destination files,
 * - stops with a visible error above 10,000 files or 100 MiB total.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  copyFileSync,
  realpathSync,
} from 'node:fs'
import { dirname, join, relative, isAbsolute } from 'node:path'
import type { WorktreeIncludeResult } from '@kata-sh/shared/protocol'
import { runGit, splitNul } from './command-runner'

export const WORKTREE_INCLUDE_MAX_FILES = 10_000
export const WORKTREE_INCLUDE_MAX_BYTES = 100 * 1024 * 1024 // 100 MiB

export class WorktreeIncludeLimitError extends Error {
  readonly code = 'WORKTREE_INCLUDE_LIMIT'
  constructor(message: string) {
    super(message)
    this.name = 'WorktreeIncludeLimitError'
  }
}

/** True when `child` is contained within `parent` (both realpath-resolved). */
function isContained(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * List source files matching `.worktreeinclude` patterns. Returns
 * repository-relative POSIX paths. Empty when the file is absent.
 */
export async function listWorktreeIncludeFiles(sourceRoot: string): Promise<string[]> {
  const includeFile = join(sourceRoot, '.worktreeinclude')
  if (!existsSync(includeFile)) return []
  // Untracked files that match the include patterns. gitignored files are
  // "others" from the index's perspective, so this captures required gitignored
  // regular files without pulling in everything.
  const res = await runGit(
    ['ls-files', '-z', '--others', '--ignored', `--exclude-from=${includeFile}`],
    { cwd: sourceRoot },
  )
  return splitNul(res.stdout)
}

/**
 * Apply `.worktreeinclude`: copy matching source files into `destRoot`.
 * @throws WorktreeIncludeLimitError when limits are exceeded (before copying).
 */
export async function applyWorktreeInclude(
  sourceRoot: string,
  destRoot: string,
): Promise<WorktreeIncludeResult> {
  const files = await listWorktreeIncludeFiles(sourceRoot)
  const result: WorktreeIncludeResult = { copiedFileCount: 0, skippedSymlinks: 0, totalBytes: 0 }
  if (files.length === 0) return result

  const realSourceRoot = realpathSync(sourceRoot)

  // Pre-flight: enforce count and size limits before copying anything.
  if (files.length > WORKTREE_INCLUDE_MAX_FILES) {
    throw new WorktreeIncludeLimitError(
      `.worktreeinclude matched ${files.length} files, exceeding the limit of ${WORKTREE_INCLUDE_MAX_FILES}.`,
    )
  }

  let totalBytes = 0
  const plan: Array<{ rel: string; srcAbs: string; size: number }> = []
  for (const rel of files) {
    const srcAbs = join(sourceRoot, rel)
    let st: ReturnType<typeof lstatSync>
    try {
      st = lstatSync(srcAbs)
    } catch {
      continue
    }
    if (st.isSymbolicLink()) {
      result.skippedSymlinks++
      continue
    }
    if (!st.isFile()) continue

    // Containment: the real source path must remain under the source repo.
    let realSrc: string
    try {
      realSrc = realpathSync(srcAbs)
    } catch {
      continue
    }
    if (!isContained(realSourceRoot, realSrc)) continue

    totalBytes += st.size
    if (totalBytes > WORKTREE_INCLUDE_MAX_BYTES) {
      throw new WorktreeIncludeLimitError(
        `.worktreeinclude files exceed the total size limit of ${WORKTREE_INCLUDE_MAX_BYTES} bytes.`,
      )
    }
    plan.push({ rel, srcAbs, size: st.size })
  }

  for (const item of plan) {
    const destAbs = join(destRoot, item.rel)
    // Never overwrite an existing destination file.
    if (existsSync(destAbs)) continue
    mkdirSync(dirname(destAbs), { recursive: true })
    copyFileSync(item.srcAbs, destAbs)
    result.copiedFileCount++
    result.totalBytes += item.size
  }

  return result
}
