/**
 * RepositoryService — read-only Git repository discovery and inspection.
 *
 * Single source of truth for repository identity, refs, branch/detached state,
 * remotes/provider detection, and machine-readable status parsing. Uses only
 * NUL-delimited or otherwise machine-readable Git output; never parses
 * localized human output.
 */

import { resolve as resolvePath, relative as relativePath, isAbsolute } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type {
  GitFileDiff,
  GitProvider,
  GitRef,
  GitRemoteInfo,
  GitStatusSnapshot,
  GitWorkingTreeEntry,
  GitWorkingTreeEntryType,
  ListRefsResult,
  RepositoryContext,
} from '@kata-sh/shared/protocol'
import { GIT_DIFF_MAX_BYTES } from '@kata-sh/shared/protocol'
import { runGit, runGitBuffer, splitNul, GitCommandError } from './command-runner'
import { detectDiffLanguage } from './diff-language'

export function detectProvider(url: string | null): GitProvider {
  if (!url) return 'unknown'
  const lower = url.toLowerCase()
  if (lower.includes('github.com')) return 'github'
  if (lower.includes('gitlab.com') || lower.includes('gitlab.')) return 'gitlab'
  if (lower.includes('bitbucket.org') || lower.includes('bitbucket.')) return 'bitbucket'
  return 'other'
}

/** Parse `git status --porcelain=v2 -z` records into working-tree entries. */
export function parsePorcelainV2(output: string): GitWorkingTreeEntry[] {
  const entries: GitWorkingTreeEntry[] = []
  // porcelain v2 with -z uses NUL as record terminator, but a renamed/copied
  // entry (prefixed `2 `) is followed by an extra NUL-separated origPath field.
  const tokens = output.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const line = tokens[i]
    if (!line) continue
    const kind = line[0]
    if (kind === '1') {
      // ordinary: `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
      const m = line.match(/^1 (..) \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/)
      if (m) {
        const xy = m[1]!
        entries.push({
          path: m[2]!,
          type: mapXyType(xy),
          indexState: xy[0],
          worktreeState: xy[1],
        })
      }
    } else if (kind === '2') {
      // rename/copy: `2 <XY> <sub> ... <X><score> <path>` then next token is origPath
      const m = line.match(/^2 (..) \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/)
      const origPath = tokens[i + 1]
      i++ // consume origPath token
      if (m) {
        const xy = m[1]!
        entries.push({
          path: m[2]!,
          previousPath: origPath,
          type: xy[0] === 'C' ? 'copied' : 'renamed',
          indexState: xy[0],
          worktreeState: xy[1],
        })
      }
    } else if (kind === 'u') {
      // unmerged (conflict)
      const m = line.match(/^u (..) \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/)
      if (m) {
        entries.push({
          path: m[2]!,
          type: 'unknown',
          indexState: m[1]![0],
          worktreeState: m[1]![1],
          conflicted: true,
        })
      }
    } else if (kind === '?') {
      // untracked: `? <path>`
      entries.push({ path: line.slice(2), type: 'untracked' })
    }
    // '!' ignored entries are not requested.
  }
  return entries
}

function mapXyType(xy: string): GitWorkingTreeEntryType {
  const s = xy.replace(/\./g, '')
  if (s.includes('A')) return 'added'
  if (s.includes('D')) return 'deleted'
  if (s.includes('R')) return 'renamed'
  if (s.includes('C')) return 'copied'
  if (s.includes('M') || s.includes('T')) return 'modified'
  return 'unknown'
}

export class RepositoryService {
  /**
   * Discover repository identity and live branch/remote context for a directory.
   * Returns a non-git result (all null) when the directory is not inside a repo.
   */
  async getContext(dir: string): Promise<RepositoryContext> {
    const nonGit: RepositoryContext = {
      isGitRepository: false,
      repositoryRoot: null,
      gitCommonDir: null,
      currentBranch: null,
      detached: false,
      headSha: null,
      defaultRef: null,
      remotes: [],
      primaryRemote: null,
      provider: 'unknown',
    }

    let root: string
    let commonDir: string
    try {
      const res = await runGit(
        ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'],
        { cwd: dir },
      )
      const lines = res.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
      if (lines.length < 2) return nonGit
      root = resolvePath(lines[0]!)
      commonDir = resolvePath(lines[1]!)
    } catch (err) {
      if (err instanceof GitCommandError && err.code === 'GIT_NOT_FOUND') throw err
      return nonGit
    }

    const [branchInfo, headSha, remotes, defaultRef] = await Promise.all([
      this.getBranchState(root),
      this.getHeadSha(root),
      this.getRemotes(root),
      this.getDefaultRef(root).catch(() => null),
    ])

    const primaryRemote = pickPrimaryRemote(remotes)
    const provider = primaryRemote
      ? remotes.find((r) => r.name === primaryRemote)?.provider ?? 'unknown'
      : 'unknown'

    return {
      isGitRepository: true,
      repositoryRoot: root,
      gitCommonDir: commonDir,
      currentBranch: branchInfo.detached ? null : branchInfo.branch,
      detached: branchInfo.detached,
      headSha,
      defaultRef,
      remotes,
      primaryRemote,
      provider,
    }
  }

  /** Return the current branch name, or null when detached / unavailable. */
  async getBranch(dir: string): Promise<string | null> {
    try {
      const state = await this.getBranchState(dir)
      return state.detached ? null : state.branch
    } catch (err) {
      if (err instanceof GitCommandError && err.code === 'GIT_NOT_FOUND') return null
      return null
    }
  }

  private async getBranchState(dir: string): Promise<{ branch: string | null; detached: boolean }> {
    try {
      const res = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
        cwd: dir,
        okExitCodes: [1],
      })
      if (res.exitCode === 0) {
        return { branch: res.stdout.trim() || null, detached: false }
      }
      // Detached HEAD
      return { branch: null, detached: true }
    } catch {
      return { branch: null, detached: false }
    }
  }

  private async getHeadSha(dir: string): Promise<string | null> {
    try {
      const res = await runGit(['rev-parse', 'HEAD'], { cwd: dir, okExitCodes: [128] })
      if (res.exitCode !== 0) return null
      return res.stdout.trim() || null
    } catch {
      return null
    }
  }

  async getRemotes(dir: string): Promise<GitRemoteInfo[]> {
    try {
      const res = await runGit(['remote', '-v'], { cwd: dir })
      const map = new Map<string, GitRemoteInfo>()
      for (const line of res.stdout.split('\n')) {
        const m = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/)
        if (!m) continue
        const [, name, url, kind] = m
        const existing = map.get(name!) ?? {
          name: name!,
          fetchUrl: null,
          pushUrl: null,
          provider: detectProvider(url!),
        }
        if (kind === 'fetch') existing.fetchUrl = url!
        else existing.pushUrl = url!
        existing.provider = detectProvider(existing.fetchUrl ?? existing.pushUrl)
        map.set(name!, existing)
      }
      return Array.from(map.values())
    } catch {
      return []
    }
  }

  /** Detect the default ref (branch name), preferring the primary remote HEAD. */
  async getDefaultRef(dir: string): Promise<string | null> {
    const remotes = await this.getRemotes(dir)
    const primary = pickPrimaryRemote(remotes)
    if (primary) {
      try {
        const res = await runGit(['symbolic-ref', '--short', `refs/remotes/${primary}/HEAD`], {
          cwd: dir,
          okExitCodes: [1, 128],
        })
        if (res.exitCode === 0) {
          const full = res.stdout.trim() // e.g. origin/main
          const slash = full.indexOf('/')
          return slash >= 0 ? full.slice(slash + 1) : full
        }
      } catch {
        /* fall through */
      }
    }
    // Fall back to local main/master existence.
    for (const candidate of ['main', 'master']) {
      try {
        const res = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`], {
          cwd: dir,
          okExitCodes: [1],
        })
        if (res.exitCode === 0) return candidate
      } catch {
        /* ignore */
      }
    }
    return null
  }

  /** List local branches, remote branches, and tags. */
  async listRefs(dir: string): Promise<ListRefsResult> {
    const branchState = await this.getBranchState(dir)
    const defaultRef = await this.getDefaultRef(dir).catch(() => null)
    const refs: GitRef[] = []
    try {
      const res = await runGit(
        [
          'for-each-ref',
          '--format=%(refname)%00%(objectname)%00%(HEAD)',
          'refs/heads',
          'refs/remotes',
          'refs/tags',
        ],
        { cwd: dir },
      )
      for (const line of res.stdout.split('\n')) {
        if (!line.trim()) continue
        const [fullName, sha, headMark] = line.split('\0')
        if (!fullName) continue
        let type: GitRef['type'] = 'local'
        let name = fullName
        if (fullName.startsWith('refs/heads/')) {
          type = 'local'
          name = fullName.slice('refs/heads/'.length)
        } else if (fullName.startsWith('refs/remotes/')) {
          type = 'remote'
          name = fullName.slice('refs/remotes/'.length)
        } else if (fullName.startsWith('refs/tags/')) {
          type = 'tag'
          name = fullName.slice('refs/tags/'.length)
        }
        // Skip remote HEAD symbolic pointers like origin/HEAD
        if (type === 'remote' && name.endsWith('/HEAD')) continue
        refs.push({
          name,
          fullName,
          type,
          sha: sha || undefined,
          isCurrent: headMark === '*',
        })
      }
    } catch (err) {
      if (err instanceof GitCommandError && err.code === 'GIT_NOT_FOUND') throw err
    }
    return { refs, currentBranch: branchState.detached ? null : branchState.branch, defaultRef }
  }

  /** Parse machine-readable status for a checkout. */
  async getStatus(dir: string): Promise<GitStatusSnapshot> {
    const ctx = await this.getContext(dir)
    const snapshot: GitStatusSnapshot = {
      repositoryRoot: ctx.repositoryRoot,
      checkoutPath: resolvePath(dir),
      isGitRepository: ctx.isGitRepository,
      currentBranch: ctx.currentBranch,
      detached: ctx.detached,
      defaultRef: ctx.defaultRef,
      baseRef: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      publishableCommitCount: 0,
      baseDeltaCount: 0,
      primaryRemote: ctx.primaryRemote,
      provider: ctx.provider,
      entries: [],
      operationInProgress: null,
      blockedReason: null,
    }
    if (!ctx.isGitRepository) return snapshot

    try {
      const res = await runGit(
        ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'],
        { cwd: dir },
      )
      const { entries, ahead, behind, upstream } = splitStatusBranchHeaders(res.stdout)
      snapshot.entries = entries
      snapshot.ahead = ahead
      snapshot.behind = behind
      snapshot.upstream = upstream
      await this.attachDiffStats(dir, snapshot)
    } catch (err) {
      if (err instanceof GitCommandError && err.code === 'GIT_NOT_FOUND') throw err
    }
    return snapshot
  }

  /**
   * Attach per-entry and aggregate additions/deletions to a status snapshot.
   * Tracked changes use `git diff --numstat -z HEAD`; untracked files count
   * their own lines (bounded). Binary paths are flagged and excluded from totals.
   */
  private async attachDiffStats(dir: string, snapshot: GitStatusSnapshot): Promise<void> {
    let stats: Map<string, { additions: number | null; deletions: number | null }>
    try {
      stats = await this.getNumstat(dir)
    } catch (err) {
      if (err instanceof GitCommandError && err.code === 'GIT_NOT_FOUND') throw err
      return
    }
    let totalAdd = 0
    let totalDel = 0
    let haveStats = false
    for (const entry of snapshot.entries) {
      const s = stats.get(entry.path)
      if (s) {
        if (s.additions === null || s.deletions === null) {
          entry.binary = true
          continue
        }
        entry.additions = s.additions
        entry.deletions = s.deletions
        totalAdd += s.additions
        totalDel += s.deletions
        haveStats = true
      } else if (entry.type === 'untracked') {
        const lines = await this.countUntrackedLines(dir, entry.path)
        if (lines === null) {
          entry.binary = true
        } else {
          entry.additions = lines
          entry.deletions = 0
          totalAdd += lines
          haveStats = true
        }
      }
    }
    if (haveStats) {
      snapshot.additions = totalAdd
      snapshot.deletions = totalDel
    }
  }

  private async getNumstat(
    dir: string,
  ): Promise<Map<string, { additions: number | null; deletions: number | null }>> {
    const map = new Map<string, { additions: number | null; deletions: number | null }>()
    const res = await runGit(['diff', '--numstat', '-z', 'HEAD'], { cwd: dir, okExitCodes: [128] })
    if (res.exitCode !== 0) return map
    for (const rec of parseNumstatZ(res.stdout)) {
      map.set(rec.path, { additions: rec.additions, deletions: rec.deletions })
    }
    return map
  }

  private async countUntrackedLines(dir: string, relPath: string): Promise<number | null> {
    try {
      const abs = resolvePath(dir, relPath)
      const st = await stat(abs)
      if (st.size > GIT_DIFF_MAX_BYTES) return null
      const buf = await readFile(abs)
      if (isBinaryBuffer(buf)) return null
      if (buf.length === 0) return 0
      const text = buf.toString('utf8')
      let n = text.split('\n').length
      if (text.endsWith('\n')) n -= 1
      return n
    } catch {
      return null
    }
  }

  /**
   * Produce a bounded diff for a single repository-relative path in the given
   * checkout. Old side is the committed (HEAD) blob; new side is the working
   * tree. Returns explicit binary/oversized/missing/clean/error states so the
   * Changes panel never renders a corrupt diff.
   */
  async getFileDiff(
    dir: string,
    request: { path: string; previousPath?: string; type: GitWorkingTreeEntryType },
  ): Promise<GitFileDiff> {
    const { path, previousPath, type: changeType } = request
    const language = detectDiffLanguage(path)
    const base: GitFileDiff = { path, previousPath, changeType, state: 'text', fingerprint: '', language }
    try {
      const oldPath = previousPath ?? path
      const isAdded = changeType === 'added' || changeType === 'untracked'
      const isDeleted = changeType === 'deleted'

      const oldBuf = isAdded ? Buffer.alloc(0) : await this.showHeadBlob(dir, oldPath)

      let newBuf = Buffer.alloc(0)
      if (!isDeleted) {
        const abs = resolveInRepo(dir, path)
        if (!abs) return { ...base, state: 'error', fingerprint: 'error', error: 'Path is outside the repository.' }
        try {
          newBuf = await readFile(abs)
        } catch {
          return { ...base, state: 'missing', fingerprint: fingerprintBuffers(oldBuf, Buffer.alloc(0)) }
        }
      }

      const fingerprint = fingerprintBuffers(oldBuf, newBuf)
      const sizeBytes = Math.max(oldBuf.length, newBuf.length)

      if (isBinaryBuffer(oldBuf) || isBinaryBuffer(newBuf)) {
        return { ...base, state: 'binary', sizeBytes, fingerprint }
      }
      if (sizeBytes > GIT_DIFF_MAX_BYTES) {
        return { ...base, state: 'oversized', sizeBytes, fingerprint }
      }
      const oldContent = oldBuf.toString('utf8')
      const newContent = newBuf.toString('utf8')
      if (oldContent === newContent) {
        return {
          ...base,
          state: 'clean',
          oldContent,
          newContent,
          additions: 0,
          deletions: 0,
          sizeBytes,
          fingerprint,
        }
      }
      const { additions, deletions } = countLineDiff(oldContent, newContent)
      return { ...base, state: 'text', oldContent, newContent, additions, deletions, sizeBytes, fingerprint }
    } catch (err) {
      if (err instanceof GitCommandError && err.code === 'GIT_NOT_FOUND') throw err
      return {
        ...base,
        state: 'error',
        fingerprint: 'error',
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  private async showHeadBlob(dir: string, relPath: string): Promise<Buffer> {
    try {
      const res = await runGitBuffer(['show', `HEAD:${relPath}`], { cwd: dir, okExitCodes: [128] })
      if (res.exitCode !== 0) return Buffer.alloc(0)
      return res.stdout
    } catch (err) {
      if (err instanceof GitCommandError && err.code === 'GIT_NOT_FOUND') throw err
      return Buffer.alloc(0)
    }
  }

  /** Count commits on the current branch not reachable from the given ref. */
  async countCommitsAhead(dir: string, baseRef: string): Promise<number> {
    try {
      const res = await runGit(['rev-list', '--count', `${baseRef}..HEAD`], {
        cwd: dir,
        okExitCodes: [128],
      })
      if (res.exitCode !== 0) return 0
      return parseInt(res.stdout.trim(), 10) || 0
    } catch {
      return 0
    }
  }
}

function splitStatusBranchHeaders(output: string): {
  entries: GitWorkingTreeEntry[]
  ahead: number
  behind: number
  upstream: string | null
} {
  // Branch headers appear as `# branch.ab +A -B`, `# branch.upstream <name>`,
  // each terminated by NUL when -z is used. Separate them from file records.
  const tokens = output.split('\0')
  let ahead = 0
  let behind = 0
  let upstream: string | null = null
  const fileTokens: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (!t) continue
    if (t.startsWith('# branch.ab ')) {
      const m = t.match(/\+(-?\d+) -(-?\d+)/)
      if (m) {
        ahead = parseInt(m[1]!, 10) || 0
        behind = parseInt(m[2]!, 10) || 0
      }
    } else if (t.startsWith('# branch.upstream ')) {
      upstream = t.slice('# branch.upstream '.length).trim() || null
    } else if (t.startsWith('# ')) {
      // other branch headers ignored
    } else {
      fileTokens.push(t)
      // rename/copy records ('2 ') consume the next token as origPath
      if (t[0] === '2' && tokens[i + 1] !== undefined) {
        fileTokens.push(tokens[i + 1]!)
        i++
      }
    }
  }
  const entries = parsePorcelainV2(fileTokens.join('\0'))
  return { entries, ahead, behind, upstream }
}

function pickPrimaryRemote(remotes: GitRemoteInfo[]): string | null {
  if (remotes.length === 0) return null
  const origin = remotes.find((r) => r.name === 'origin')
  return origin ? origin.name : remotes[0]!.name
}

interface NumstatRecord {
  additions: number | null
  deletions: number | null
  path: string
  previousPath?: string
}

/** Parse `git diff --numstat -z` output, handling NUL-separated rename records. */
export function parseNumstatZ(output: string): NumstatRecord[] {
  const parts = output.split('\0')
  const records: NumstatRecord[] = []
  let i = 0
  while (i < parts.length) {
    const rec = parts[i]
    if (!rec) {
      i++
      continue
    }
    const m = rec.match(/^(-|\d+)\t(-|\d+)\t(.*)$/)
    if (!m) {
      i++
      continue
    }
    const additions = m[1] === '-' ? null : parseInt(m[1]!, 10)
    const deletions = m[2] === '-' ? null : parseInt(m[2]!, 10)
    let path = m[3]!
    let previousPath: string | undefined
    if (path === '') {
      // Rename/copy: the two following NUL-separated tokens are old + new paths.
      previousPath = parts[i + 1]
      path = parts[i + 2] ?? ''
      i += 3
    } else {
      i += 1
    }
    records.push({ additions, deletions, path, previousPath })
  }
  return records
}

/** True when a buffer contains a NUL byte in its leading window (binary heuristic). */
export function isBinaryBuffer(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000)
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

function fingerprintBuffers(a: Buffer, b: Buffer): string {
  const h = createHash('sha256')
  h.update(a)
  h.update(Buffer.from([0]))
  h.update(b)
  return h.digest('hex').slice(0, 16)
}

/**
 * Count changed lines by trimming common prefix/suffix. Deterministic and cheap;
 * the diff renderer computes its own precise hunk counts for display.
 */
export function countLineDiff(oldContent: string, newContent: string): {
  additions: number
  deletions: number
} {
  const a = oldContent === '' ? [] : oldContent.split('\n')
  const b = newContent === '' ? [] : newContent.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  return { deletions: Math.max(0, endA - start), additions: Math.max(0, endB - start) }
}

/** Lexical containment check: resolve a repo-relative path and reject escapes. */
export function resolveInRepo(dir: string, relPath: string): string | null {
  const root = resolvePath(dir)
  const abs = resolvePath(root, relPath)
  const rel = relativePath(root, abs)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  return abs
}
