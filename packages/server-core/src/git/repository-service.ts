/**
 * RepositoryService — read-only Git repository discovery and inspection.
 *
 * Single source of truth for repository identity, refs, branch/detached state,
 * remotes/provider detection, and machine-readable status parsing. Uses only
 * NUL-delimited or otherwise machine-readable Git output; never parses
 * localized human output.
 */

import { resolve as resolvePath } from 'node:path'
import type {
  GitProvider,
  GitRef,
  GitRemoteInfo,
  GitStatusSnapshot,
  GitWorkingTreeEntry,
  GitWorkingTreeEntryType,
  ListRefsResult,
  RepositoryContext,
} from '@kata-sh/shared/protocol'
import { runGit, splitNul, GitCommandError } from './command-runner'

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
    } catch (err) {
      if (err instanceof GitCommandError && err.code === 'GIT_NOT_FOUND') throw err
    }
    return snapshot
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
