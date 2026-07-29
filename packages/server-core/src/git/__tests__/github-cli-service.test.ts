import { describe, test, expect, afterEach, beforeEach } from 'bun:test'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  GitHubCliService,
  parseGitHubHost,
  parsePullRequestJson,
  extractPrUrl,
  extractPrNumber,
} from '../github-cli-service'
import { RepositoryService } from '../repository-service'
import { initRepo, makeTmpDir, cleanup, git, GIT_ENV } from './test-helpers'

const FAKE_GH = join(import.meta.dir, 'fake-gh.cjs')
const repo = new RepositoryService()
const dirs: string[] = []
let logPath: string

function tmp(): string {
  const d = makeTmpDir()
  dirs.push(d)
  return d
}

async function githubRepo(): Promise<string> {
  const d = tmp()
  await initRepo(d)
  await git(d, ['remote', 'add', 'origin', 'git@github.com:owner/repo.git'])
  return d
}

/** Read the recorded invocations from the fake gh log. */
function invocations(): Array<{ argv: string[]; body?: string }> {
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

function service(env: Record<string, string> = {}): GitHubCliService {
  logPath = join(makeTmpDir('kata-gh-log-'), 'log.jsonl')
  dirs.push(join(logPath, '..'))
  for (const [k, v] of Object.entries(env)) process.env[k] = v
  process.env.GH_FAKE_LOG = logPath
  return new GitHubCliService(repo, { ghPath: FAKE_GH })
}

const GH_ENV_KEYS = [
  'GH_FAKE_LOG',
  'GH_FAKE_AUTHED',
  'GH_FAKE_HAS_PR',
  'GH_FAKE_PR_JSON',
  'GH_FAKE_PR_URL',
  'GH_FAKE_CREATE_FAIL',
]
beforeEach(() => {
  for (const k of GH_ENV_KEYS) delete process.env[k]
})
afterEach(() => {
  for (const k of GH_ENV_KEYS) delete process.env[k]
  while (dirs.length) cleanup(dirs.pop()!)
})

describe('pure helpers', () => {
  test('parseGitHubHost handles ssh/https/enterprise and rejects non-GitHub', () => {
    expect(parseGitHubHost('git@github.com:o/r.git')).toBe('github.com')
    expect(parseGitHubHost('https://github.com/o/r.git')).toBe('github.com')
    expect(parseGitHubHost('ssh://git@github.example.com/o/r')).toBe('github.example.com')
    expect(parseGitHubHost('git@gitlab.com:o/r.git')).toBeNull()
    expect(parseGitHubHost(null)).toBeNull()
  })
  test('parsePullRequestJson maps state and fields', () => {
    const pr = parsePullRequestJson(
      JSON.stringify({
        number: 12,
        url: 'https://github.com/o/r/pull/12',
        title: 'T',
        state: 'MERGED',
        baseRefName: 'main',
        headRefName: 'feat',
      }),
    )
    expect(pr).toEqual({
      number: 12,
      url: 'https://github.com/o/r/pull/12',
      title: 'T',
      state: 'merged',
      baseRef: 'main',
      headRef: 'feat',
    })
    expect(parsePullRequestJson('')).toBeNull()
    expect(parsePullRequestJson('not json')).toBeNull()
  })
  test('extractPrUrl / extractPrNumber', () => {
    expect(extractPrUrl('Created https://github.com/o/r/pull/9\n')).toBe(
      'https://github.com/o/r/pull/9',
    )
    expect(extractPrNumber('https://github.com/o/r/pull/9')).toBe(9)
  })
})

describe('GitHubCliService.getCapability', () => {
  test('reports installed + authenticated for a GitHub remote', async () => {
    const d = await githubRepo()
    const svc = service({ GH_FAKE_AUTHED: '1' })
    const cap = await svc.getCapability(d)
    expect(cap).toEqual({ installed: true, authenticated: true, host: 'github.com' })
    // Auth was queried against the detected host.
    const auth = invocations().find((i) => i.argv[0] === 'auth')
    expect(auth?.argv).toEqual(['auth', 'status', '--hostname', 'github.com'])
  })

  test('reports unauthenticated with setup guidance', async () => {
    const d = await githubRepo()
    const svc = service({ GH_FAKE_AUTHED: '0' })
    const cap = await svc.getCapability(d)
    expect(cap.installed).toBe(true)
    expect(cap.authenticated).toBe(false)
    expect(cap.detail).toMatch(/gh auth login/)
  })

  test('reports installed:false when gh is missing', async () => {
    const d = await githubRepo()
    const svc = new GitHubCliService(repo, { ghPath: join(import.meta.dir, 'no-such-gh') })
    const cap = await svc.getCapability(d)
    expect(cap.installed).toBe(false)
    expect(cap.authenticated).toBe(false)
  })

  test('reports a null host for a non-GitHub remote', async () => {
    const d = tmp()
    await initRepo(d)
    await git(d, ['remote', 'add', 'origin', 'git@gitlab.com:o/r.git'])
    const svc = service({ GH_FAKE_AUTHED: '1' })
    const cap = await svc.getCapability(d)
    expect(cap.installed).toBe(true)
    expect(cap.host).toBeNull()
    expect(cap.authenticated).toBe(false)
  })
})

describe('GitHubCliService.findPullRequest', () => {
  test('returns a summary when a PR exists', async () => {
    const d = await githubRepo()
    const svc = service({
      GH_FAKE_HAS_PR: '1',
      GH_FAKE_PR_JSON: JSON.stringify({
        number: 5,
        url: 'https://github.com/owner/repo/pull/5',
        title: 'Existing',
        state: 'OPEN',
        baseRefName: 'main',
        headRefName: 'feature',
      }),
    })
    const pr = await svc.findPullRequest(d)
    expect(pr?.number).toBe(5)
    expect(pr?.state).toBe('open')
    const view = invocations().find((i) => i.argv[1] === 'view')
    expect(view?.argv).toContain('--json')
  })

  test('returns null when no PR exists (never throws)', async () => {
    const d = await githubRepo()
    const svc = service({ GH_FAKE_HAS_PR: '0' })
    expect(await svc.findPullRequest(d)).toBeNull()
  })
})

describe('GitHubCliService.createPullRequest', () => {
  test('constructs args, passes the body on stdin, and returns the PR', async () => {
    const d = await githubRepo()
    const svc = service({
      GH_FAKE_PR_URL: 'https://github.com/owner/repo/pull/42',
      GH_FAKE_HAS_PR: '0',
    })
    const pr = await svc.createPullRequest({
      dir: d,
      title: 'My PR',
      body: 'Body line 1\nBody line 2',
      baseRef: 'main',
    })
    expect(pr.url).toBe('https://github.com/owner/repo/pull/42')
    expect(pr.number).toBe(42)
    expect(pr.state).toBe('open')

    const create = invocations().find((i) => i.argv[1] === 'create')!
    expect(create.argv).toEqual([
      'pr',
      'create',
      '--title',
      'My PR',
      '--body-file',
      '-',
      '--base',
      'main',
    ])
    expect(create.body).toBe('Body line 1\nBody line 2')
  })

  test('surfaces a sanitized error on failure', async () => {
    const d = await githubRepo()
    const svc = service({ GH_FAKE_CREATE_FAIL: '1' })
    await expect(
      svc.createPullRequest({ dir: d, title: 'x', body: '', baseRef: 'main' }),
    ).rejects.toThrow(/already exists/)
  })
})
