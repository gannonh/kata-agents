/**
 * Removal must never claim success it did not achieve.
 *
 * `git worktree remove` and the manual directory fallback can both fail without
 * throwing (a locked worktree, a permission problem, a process holding the
 * directory). Dropping the registry record in that case is the worst available
 * outcome: reconciliation reclaims leaked checkouts *from registry records*, so
 * a surviving directory with no record is invisible to every recovery path.
 */
import { describe, test, expect, afterEach, beforeEach, mock } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import * as registryModule from '../worktree-registry'
import { initRepo, makeTmpDir, cleanup, git } from './test-helpers'

const REGISTRY_MODULE = require.resolve('../worktree-registry')

// Snapshot the REAL exports at module load: `import * as` bindings are live,
// so after mock.module replaces the module, `registryModule.removeDir` points
// at the mock. Re-registering that namespace cannot restore the original.
const realRegistryModule = { ...registryModule }

const cleanups: string[] = []
function tmp(): string {
  const d = makeTmpDir()
  cleanups.push(d)
  return d
}
afterEach(() => {
  // Restore the real directory removal for any other suite in this process.
  mock.module(REGISTRY_MODULE, () => realRegistryModule)
  delete process.env.KATA_FEATURE_GIT_WORKSPACE_V1
  while (cleanups.length) cleanup(cleanups.pop()!)
})
beforeEach(() => {
  process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = '1'
})

describe('removeWorktree — cleanup that did not happen is reported as failure', () => {
  test('keeps the registry record when the checkout survives both removal attempts', async () => {
    const repo = tmp()
    await initRepo(repo)
    const worktreeRoot = tmp()

    // Import lazily so the module mock below is in place for the service.
    const { createGitServices } = await import('../index')
    const services = createGitServices({
      worktreeRoot,
      registryPath: join(worktreeRoot, 'registry.json'),
    })

    const gcd = (await git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
    const { record } = await services.worktrees.createWorktree({
      workspaceId: 'ws',
      sessionId: 'owner',
      repositoryRoot: repo,
      gitCommonDir: gcd,
      baseRef: 'main',
    })
    services.registry.setState(record.managedWorktreeId, 'ready')

    // Git's own removal fails on a locked worktree unless `--force` is given
    // twice, and the service passes it once — a faithful stand-in for any
    // removal git refuses.
    await git(repo, ['worktree', 'lock', record.checkoutPath])
    // …and the manual fallback fails too.
    mock.module(REGISTRY_MODULE, () => ({
      ...realRegistryModule,
      removeDir: () => false,
    }))

    const result = await services.worktrees.removeWorktree(record.managedWorktreeId, 'owner')

    // Honest failure rather than a false success.
    expect(result.removed).toBe(false)
    expect(result.blocked).toBe(true)
    expect(result.blockedReason).toContain('could not be removed')

    // And, critically, the record survives so reconciliation can still find it.
    const kept = services.registry.get(record.managedWorktreeId)
    expect(kept).toBeDefined()
    expect(kept!.state).toBe('blocked')
    expect(existsSync(record.checkoutPath)).toBe(true)

    // The temporary branch is left alone — it is still checked out in the
    // worktree that survived.
    const branches = await git(repo, ['branch', '--list', record.expectedBranch])
    expect(branches.trim()).not.toBe('')

    await git(repo, ['worktree', 'unlock', record.checkoutPath])
  })
})
