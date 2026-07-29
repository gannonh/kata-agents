import { describe, test, expect, afterEach } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createGitServices } from '../index'
import { parseWorktreeListPorcelain } from '../managed-worktree-service'
import { initRepo, makeTmpDir, cleanup, git } from './test-helpers'

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

describe('parseWorktreeListPorcelain', () => {
  test('parses worktree paths and branches from porcelain output', () => {
    const output = [
      'worktree /repo',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /wt/kata',
      'HEAD def456',
      'branch refs/heads/kata-agent/aabbccdd',
      '',
      'worktree /wt/detached',
      'HEAD 999',
      'detached',
      '',
    ].join('\n')
    const parsed = parseWorktreeListPorcelain(output)
    expect(parsed).toEqual([
      { path: '/repo', branch: 'main' },
      { path: '/wt/kata', branch: 'kata-agent/aabbccdd' },
      { path: '/wt/detached', branch: null },
    ])
  })
})

describe('ManagedWorktreeService.reconcile', () => {
  test('drops owner references for sessions that no longer exist, keeps the record', async () => {
    const repo = tmp()
    await initRepo(repo)
    const svc = servicesFor()
    const gcd = await commonDir(repo)
    const { record } = await svc.worktrees.createWorktree({
      workspaceId: 'ws1',
      sessionId: 'ghost',
      repositoryRoot: repo,
      gitCommonDir: gcd,
      baseRef: 'main',
    })

    const report = await svc.worktrees.reconcile({ knownSessionIds: new Set<string>() })

    const rec = svc.registry.get(record.managedWorktreeId)
    expect(rec).toBeTruthy()
    expect(rec!.ownerSessionIds).toEqual([])
    expect(report.repairedOwnerRefs).toBe(0)
    expect(report.droppedOwnerRefs).toBeGreaterThanOrEqual(1)
  })

  test('repairs a derivable owner reference from persisted session checkout', async () => {
    const repo = tmp()
    await initRepo(repo)
    const svc = servicesFor()
    const gcd = await commonDir(repo)
    const { record } = await svc.worktrees.createWorktree({
      workspaceId: 'ws1',
      sessionId: 'owner',
      repositoryRoot: repo,
      gitCommonDir: gcd,
      baseRef: 'main',
    })
    // Simulate a lost owner reference in the registry.
    svc.registry.removeOwner(record.managedWorktreeId, 'owner')
    expect(svc.registry.getOwnerCount(record.managedWorktreeId)).toBe(0)

    const report = await svc.worktrees.reconcile({
      knownSessionIds: new Set(['owner']),
      sessionCheckouts: new Map([
        [
          'owner',
          {
            schemaVersion: 1,
            mode: 'managed-worktree',
            repositoryRoot: repo,
            checkoutPath: record.checkoutPath,
            branchAtPreparation: record.expectedBranch,
            baseRef: 'main',
            managedWorktreeId: record.managedWorktreeId,
            expectedBranch: record.expectedBranch,
          },
        ],
      ]),
    })

    expect(svc.registry.getOwnerCount(record.managedWorktreeId)).toBe(1)
    expect(report.repairedOwnerRefs).toBe(1)
  })

  test('marks a record missing when the checkout is gone from disk and git', async () => {
    const repo = tmp()
    await initRepo(repo)
    const svc = servicesFor()
    const gcd = await commonDir(repo)
    const { record } = await svc.worktrees.createWorktree({
      workspaceId: 'ws1',
      sessionId: 'owner',
      repositoryRoot: repo,
      gitCommonDir: gcd,
      baseRef: 'main',
    })
    // Remove the worktree directory + git registration out from under us.
    await git(repo, ['worktree', 'remove', '--force', record.checkoutPath])
    expect(existsSync(record.checkoutPath)).toBe(false)

    await svc.worktrees.reconcile({ knownSessionIds: new Set(['owner']) })

    expect(svc.registry.get(record.managedWorktreeId)!.state).toBe('missing')
  })

  test('never auto-deletes a record during reconcile', async () => {
    const repo = tmp()
    await initRepo(repo)
    const svc = servicesFor()
    const gcd = await commonDir(repo)
    const { record } = await svc.worktrees.createWorktree({
      workspaceId: 'ws1',
      sessionId: 'owner',
      repositoryRoot: repo,
      gitCommonDir: gcd,
      baseRef: 'main',
    })
    await svc.worktrees.reconcile({ knownSessionIds: new Set<string>() })
    expect(svc.registry.get(record.managedWorktreeId)).toBeTruthy()
  })
})
