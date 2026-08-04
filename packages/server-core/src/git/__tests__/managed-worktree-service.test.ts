import { describe, test, expect, afterEach } from 'bun:test'
import { readFileSync, writeFileSync, existsSync, symlinkSync, mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { createGitServices } from '../index'
import type { ManagedWorktreeRecord } from '@kata-sh/shared/protocol'
import { RepositoryService } from '../repository-service'
import { initRepo, makeTmpDir, cleanup, git, writeFile, GIT_ENV } from './test-helpers'
import { runGit } from '../command-runner'

const cleanups: string[] = []
function tmp(): string {
  const d = makeTmpDir()
  cleanups.push(d)
  return d
}
afterEach(() => {
  while (cleanups.length) cleanup(cleanups.pop()!)
})

function servicesFor() {
  const worktreeRoot = tmp()
  return createGitServices({
    worktreeRoot,
    registryPath: join(worktreeRoot, 'registry.json'),
  })
}

async function commonDir(dir: string): Promise<string> {
  return (await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
}

describe('ManagedWorktreeService.createWorktree', () => {
  test('creates a kata-agent/<8-hex> branch and path under the worktree root', async () => {
    const repo = tmp()
    await initRepo(repo)
    const svc = servicesFor()
    const gcd = await commonDir(repo)

    const { record } = await svc.worktrees.createWorktree({
      workspaceId: 'ws1',
      sessionId: 'sess1',
      repositoryRoot: repo,
      gitCommonDir: gcd,
      baseRef: 'main',
    })

    expect(record.expectedBranch).toMatch(/^kata-agent\/[0-9a-f]{8}$/)
    expect(record.state).toBe('ready')
    expect(svc.worktrees.isUnderWorktreeRoot(record.checkoutPath)).toBe(true)
    expect(existsSync(record.checkoutPath)).toBe(true)
    expect(record.ownerSessionIds).toEqual(['sess1'])

    // The branch exists in the repo.
    const branches = await git(repo, ['branch', '--list', record.expectedBranch])
    expect(branches).toContain(record.expectedBranch)

    // Registry persisted it.
    expect(svc.registry.get(record.managedWorktreeId)).toBeTruthy()
  })

  test('a worktree created from a remote-tracking base ref inherits no upstream tracking', async () => {
    // UAT regression: without --no-track, `git worktree add -b <branch> <path>
    // origin/main` sets branch.<branch>.merge=refs/heads/main
    // (branch.autoSetupMerge), and the first push then fails with "The
    // upstream branch of your current branch does not match the name of your
    // current branch."
    const remote = tmp()
    await runGit(['init', '--bare', '-b', 'main', remote], { cwd: process.cwd(), env: GIT_ENV })
    const repo = tmp()
    await initRepo(repo)
    await git(repo, ['remote', 'add', 'origin', remote])
    await git(repo, ['push', '-u', 'origin', 'main'])

    const svc = servicesFor()
    const gcd = await commonDir(repo)
    const { record } = await svc.worktrees.createWorktree({
      workspaceId: 'ws1',
      sessionId: 'sess1',
      repositoryRoot: repo,
      gitCommonDir: gcd,
      baseRef: 'origin/main',
    })

    const upstream = await runGit(
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
      { cwd: record.checkoutPath, env: GIT_ENV, okExitCodes: [128] },
    )
    expect(upstream.exitCode).toBe(128)
    const mergeCfg = await runGit(['config', '--get', `branch.${record.expectedBranch}.merge`], {
      cwd: repo,
      env: GIT_ENV,
      okExitCodes: [1],
    })
    expect(mergeCfg.exitCode).toBe(1)
  })

  test('rejects an unknown base ref', async () => {
    const repo = tmp()
    await initRepo(repo)
    const svc = servicesFor()
    const gcd = await commonDir(repo)
    await expect(
      svc.worktrees.createWorktree({
        workspaceId: 'ws1',
        sessionId: 'sess1',
        repositoryRoot: repo,
        gitCommonDir: gcd,
        baseRef: 'does-not-exist',
      }),
    ).rejects.toMatchObject({ code: 'BASE_REF_NOT_FOUND' })
  })

  test('two managed worktrees isolate uncommitted content on the same path', async () => {
    const repo = tmp()
    await initRepo(repo)
    writeFile(repo, 'src.txt', 'base\n')
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '-m', 'add src'])
    const svc = servicesFor()
    const gcd = await commonDir(repo)

    const a = await svc.worktrees.createWorktree({
      workspaceId: 'ws1',
      sessionId: 'sessA',
      repositoryRoot: repo,
      gitCommonDir: gcd,
      baseRef: 'main',
    })
    const b = await svc.worktrees.createWorktree({
      workspaceId: 'ws1',
      sessionId: 'sessB',
      repositoryRoot: repo,
      gitCommonDir: gcd,
      baseRef: 'main',
    })

    writeFileSync(join(a.record.checkoutPath, 'src.txt'), 'edited by A\n')
    writeFileSync(join(b.record.checkoutPath, 'src.txt'), 'edited by B\n')

    expect(readFileSync(join(a.record.checkoutPath, 'src.txt'), 'utf8')).toBe('edited by A\n')
    expect(readFileSync(join(b.record.checkoutPath, 'src.txt'), 'utf8')).toBe('edited by B\n')
    // Different checkout paths and branches.
    expect(a.record.checkoutPath).not.toBe(b.record.checkoutPath)
    expect(a.record.expectedBranch).not.toBe(b.record.expectedBranch)
  })

  test('does not copy uncommitted Current checkout changes into a new worktree', async () => {
    const repo = tmp()
    await initRepo(repo)
    // Dirty, uncommitted change in the source checkout.
    writeFile(repo, 'README.md', '# dirty uncommitted\n')
    const svc = servicesFor()
    const gcd = await commonDir(repo)
    const { record } = await svc.worktrees.createWorktree({
      workspaceId: 'ws1',
      sessionId: 'sessA',
      repositoryRoot: repo,
      gitCommonDir: gcd,
      baseRef: 'main',
    })
    // Worktree starts from committed state, not the dirty working tree.
    expect(readFileSync(join(record.checkoutPath, 'README.md'), 'utf8')).toBe('# test repo\n')
  })
})

describe('.worktreeinclude', () => {
  test('copies matching gitignored files, skips symlinks, never overwrites', async () => {
    const repo = tmp()
    await initRepo(repo)
    // gitignore .env and node_modules
    writeFile(repo, '.gitignore', '.env\nsecrets/\n')
    writeFile(repo, '.worktreeinclude', '.env\nsecrets/\n')
    await git(repo, ['add', '.gitignore', '.worktreeinclude'])
    await git(repo, ['commit', '-m', 'add ignore + include'])
    // Create gitignored regular files.
    writeFile(repo, '.env', 'SECRET=1\n')
    writeFile(repo, 'secrets/key.txt', 'topsecret\n')
    // Create a symlink that matches include (should be skipped).
    writeFile(repo, 'secrets/real.txt', 'real\n')
    symlinkSync(join(repo, 'secrets/real.txt'), join(repo, 'secrets/link.txt'))

    const svc = servicesFor()
    const gcd = await commonDir(repo)
    const { record, include } = await svc.worktrees.createWorktree({
      workspaceId: 'ws1',
      sessionId: 'sessA',
      repositoryRoot: repo,
      gitCommonDir: gcd,
      baseRef: 'main',
    })

    expect(existsSync(join(record.checkoutPath, '.env'))).toBe(true)
    expect(readFileSync(join(record.checkoutPath, '.env'), 'utf8')).toBe('SECRET=1\n')
    expect(existsSync(join(record.checkoutPath, 'secrets/key.txt'))).toBe(true)
    expect(include.copiedFileCount).toBeGreaterThanOrEqual(2)
    expect(include.skippedSymlinks).toBeGreaterThanOrEqual(1)
    // The symlink itself was not copied as a real file.
    expect(existsSync(join(record.checkoutPath, 'secrets/link.txt'))).toBe(false)
  })
})

describe('shared ownership and removal', () => {
  test('a shared worktree cannot be removed while another owner remains', async () => {
    const repo = tmp()
    await initRepo(repo)
    const svc = servicesFor()
    const gcd = await commonDir(repo)
    const { record } = await svc.worktrees.createWorktree({
      workspaceId: 'ws1',
      sessionId: 'parent',
      repositoryRoot: repo,
      gitCommonDir: gcd,
      baseRef: 'main',
    })
    // Conversation branch adds an owner.
    svc.worktrees.addOwner(record.managedWorktreeId, 'child')
    expect(svc.worktrees.getOwnerCount(record.managedWorktreeId)).toBe(2)

    // Deleting the child: the parent still owns it → removal blocked.
    const risk = await svc.worktrees.inspectRemoval(record.managedWorktreeId, 'child')
    expect(risk.blocked).toBe(true)
    expect(risk.otherOwnerCount).toBe(1)
    const res = await svc.worktrees.removeWorktree(record.managedWorktreeId, 'child')
    expect(res.removed).toBe(false)
    expect(res.blocked).toBe(true)
    expect(existsSync(record.checkoutPath)).toBe(true)
  })

  test('removes a clean worktree and prunes its temporary branch for the final owner', async () => {
    const repo = tmp()
    await initRepo(repo)
    const svc = servicesFor()
    const gcd = await commonDir(repo)
    const { record } = await svc.worktrees.createWorktree({
      workspaceId: 'ws1',
      sessionId: 'only',
      repositoryRoot: repo,
      gitCommonDir: gcd,
      baseRef: 'main',
    })
    const res = await svc.worktrees.removeWorktree(record.managedWorktreeId, 'only')
    expect(res.removed).toBe(true)
    expect(res.branchPruned).toBe(true)
    expect(existsSync(record.checkoutPath)).toBe(false)
    expect(svc.registry.get(record.managedWorktreeId)).toBeUndefined()
    const branches = await git(repo, ['branch', '--list', record.expectedBranch])
    expect(branches.trim()).toBe('')
  })
})

describe('workspaceIdOf legacy fallback', () => {
  test('derives the workspace id from a backslash-delimited relative path (Windows layout)', () => {
    const worktreeRoot = tmp()
    const svc = createGitServices({
      worktreeRoot,
      registryPath: join(worktreeRoot, 'registry.json'),
    })
    // Legacy records predate `workspaceId`; the id is derived from the first
    // segment of the checkout path relative to the worktree root. On Windows
    // `relative()` is backslash-delimited, so both separators must split.
    const record: ManagedWorktreeRecord = {
      managedWorktreeId: 'm1',
      repositoryRoot: join(worktreeRoot, 'repo'),
      gitCommonDir: join(worktreeRoot, 'repo', '.git'),
      checkoutPath: join(realpathSync(worktreeRoot), 'ws_123\\repo-key\\token'),
      baseRef: 'main',
      expectedBranch: 'kata-agent/aabbccdd',
      createdAt: 0,
      ownerSessionIds: [],
      state: 'ready',
    }
    expect(svc.worktrees.workspaceIdOf(record)).toBe('ws_123')
  })

  test('returns null when the checkout path escapes the worktree root', () => {
    const worktreeRoot = tmp()
    const svc = createGitServices({
      worktreeRoot,
      registryPath: join(worktreeRoot, 'registry.json'),
    })
    const record: ManagedWorktreeRecord = {
      managedWorktreeId: 'm2',
      repositoryRoot: '/elsewhere/repo',
      gitCommonDir: '/elsewhere/repo/.git',
      checkoutPath: '/elsewhere/ws_9/repo-key/token',
      baseRef: null,
      expectedBranch: 'kata-agent/aabbccdd',
      createdAt: 0,
      ownerSessionIds: [],
      state: 'ready',
    }
    expect(svc.worktrees.workspaceIdOf(record)).toBeNull()
  })
})
