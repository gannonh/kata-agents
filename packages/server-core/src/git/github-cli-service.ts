/**
 * GitHubCliService — thin adapter over the `gh` CLI (spec: AC15, "GitHub
 * behavior"). Kata never stores GitHub credentials; it only detects whether
 * `gh` is installed and authenticated for the repository's GitHub host, looks
 * up an existing pull request, and creates one.
 *
 * All process invocation goes through `execFile` with an argument array (never a
 * shell string). The `gh` executable path is injectable so adapter behavior can
 * be exercised deterministically with a controlled fake `gh` in tests; real
 * GitHub UAT is performed separately during Verify.
 */

import { execFile } from 'node:child_process'
import type {
  GitHubCapabilityStatus,
  PullRequestSummary,
} from '@kata-sh/shared/protocol'
import type { RepositoryService } from './repository-service'

export interface GhResult {
  stdout: string
  stderr: string
  exitCode: number
  /** True when the `gh` executable itself could not be spawned. */
  notFound?: boolean
}

export type GhRunner = (
  args: string[],
  options: { cwd: string; input?: string; timeoutMs?: number },
) => Promise<GhResult>

export interface GitHubCliServiceOptions {
  /** Path/name of the `gh` executable. Defaults to `gh` on PATH. */
  ghPath?: string
  /** Injected runner (tests). Overrides `ghPath`. */
  runner?: GhRunner
}

export interface CreatePullRequestParams {
  dir: string
  title: string
  body?: string
  /** Resolved PR base branch (managed worktree base ref, else default ref). */
  baseRef: string
}

const DEFAULT_TIMEOUT_MS = 30_000

export class GitHubCliService {
  private readonly run: GhRunner

  constructor(
    private readonly repository: RepositoryService,
    options: GitHubCliServiceOptions = {},
  ) {
    this.run = options.runner ?? defaultRunner(options.ghPath ?? 'gh')
  }

  /**
   * Detect `gh` availability and authentication for the repository's GitHub
   * host. Returns `installed:false` when `gh` is missing, and a null host with
   * `authenticated:false` for non-GitHub remotes.
   */
  async getCapability(dir: string): Promise<GitHubCapabilityStatus> {
    const host = await this.detectHost(dir)

    const version = await this.run(['--version'], { cwd: dir })
    if (version.notFound) {
      return { installed: false, authenticated: false, host, detail: 'gh is not installed.' }
    }

    if (!host) {
      return {
        installed: true,
        authenticated: false,
        host: null,
        detail: 'No GitHub remote detected for this repository.',
      }
    }

    const auth = await this.run(['auth', 'status', '--hostname', host], { cwd: dir })
    const authenticated = auth.exitCode === 0
    return {
      installed: true,
      authenticated,
      host,
      detail: authenticated ? undefined : `Run \`gh auth login --hostname ${host}\` to authenticate.`,
    }
  }

  /**
   * Look up an existing pull request for the current branch. Returns null when
   * none exists. Never throws for a missing PR — lookup failure must not block
   * commit or push (spec: "PR lookup failure must not block commit or push").
   */
  async findPullRequest(dir: string): Promise<PullRequestSummary | null> {
    try {
      const res = await this.run(
        ['pr', 'view', '--json', 'number,url,title,state,baseRefName,headRefName'],
        { cwd: dir },
      )
      if (res.notFound || res.exitCode !== 0) return null
      return parsePullRequestJson(res.stdout)
    } catch {
      return null
    }
  }

  /**
   * Create a pull request from the current branch against `baseRef`. Assumes the
   * branch already has an upstream (the caller pushes first when needed).
   */
  async createPullRequest(params: CreatePullRequestParams): Promise<PullRequestSummary> {
    const { dir, title, body, baseRef } = params
    const res = await this.run(
      ['pr', 'create', '--title', title, '--body-file', '-', '--base', baseRef],
      { cwd: dir, input: body ?? '' },
    )
    if (res.notFound) {
      throw new Error('gh is not installed on the workspace-owning machine.')
    }
    if (res.exitCode !== 0) {
      throw new Error(sanitize(res.stderr) || 'gh pr create failed.')
    }
    const url = extractPrUrl(res.stdout)
    if (!url) throw new Error('gh pr create did not return a pull-request URL.')

    // Prefer the authoritative summary; fall back to a URL-derived summary.
    const summary = await this.findPullRequest(dir)
    if (summary && summary.url === url) return summary
    return {
      number: extractPrNumber(url) ?? summary?.number ?? 0,
      url,
      title,
      state: 'open',
      baseRef,
      headRef: summary?.headRef ?? '',
    }
  }

  /** GitHub host for the primary remote, or null for non-GitHub remotes. */
  private async detectHost(dir: string): Promise<string | null> {
    const ctx = await this.repository.getContext(dir)
    if (!ctx.isGitRepository) return null
    const primary = ctx.remotes.find((r) => r.name === ctx.primaryRemote) ?? ctx.remotes[0]
    if (!primary) return null
    return parseGitHubHost(primary.fetchUrl ?? primary.pushUrl)
  }
}

// ---------------------------------------------------------------------------
// Default runner + pure helpers
// ---------------------------------------------------------------------------

function defaultRunner(ghPath: string): GhRunner {
  return (args, options) =>
    new Promise<GhResult>((resolve) => {
      const child = execFile(
        ghPath,
        args,
        {
          cwd: options.cwd,
          timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBuffer: 8 * 1024 * 1024,
          encoding: 'utf8',
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const out = typeof stdout === 'string' ? stdout : String(stdout ?? '')
          const err = typeof stderr === 'string' ? stderr : String(stderr ?? '')
          if (!error) {
            resolve({ stdout: out, stderr: err, exitCode: 0 })
            return
          }
          const e = error as NodeJS.ErrnoException & { code?: string | number }
          if (e.code === 'ENOENT') {
            resolve({ stdout: out, stderr: err, exitCode: -1, notFound: true })
            return
          }
          const exitCode = typeof e.code === 'number' ? e.code : 1
          resolve({ stdout: out, stderr: err, exitCode })
        },
      )
      if (options.input !== undefined && child.stdin) {
        child.stdin.end(options.input)
      }
    })
}

/**
 * Extract a GitHub host from a remote URL, or null when the URL is not a GitHub
 * remote. Handles `git@host:owner/repo`, `https://host/owner/repo`, and
 * `ssh://git@host/owner/repo` forms.
 */
export function parseGitHubHost(url: string | null): string | null {
  if (!url) return null
  let host: string | null = null
  const scp = url.match(/^[^@]+@([^:]+):/)
  if (scp) {
    host = scp[1]!
  } else {
    const m = url.match(/^[a-z]+:\/\/(?:[^@/]+@)?([^/:]+)/i)
    if (m) host = m[1]!
  }
  if (!host) return null
  return /github/i.test(host) ? host : null
}

export function parsePullRequestJson(stdout: string): PullRequestSummary | null {
  const trimmed = stdout.trim()
  if (!trimmed) return null
  let json: {
    number?: number
    url?: string
    title?: string
    state?: string
    baseRefName?: string
    headRefName?: string
  }
  try {
    json = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!json.url || typeof json.number !== 'number') return null
  return {
    number: json.number,
    url: json.url,
    title: json.title ?? '',
    state: mapPrState(json.state),
    baseRef: json.baseRefName ?? '',
    headRef: json.headRefName ?? '',
  }
}

function mapPrState(state: string | undefined): PullRequestSummary['state'] {
  switch ((state ?? '').toUpperCase()) {
    case 'MERGED':
      return 'merged'
    case 'CLOSED':
      return 'closed'
    default:
      return 'open'
  }
}

/** First https URL that looks like a GitHub PR link in `gh` output. */
export function extractPrUrl(stdout: string): string | null {
  const m = stdout.match(/https?:\/\/\S+\/pull\/\d+/)
  return m ? m[0] : null
}

export function extractPrNumber(url: string): number | null {
  const m = url.match(/\/pull\/(\d+)/)
  return m ? parseInt(m[1]!, 10) : null
}

function sanitize(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > 1000 ? `${trimmed.slice(0, 1000)}…` : trimmed
}
