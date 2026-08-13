import { describe, test, expect, afterEach } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
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
  test('drops owner references for sessions that no longer exist', async () => {
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
    // Give the checkout work so reclamation retains it — this test is about the
    // owner-drop bookkeeping, not about what happens to a clean leak (covered
    // in "reclaiming leaked (unowned) checkouts").
    writeFileSync(join(record.checkoutPath, 'work.txt'), 'unsaved\n')

    const report = await svc.worktrees.reconcile({ knownSessionIds: new Set<string>() })

    const rec = await svc.registry.get(record.managedWorktreeId)
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
    await svc.registry.removeOwner(record.managedWorktreeId, 'owner')
    expect(await svc.registry.getOwnerCount(record.managedWorktreeId)).toBe(0)

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

    expect(await svc.registry.getOwnerCount(record.managedWorktreeId)).toBe(1)
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

    expect((await svc.registry.get(record.managedWorktreeId))!.state).toBe('missing')
  })

  test('does not reopen a worktree already claimed by removal', async () => {
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
    await svc.registry.setState(record.managedWorktreeId, 'removing')

    await svc.worktrees.reconcile({ knownSessionIds: new Set(['owner']) })

    expect((await svc.registry.get(record.managedWorktreeId))!.state).toBe('removing')
    await expect(svc.worktrees.addOwner(record.managedWorktreeId, 'late')).rejects.toThrow(
      /while it is removing/,
    )
  })

  // Reconcile used to guarantee it never deleted anything. That guarantee is now
  // narrower: it reclaims a checkout only when the checkout has no live owner
  // AND is clean. Anything still owned, or holding work, is never auto-deleted.
  test('never auto-deletes a record that still has a live owner', async () => {
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
    await svc.worktrees.reconcile({ knownSessionIds: new Set<string>(['owner']) })
    expect(await svc.registry.get(record.managedWorktreeId)).toBeTruthy()
    expect(existsSync(record.checkoutPath)).toBe(true)
  })
})

describe('reconcile — reclaiming leaked (unowned) checkouts', () => {
  // Nothing else removes an unowned checkout, so before this it sat on disk
  // forever with no session through which to reach it. Reachable when the
  // removal step of a session deletion is blocked or interrupted after the
  // session is already gone.
  async function makeWorktree(services: ReturnType<typeof servicesFor>, repo: string, sessionId: string) {
    const { record } = await services.worktrees.createWorktree({
      workspaceId: 'ws',
      sessionId,
      repositoryRoot: repo,
      gitCommonDir: await commonDir(repo),
      baseRef: 'main',
    })
    await services.registry.setState(record.managedWorktreeId, 'ready')
    return record
  }

  test('removes an unowned clean checkout and prunes its temporary branch', async () => {
    const repo = tmp()
    await initRepo(repo)
    const services = servicesFor()
    const rec = await makeWorktree(services, repo, 'gone')

    // The owning session no longer exists.
    const report = await services.worktrees.reconcile({ knownSessionIds: new Set() })

    expect(report.reclaimedUnowned).toBe(1)
    expect(report.retainedUnownedWithWork).toBe(0)
    expect(existsSync(rec.checkoutPath)).toBe(false)
    expect(await services.registry.get(rec.managedWorktreeId)).toBeUndefined()
    const branches = await git(repo, ['branch', '--list', rec.expectedBranch])
    expect(branches.trim()).toBe('')
  })

  test('keeps an unowned checkout that holds uncommitted work, and marks it', async () => {
    const repo = tmp()
    await initRepo(repo)
    const services = servicesFor()
    const rec = await makeWorktree(services, repo, 'gone')
    writeFileSync(join(rec.checkoutPath, 'unsaved.txt'), 'work in progress\n')

    const report = await services.worktrees.reconcile({ knownSessionIds: new Set() })

    // Reclamation never forces, so work is never destroyed silently.
    expect(report.reclaimedUnowned).toBe(0)
    expect(report.retainedUnownedWithWork).toBe(1)
    expect(existsSync(rec.checkoutPath)).toBe(true)
    expect((await services.registry.get(rec.managedWorktreeId))!.state).toBe('blocked')
  })

  test('does not drop an owner bound while reclaiming a stale snapshot', async () => {
    const repo = tmp()
    await initRepo(repo)
    const services = servicesFor()
    const otherServices = createGitServices({
      worktreeRoot: services.worktreeRoot,
      registryPath: services.registry.getRegistryPath(),
    })
    const rec = await makeWorktree(services, repo, 'gone')
    const originalInspect = services.worktrees.inspectRemoval.bind(services.worktrees)
    services.worktrees.inspectRemoval = (async (...args: Parameters<typeof originalInspect>) => {
      const risk = await originalInspect(...args)
      await otherServices.worktrees.addOwner(rec.managedWorktreeId, 'late-owner')
      return risk
    }) as typeof services.worktrees.inspectRemoval

    const report = await services.worktrees.reconcile({ knownSessionIds: new Set() })

    expect(report.reclaimedUnowned).toBe(0)
    expect(report.retainedUnownedWithWork).toBe(1)
    expect((await services.registry.get(rec.managedWorktreeId))!.ownerSessionIds).toEqual(['late-owner'])
    expect(existsSync(rec.checkoutPath)).toBe(true)
  })

  test('keeps an unowned checkout that holds unique commits', async () => {
    const repo = tmp()
    await initRepo(repo)
    const services = servicesFor()
    const rec = await makeWorktree(services, repo, 'gone')
    writeFileSync(join(rec.checkoutPath, 'feature.txt'), 'committed but unmerged\n')
    await git(rec.checkoutPath, ['add', '.'])
    await git(rec.checkoutPath, ['commit', '-m', 'unique work'])

    const report = await services.worktrees.reconcile({ knownSessionIds: new Set() })

    expect(report.reclaimedUnowned).toBe(0)
    expect(report.retainedUnownedWithWork).toBe(1)
    expect(existsSync(rec.checkoutPath)).toBe(true)
  })

  test('never touches a checkout that still has a live owner', async () => {
    const repo = tmp()
    await initRepo(repo)
    const services = servicesFor()
    const rec = await makeWorktree(services, repo, 'alive')

    const report = await services.worktrees.reconcile({ knownSessionIds: new Set(['alive']) })

    expect(report.reclaimedUnowned).toBe(0)
    expect(existsSync(rec.checkoutPath)).toBe(true)
    expect((await services.registry.get(rec.managedWorktreeId))!.ownerSessionIds).toEqual(['alive'])
  })

  test('does not reclaim a checkout whose owner reference is repaired from session metadata', async () => {
    const repo = tmp()
    await initRepo(repo)
    const services = servicesFor()
    const rec = await makeWorktree(services, repo, 'owner')
    // Registry lost the owner reference, but the session's persisted checkout
    // still points at this worktree — the repair pass must win over reclamation.
    await services.registry.removeOwner(rec.managedWorktreeId, 'owner')

    const report = await services.worktrees.reconcile({
      knownSessionIds: new Set(['owner']),
      sessionCheckouts: new Map([
        [
          'owner',
          {
            schemaVersion: 1,
            mode: 'managed-worktree',
            repositoryRoot: repo,
            checkoutPath: rec.checkoutPath,
            branchAtPreparation: rec.expectedBranch,
            baseRef: 'main',
            managedWorktreeId: rec.managedWorktreeId,
            expectedBranch: rec.expectedBranch,
          },
        ],
      ]) as any,
    })

    expect(report.repairedOwnerRefs).toBe(1)
    expect(report.reclaimedUnowned).toBe(0)
    expect(existsSync(rec.checkoutPath)).toBe(true)
  })

  test('leaves an unowned checkout on an unexpected branch alone', async () => {
    const repo = tmp()
    await initRepo(repo)
    const services = servicesFor()
    const rec = await makeWorktree(services, repo, 'gone')
    // Identity drift: someone switched the worktree off its expected branch.
    await git(rec.checkoutPath, ['checkout', '-b', 'someone-elses-branch'])

    const report = await services.worktrees.reconcile({ knownSessionIds: new Set() })

    expect(report.reclaimedUnowned).toBe(0)
    expect(report.markedBlocked).toBe(1)
    expect(existsSync(rec.checkoutPath)).toBe(true)
  })
})
