import { describe, test, expect, afterEach } from 'bun:test'
import { chmodSync } from 'node:fs'
import { join } from 'node:path'
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

describe('RepositoryService.getStatus — publish state', () => {
  test('computes publishable/baseDelta counts and honors an explicit base ref', async () => {
    // Bare remote with an initial main commit.
    const remote = tmp()
    await runGit(['init', '--bare', '-b', 'main', remote], { cwd: process.cwd(), env: GIT_ENV })

    const work = tmp()
    await runGit(['clone', remote, work], { cwd: process.cwd(), env: GIT_ENV })
    await runGit(['config', 'user.name', 'Kata Test'], { cwd: work, env: GIT_ENV })
    await runGit(['config', 'user.email', 'test@kata.sh'], { cwd: work, env: GIT_ENV })
    writeFile(work, 'README.md', '# base\n')
    await git(work, ['add', '.'])
    await git(work, ['commit', '-m', 'base'])
    await git(work, ['push', '-u', 'origin', 'main'])

    // Feature branch with two commits, no upstream configured yet.
    await git(work, ['checkout', '-b', 'feature'])
    writeFile(work, 'a.txt', 'a\n')
    await git(work, ['add', '.'])
    await git(work, ['commit', '-m', 'a'])
    writeFile(work, 'b.txt', 'b\n')
    await git(work, ['add', '.'])
    await git(work, ['commit', '-m', 'b'])

    const before = await svc.getStatus(work)
    expect(before.upstream).toBeNull()
    // Two commits not yet on the remote → publishable, and two commits ahead of
    // origin/main → base delta.
    expect(before.publishableCommitCount).toBe(2)
    expect(before.baseDeltaCount).toBe(2)

    // After pushing + tracking, publishable clears but base delta remains.
    await git(work, ['push', '-u', 'origin', 'feature'])
    const after = await svc.getStatus(work)
    expect(after.upstream).toBe('origin/feature')
    expect(after.publishableCommitCount).toBe(0)
    expect(after.baseDeltaCount).toBe(2)
    expect(after.ahead).toBe(0)

    // An explicit base ref overrides the default-ref delta base.
    const vsFeature = await svc.getStatus(work, { baseRef: 'feature' })
    expect(vsFeature.baseRef).toBe('feature')
    expect(vsFeature.baseDeltaCount).toBe(0)
  })

  test('returns the latest commit subject and repository pull-request template', async () => {
    const work = tmp()
    await initRepo(work)
    writeFile(work, '.github/pull_request_template.md', '## Summary\n\nDescribe the change.\n')
    await git(work, ['add', '.github/pull_request_template.md'])
    await git(work, ['commit', '-m', 'feat: add PR defaults'])

    const status = await svc.getStatus(work)
    expect(status.latestCommitSubject).toBe('feat: add PR defaults')
    expect(status.pullRequestTemplate).toBe('## Summary\n\nDescribe the change.\n')
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

describe('getStatus — HEAD→working-tree consistency', () => {
  // The Changes surface is a single HEAD→working-tree view and the selected-file
  // commit stages from the working tree, so an entry whose *index* differs from
  // HEAD while its working-tree content matches HEAD has nothing to render and
  // nothing to commit. Listing it produced a file with a `clean` diff, no
  // counts, and a commit that failed with "no changes to commit".
  test('omits a staged change that the working tree reverted to HEAD', async () => {
    const dir = tmp()
    await initRepo(dir)
    writeFile(dir, 'reverted.txt', 'head\n')
    writeFile(dir, 'kept.txt', 'head\n')
    await git(dir, ['add', '.'])
    await git(dir, ['commit', '-m', 'add files'])

    // Stage new content for both files...
    writeFile(dir, 'reverted.txt', 'staged\n')
    writeFile(dir, 'kept.txt', 'staged\n')
    await git(dir, ['add', '.'])
    // ...then restore only one of them in the working tree. Git reports both as
    // changed (`MM` / `M.`), but only `kept.txt` has a HEAD→working-tree delta.
    writeFile(dir, 'reverted.txt', 'head\n')

    const status = await svc.getStatus(dir)
    const paths = status.entries.map((e) => e.path)
    expect(paths).toContain('kept.txt')
    expect(paths).not.toContain('reverted.txt')

    // And the omitted path is exactly the one the diff would render as clean.
    const diff = await svc.getFileDiff(dir, { path: 'reverted.txt', type: 'modified' })
    expect(diff.state).toBe('clean')
  })

  test('keeps a working-tree mode change, which has no line delta but is committable', async () => {
    const dir = tmp()
    await initRepo(dir)
    writeFile(dir, 'script.sh', '#!/bin/sh\necho hi\n')
    await git(dir, ['add', '.'])
    await git(dir, ['commit', '-m', 'add script'])
    // A real working-tree mode change: `git diff HEAD` reports it as `0 0`, so
    // the entry must survive even though it has no added or deleted lines.
    chmodSync(join(dir, 'script.sh'), 0o755)

    const status = await svc.getStatus(dir)
    expect(status.entries.map((e) => e.path)).toContain('script.sh')
  })

  test('keeps entries on an unborn branch, where there is no HEAD to diff', async () => {
    const dir = tmp()
    await runGit(['init', '-b', 'main', dir], { cwd: process.cwd(), env: GIT_ENV })
    await git(dir, ['config', 'user.name', 'Kata Test'])
    await git(dir, ['config', 'user.email', 'test@kata.sh'])
    writeFile(dir, 'staged.txt', 'new\n')
    writeFile(dir, 'untracked.txt', 'one\ntwo\n')
    await git(dir, ['add', 'staged.txt'])

    const status = await svc.getStatus(dir)
    const paths = status.entries.map((e) => e.path)
    expect(paths).toContain('staged.txt')
    expect(paths).toContain('untracked.txt')
    // Untracked line counts still attach when the numstat is unavailable.
    expect(status.entries.find((e) => e.path === 'untracked.txt')?.additions).toBe(2)
  })
})
