import { describe, test, expect, afterEach } from 'bun:test'
import { RepositoryService, detectProvider, parsePorcelainV2 } from '../repository-service'
import { runGit } from '../command-runner'
import { initRepo, makeTmpDir, cleanup, git, writeFile, GIT_ENV } from './test-helpers'

const svc = new RepositoryService()
const dirs: string[] = []
function tmp(): string {
  const d = makeTmpDir()
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!)
})

describe('detectProvider', () => {
  test('classifies known hosts', () => {
    expect(detectProvider('git@github.com:foo/bar.git')).toBe('github')
    expect(detectProvider('https://gitlab.com/foo/bar.git')).toBe('gitlab')
    expect(detectProvider('https://bitbucket.org/foo/bar')).toBe('bitbucket')
    expect(detectProvider('https://example.com/foo.git')).toBe('other')
    expect(detectProvider(null)).toBe('unknown')
  })
})

describe('parsePorcelainV2', () => {
  test('handles paths with spaces and unusual characters', () => {
    // Untracked entries: `? <path>` NUL-terminated
    const out = '? weird name.txt\0? a"b.txt\0'
    const entries = parsePorcelainV2(out)
    expect(entries).toHaveLength(2)
    expect(entries[0]!.path).toBe('weird name.txt')
    expect(entries[0]!.type).toBe('untracked')
    expect(entries[1]!.path).toBe('a"b.txt')
  })
})

describe('RepositoryService.getContext', () => {
  test('returns non-git result for a plain directory', async () => {
    const d = tmp()
    const ctx = await svc.getContext(d)
    expect(ctx.isGitRepository).toBe(false)
    expect(ctx.repositoryRoot).toBeNull()
    expect(ctx.currentBranch).toBeNull()
  })

  test('discovers repository root, branch, and common dir', async () => {
    const d = tmp()
    await initRepo(d)
    const ctx = await svc.getContext(d)
    expect(ctx.isGitRepository).toBe(true)
    expect(ctx.repositoryRoot).toBe(require('node:fs').realpathSync(d))
    expect(ctx.currentBranch).toBe('main')
    expect(ctx.detached).toBe(false)
    expect(ctx.gitCommonDir).toContain('.git')
    expect(ctx.headSha).toBeTruthy()
  })

  test('detects github provider and primary remote', async () => {
    const d = tmp()
    await initRepo(d)
    await git(d, ['remote', 'add', 'origin', 'git@github.com:foo/bar.git'])
    const ctx = await svc.getContext(d)
    expect(ctx.primaryRemote).toBe('origin')
    expect(ctx.provider).toBe('github')
    expect(ctx.remotes[0]!.fetchUrl).toContain('github.com')
  })

  test('reports detached HEAD', async () => {
    const d = tmp()
    await initRepo(d)
    const sha = (await git(d, ['rev-parse', 'HEAD'])).trim()
    await git(d, ['checkout', sha])
    const ctx = await svc.getContext(d)
    expect(ctx.detached).toBe(true)
    expect(ctx.currentBranch).toBeNull()
  })
})

describe('RepositoryService.listRefs', () => {
  test('lists local branches and marks current', async () => {
    const d = tmp()
    await initRepo(d)
    await git(d, ['branch', 'feature/x'])
    const { refs, currentBranch } = await svc.listRefs(d)
    const names = refs.filter((r) => r.type === 'local').map((r) => r.name).sort()
    expect(names).toEqual(['feature/x', 'main'])
    expect(currentBranch).toBe('main')
    expect(refs.find((r) => r.name === 'main')!.isCurrent).toBe(true)
  })

  test('lists tags', async () => {
    const d = tmp()
    await initRepo(d)
    await git(d, ['tag', 'v1.0.0'])
    const { refs } = await svc.listRefs(d)
    expect(refs.some((r) => r.type === 'tag' && r.name === 'v1.0.0')).toBe(true)
  })
})

describe('RepositoryService.getStatus', () => {
  test('counts modified, added, and untracked entries', async () => {
    const d = tmp()
    await initRepo(d)
    writeFile(d, 'README.md', '# changed\n')
    writeFile(d, 'new.txt', 'new file\n')
    await git(d, ['add', 'new.txt'])
    writeFile(d, 'untracked.txt', 'untracked\n')
    const status = await svc.getStatus(d)
    const paths = status.entries.map((e) => e.path).sort()
    expect(paths).toContain('README.md')
    expect(paths).toContain('new.txt')
    expect(paths).toContain('untracked.txt')
    expect(status.entries.find((e) => e.path === 'untracked.txt')!.type).toBe('untracked')
    expect(status.entries.find((e) => e.path === 'new.txt')!.type).toBe('added')
  })

  test('parses rename entries with previous path', async () => {
    const d = tmp()
    await initRepo(d)
    writeFile(d, 'a.txt', 'contents\n')
    await git(d, ['add', 'a.txt'])
    await git(d, ['commit', '-m', 'add a'])
    await git(d, ['mv', 'a.txt', 'b.txt'])
    const status = await svc.getStatus(d)
    const renamed = status.entries.find((e) => e.type === 'renamed')
    expect(renamed).toBeTruthy()
    expect(renamed!.path).toBe('b.txt')
    expect(renamed!.previousPath).toBe('a.txt')
  })
})

describe('command-runner', () => {
  test('throws structured error for unknown git subcommand', async () => {
    const d = tmp()
    await initRepo(d)
    await expect(runGit(['not-a-real-subcommand'], { cwd: d, env: GIT_ENV })).rejects.toMatchObject({
      code: 'GIT_COMMAND_FAILED',
    })
  })
})
