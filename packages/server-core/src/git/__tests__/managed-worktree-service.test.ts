import { describe, test, expect, afterEach } from 'bun:test'
import { readFileSync, writeFileSync, existsSync, symlinkSync, mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { createGitServices } from '../index'
import type { ManagedWorktreeRecord, ManagedWorktreeRecordV2 } from '@kata-sh/shared/protocol'
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

  test('creates a named V2 worktree with the exact requested branch and a safe unique leaf', async () => {
    const previousV1 = process.env.KATA_FEATURE_GIT_WORKSPACE_V1
    const previousV2 = process.env.KATA_FEATURE_WORKTREE_V2
    process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = '1'
    process.env.KATA_FEATURE_WORKTREE_V2 = '1'
    try {
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
        worktreeNameSuffix: 'auth-refresh',
      })

      expect(record).toMatchObject({
        schemaVersion: 2,
        displayName: 'auth-refresh',
        expectedBranch: 'kata-agent/auth-refresh',
        materializationRoot: svc.worktreeSettings.getSnapshot().materializationRoot,
        lastUsedAt: expect.any(Number),
      })
      expect(record.checkoutPath).toMatch(/auth-refresh-[0-9a-f]{8}$/)
      expect(existsSync(record.checkoutPath)).toBe(true)
      expect(await git(repo, ['branch', '--list', 'kata-agent/auth-refresh'])).toContain(
        'kata-agent/auth-refresh',
      )
    } finally {
      if (previousV1 === undefined) delete process.env.KATA_FEATURE_GIT_WORKSPACE_V1
      else process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = previousV1
      if (previousV2 === undefined) delete process.env.KATA_FEATURE_WORKTREE_V2
      else process.env.KATA_FEATURE_WORKTREE_V2 = previousV2
    }
  })

  test('rejects a named worktree when the requested branch already exists without residue', async () => {
    const previousV1 = process.env.KATA_FEATURE_GIT_WORKSPACE_V1
    const previousV2 = process.env.KATA_FEATURE_WORKTREE_V2
    process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = '1'
    process.env.KATA_FEATURE_WORKTREE_V2 = '1'
    try {
      const repo = tmp()
      await initRepo(repo)
      await git(repo, ['branch', 'kata-agent/auth-refresh'])
      const svc = servicesFor()
      const gcd = await commonDir(repo)
      const registryPath = svc.registry.getRegistryPath()
      const beforeRegistry = existsSync(registryPath) ? readFileSync(registryPath, 'utf8') : null

      await expect(
        svc.worktrees.createWorktree({
          workspaceId: 'ws1',
          sessionId: 'sess1',
          repositoryRoot: repo,
          gitCommonDir: gcd,
          baseRef: 'main',
          worktreeNameSuffix: 'auth-refresh',
        }),
      ).rejects.toMatchObject({ code: 'WORKTREE_BRANCH_COLLISION' })

      expect(existsSync(join(svc.worktreeSettings.getSnapshot().materializationRoot, 'ws1'))).toBe(false)
      expect(svc.registry.list()).toEqual([])
      expect(existsSync(registryPath) ? readFileSync(registryPath, 'utf8') : null).toBe(beforeRegistry)
    } finally {
      if (previousV1 === undefined) delete process.env.KATA_FEATURE_GIT_WORKSPACE_V1
      else process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = previousV1
      if (previousV2 === undefined) delete process.env.KATA_FEATURE_WORKTREE_V2
      else process.env.KATA_FEATURE_WORKTREE_V2 = previousV2
    }
  })

  test('retains an externally changed branch during compensation', async () => {
    const previousV1 = process.env.KATA_FEATURE_GIT_WORKSPACE_V1
    const previousV2 = process.env.KATA_FEATURE_WORKTREE_V2
    process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = '1'
    process.env.KATA_FEATURE_WORKTREE_V2 = '1'
    try {
      const repo = tmp()
      await initRepo(repo)
      const replacementOid = (await git(repo, ['rev-parse', 'HEAD'])).trim()
      await git(repo, ['commit', '--allow-empty', '-m', 'replacement'])
      const svc = servicesFor()
      const gcd = await commonDir(repo)
      const originalGetContext = svc.repository.getContext.bind(svc.repository)
      let injected = false
      ;(svc.repository as any).getContext = async (dir: string) => {
        const context = await originalGetContext(dir)
        if (!injected) {
          injected = true
          await git(repo, ['update-ref', 'refs/heads/kata-agent/auth-refresh', replacementOid])
          throw new Error('injected identity failure')
        }
        return context
      }

      await expect(
        svc.worktrees.createWorktree({
          workspaceId: 'ws1',
          sessionId: 'sess1',
          repositoryRoot: repo,
          gitCommonDir: gcd,
          baseRef: 'main',
          worktreeNameSuffix: 'auth-refresh',
        }),
      ).rejects.toThrow(/injected identity failure/)

      const retained = svc.registry.list()
      expect(retained).toHaveLength(1)
      expect(retained[0]).toMatchObject({
        state: 'blocked',
        expectedBranch: 'kata-agent/auth-refresh',
      })
      expect((await git(repo, ['branch', '--list', 'kata-agent/auth-refresh'])).trim()).toContain(
        'kata-agent/auth-refresh',
      )
    } finally {
      if (previousV1 === undefined) delete process.env.KATA_FEATURE_GIT_WORKSPACE_V1
      else process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = previousV1
      if (previousV2 === undefined) delete process.env.KATA_FEATURE_WORKTREE_V2
      else process.env.KATA_FEATURE_WORKTREE_V2 = previousV2
    }
  })

  test('retains a branch changed before the first ownership capture', async () => {
    const previousV1 = process.env.KATA_FEATURE_GIT_WORKSPACE_V1
    const previousV2 = process.env.KATA_FEATURE_WORKTREE_V2
    process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = '1'
    process.env.KATA_FEATURE_WORKTREE_V2 = '1'
    try {
      const repo = tmp()
      await initRepo(repo)
      const baseOid = (await git(repo, ['rev-parse', 'HEAD'])).trim()
      await git(repo, ['commit', '--allow-empty', '-m', 'replacement'])
      const replacementOid = (await git(repo, ['rev-parse', 'HEAD'])).trim()
      await git(repo, ['reset', '--hard', baseOid])
      const svc = servicesFor()
      const gcd = await commonDir(repo)
      const originalGetBranchOid = (svc.worktrees as any).getBranchOid.bind(svc.worktrees)
      let injected = false
      ;(svc.worktrees as any).getBranchOid = async (root: string, branch: string) => {
        const observedOid = await originalGetBranchOid(root, branch)
        if (!injected) {
          injected = true
          await git(repo, ['update-ref', `refs/heads/${branch}`, replacementOid])
          return replacementOid
        }
        return observedOid
      }

      await expect(
        svc.worktrees.createWorktree({
          workspaceId: 'ws1',
          sessionId: 'sess1',
          repositoryRoot: repo,
          gitCommonDir: gcd,
          baseRef: 'main',
          worktreeNameSuffix: 'auth-refresh',
        }),
      ).rejects.toMatchObject({ code: 'WORKTREE_BRANCH_OWNERSHIP_UNKNOWN' })

      expect(svc.registry.list()).toEqual([])
      expect((await git(repo, ['branch', '--list', 'kata-agent/auth-refresh'])).trim()).toContain(
        'kata-agent/auth-refresh',
      )
    } finally {
      if (previousV1 === undefined) delete process.env.KATA_FEATURE_GIT_WORKSPACE_V1
      else process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = previousV1
      if (previousV2 === undefined) delete process.env.KATA_FEATURE_WORKTREE_V2
      else process.env.KATA_FEATURE_WORKTREE_V2 = previousV2
    }
  })

  test('rejects invalid named branch suffixes before Git mutation', async () => {
    const previousV1 = process.env.KATA_FEATURE_GIT_WORKSPACE_V1
    const previousV2 = process.env.KATA_FEATURE_WORKTREE_V2
    process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = '1'
    process.env.KATA_FEATURE_WORKTREE_V2 = '1'
    try {
      const repo = tmp()
      await initRepo(repo)
      const svc = servicesFor()
      const gcd = await commonDir(repo)

      for (const worktreeNameSuffix of ['', ' auth-refresh', 'auth-refresh ', '../escape']) {
        await expect(
          svc.worktrees.createWorktree({
            workspaceId: 'ws1',
            sessionId: `sess-${worktreeNameSuffix || 'empty'}`,
            repositoryRoot: repo,
            gitCommonDir: gcd,
            baseRef: 'main',
            worktreeNameSuffix,
          }),
        ).rejects.toMatchObject({ code: 'WORKTREE_NAME_INVALID' })
      }
      expect((await git(repo, ['branch', '--list', 'kata-agent/*'])).trim()).toBe('')
      expect(svc.registry.list()).toEqual([])
    } finally {
      if (previousV1 === undefined) delete process.env.KATA_FEATURE_GIT_WORKSPACE_V1
      else process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = previousV1
      if (previousV2 === undefined) delete process.env.KATA_FEATURE_WORKTREE_V2
      else process.env.KATA_FEATURE_WORKTREE_V2 = previousV2
    }
  })

  test('allows nested and Unicode branch suffixes while keeping the leaf path safe', async () => {
    const previousV1 = process.env.KATA_FEATURE_GIT_WORKSPACE_V1
    const previousV2 = process.env.KATA_FEATURE_WORKTREE_V2
    process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = '1'
    process.env.KATA_FEATURE_WORKTREE_V2 = '1'
    try {
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
        worktreeNameSuffix: 'team/認証-refresh',
      })

      expect(record.expectedBranch).toBe('kata-agent/team/認証-refresh')
      expect((record as ManagedWorktreeRecordV2).displayName).toBe('team/認証-refresh')
      expect(record.checkoutPath).toMatch(/team-認証-refresh-[0-9a-f]{8}$/)
    } finally {
      if (previousV1 === undefined) delete process.env.KATA_FEATURE_GIT_WORKSPACE_V1
      else process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = previousV1
      if (previousV2 === undefined) delete process.env.KATA_FEATURE_WORKTREE_V2
      else process.env.KATA_FEATURE_WORKTREE_V2 = previousV2
    }
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

  test('uses the root captured from server-owned settings for new materializations', async () => {
    const previousV1 = process.env.KATA_FEATURE_GIT_WORKSPACE_V1
    const previousV2 = process.env.KATA_FEATURE_WORKTREE_V2
    process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = '1'
    process.env.KATA_FEATURE_WORKTREE_V2 = '1'
    try {
      const repo = tmp()
      await initRepo(repo)
      const svc = servicesFor()
      const customRoot = tmp()
      const snapshot = svc.worktreeSettings.update({ materializationRoot: customRoot })
      const gcd = await commonDir(repo)

      const { record } = await svc.worktrees.createWorktree({
        workspaceId: 'ws1',
        sessionId: 'sessA',
        repositoryRoot: repo,
        gitCommonDir: gcd,
        baseRef: 'main',
      })

      expect(record.checkoutPath.startsWith(snapshot.materializationRoot)).toBe(true)
      expect(svc.registry.get(record.managedWorktreeId)).toMatchObject({
        materializationRoot: snapshot.materializationRoot,
      })
    } finally {
      if (previousV1 === undefined) delete process.env.KATA_FEATURE_GIT_WORKSPACE_V1
      else process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = previousV1
      if (previousV2 === undefined) delete process.env.KATA_FEATURE_WORKTREE_V2
      else process.env.KATA_FEATURE_WORKTREE_V2 = previousV2
    }
  })

  test('revalidates a V2 root against the selected repository at creation time', async () => {
    const previousV1 = process.env.KATA_FEATURE_GIT_WORKSPACE_V1
    const previousV2 = process.env.KATA_FEATURE_WORKTREE_V2
    process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = '1'
    process.env.KATA_FEATURE_WORKTREE_V2 = '1'
    try {
      const repo = tmp()
      await initRepo(repo)
      const svc = servicesFor()
      const customRoot = join(repo, 'inside-repository')
      svc.worktreeSettings.update({ materializationRoot: customRoot })

      await expect(
        svc.worktrees.createWorktree({
          workspaceId: 'ws1',
          sessionId: 'sessA',
          repositoryRoot: repo,
          gitCommonDir: await commonDir(repo),
          baseRef: 'main',
        }),
      ).rejects.toMatchObject({ code: 'WORKTREE_SETTINGS_REPOSITORY_OVERLAP' })
    } finally {
      if (previousV1 === undefined) delete process.env.KATA_FEATURE_GIT_WORKSPACE_V1
      else process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = previousV1
      if (previousV2 === undefined) delete process.env.KATA_FEATURE_WORKTREE_V2
      else process.env.KATA_FEATURE_WORKTREE_V2 = previousV2
    }
  })

  test('rejects symlinked destination components before Git materialization', async () => {
    const previousV1 = process.env.KATA_FEATURE_GIT_WORKSPACE_V1
    const previousV2 = process.env.KATA_FEATURE_WORKTREE_V2
    process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = '1'
    process.env.KATA_FEATURE_WORKTREE_V2 = '1'
    try {
      const repo = tmp()
      await initRepo(repo)
      const svc = servicesFor()
      const customRoot = tmp()
      const outside = tmp()
      svc.worktreeSettings.update({ materializationRoot: customRoot })
      symlinkSync(outside, join(customRoot, 'ws1'))

      await expect(
        svc.worktrees.createWorktree({
          workspaceId: 'ws1',
          sessionId: 'sessA',
          repositoryRoot: repo,
          gitCommonDir: await commonDir(repo),
          baseRef: 'main',
        }),
      ).rejects.toMatchObject({ code: 'WORKTREE_DESTINATION_UNSAFE' })
    } finally {
      if (previousV1 === undefined) delete process.env.KATA_FEATURE_GIT_WORKSPACE_V1
      else process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = previousV1
      if (previousV2 === undefined) delete process.env.KATA_FEATURE_WORKTREE_V2
      else process.env.KATA_FEATURE_WORKTREE_V2 = previousV2
    }
  })

  test('uses the fixed V1 root while V2 settings are ineffective', async () => {
    const previousV1 = process.env.KATA_FEATURE_GIT_WORKSPACE_V1
    const previousV2 = process.env.KATA_FEATURE_WORKTREE_V2
    process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = '1'
    process.env.KATA_FEATURE_WORKTREE_V2 = '1'
    try {
      const repo = tmp()
      await initRepo(repo)
      const svc = servicesFor()
      const customRoot = tmp()
      svc.worktreeSettings.update({ materializationRoot: customRoot })
      process.env.KATA_FEATURE_WORKTREE_V2 = '0'

      const { record } = await svc.worktrees.createWorktree({
        workspaceId: 'ws1',
        sessionId: 'sessA',
        repositoryRoot: repo,
        gitCommonDir: await commonDir(repo),
        baseRef: 'main',
      })

      expect(record.checkoutPath.startsWith(svc.worktreeSettings.getDefaultRoot())).toBe(true)
      expect(record.checkoutPath.startsWith(customRoot)).toBe(false)
    } finally {
      if (previousV1 === undefined) delete process.env.KATA_FEATURE_GIT_WORKSPACE_V1
      else process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = previousV1
      if (previousV2 === undefined) delete process.env.KATA_FEATURE_WORKTREE_V2
      else process.env.KATA_FEATURE_WORKTREE_V2 = previousV2
    }
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

describe('managed worktree discovery summaries', () => {
  test('keeps legacy summaries when V2 is disabled and exposes metadata when enabled', async () => {
    const originalV1 = process.env.KATA_FEATURE_GIT_WORKSPACE_V1
    const originalV2 = process.env.KATA_FEATURE_WORKTREE_V2
    process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = '1'
    process.env.KATA_FEATURE_WORKTREE_V2 = '0'
    try {
      const repo = tmp()
      await initRepo(repo)
      const worktreeRoot = tmp()
      const svc = createGitServices({
        worktreeRoot,
        registryPath: join(worktreeRoot, 'registry.json'),
      })
      const gcd = await commonDir(repo)
      const { record } = await svc.worktrees.createWorktree({
        workspaceId: 'ws1',
        sessionId: 'sess1',
        repositoryRoot: repo,
        gitCommonDir: gcd,
        baseRef: 'main',
      })

      expect(svc.worktrees.listManagedWorktrees('ws1', gcd)).toEqual([{
        managedWorktreeId: record.managedWorktreeId,
        checkoutPath: record.checkoutPath,
        expectedBranch: record.expectedBranch,
        baseRef: 'main',
        ownerCount: 1,
        state: 'ready',
      }])

      process.env.KATA_FEATURE_WORKTREE_V2 = '1'
      const versioned = svc.worktrees.listManagedWorktrees('ws1', gcd)
      expect(versioned).toEqual([{
        schemaVersion: 2,
        managedWorktreeId: record.managedWorktreeId,
        checkoutPath: record.checkoutPath,
        displayName: record.expectedBranch.slice('kata-agent/'.length),
        expectedBranch: record.expectedBranch,
        materializationRoot: svc.worktreeSettings.getSnapshot().materializationRoot,
        baseRef: 'main',
        ownerCount: 1,
        state: 'ready',
      }])
    } finally {
      if (originalV1 === undefined) delete process.env.KATA_FEATURE_GIT_WORKSPACE_V1
      else process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = originalV1
      if (originalV2 === undefined) delete process.env.KATA_FEATURE_WORKTREE_V2
      else process.env.KATA_FEATURE_WORKTREE_V2 = originalV2
    }
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
