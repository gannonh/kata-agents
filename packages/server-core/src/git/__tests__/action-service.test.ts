import { describe, test, expect, afterEach } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GitActionService, expandSelectedPaths, unrelatedIndexPreserved } from '../action-service'
import { RepositoryService } from '../repository-service'
import { runGit } from '../command-runner'
import { initRepo, makeTmpDir, cleanup, git, writeFile, GIT_ENV } from './test-helpers'

const repo = new RepositoryService()
const svc = new GitActionService(repo)
const dirs: string[] = []
function tmp(): string {
  const d = makeTmpDir()
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!)
})

async function headContent(dir: string, path: string): Promise<string | null> {
  const res = await runGit(['show', `HEAD:${path}`], { cwd: dir, okExitCodes: [128] })
  return res.exitCode === 0 ? res.stdout : null
}

async function stagedPaths(dir: string): Promise<string[]> {
  const res = await runGit(['diff', '--cached', '--name-only', '-z'], { cwd: dir })
  return res.stdout.split('\0').filter(Boolean)
}

describe('expandSelectedPaths', () => {
  test('expands a selected rename into old + new paths', () => {
    const entries = [
      { path: 'new.ts', previousPath: 'old.ts', type: 'renamed' as const },
      { path: 'other.ts', type: 'modified' as const },
    ]
    expect(expandSelectedPaths(entries, ['new.ts']).sort()).toEqual(['new.ts', 'old.ts'])
  })
  test('empty selection means all changed paths', () => {
    const entries = [
      { path: 'a.ts', type: 'modified' as const },
      { path: 'b.ts', type: 'added' as const },
    ]
    expect(expandSelectedPaths(entries, undefined).sort()).toEqual(['a.ts', 'b.ts'])
  })
})

describe('unrelatedIndexPreserved', () => {
  test('ignores selected paths and detects unrelated changes', () => {
    const before = new Map([['a', '1'], ['b', '2']])
    const same = new Map([['a', '9'], ['b', '2']])
    const changed = new Map([['a', '1'], ['b', '9']])
    expect(unrelatedIndexPreserved(before, same, ['a'])).toBe(true)
    expect(unrelatedIndexPreserved(before, changed, ['a'])).toBe(false)
  })
})

describe('GitActionService.commit — selected-file transaction', () => {
  test('commits only the selected file and preserves an unrelated staged entry', async () => {
    const d = tmp()
    await initRepo(d)
    writeFile(d, 'selected.txt', 's\n')
    writeFile(d, 'staged.txt', 'g\n')
    await git(d, ['add', 'staged.txt']) // unrelated, staged, not selected
    writeFile(d, 'unstaged.txt', 'u\n') // untracked, unselected

    const res = await svc.commit({ dir: d, message: 'add selected', paths: ['selected.txt'] })
    expect(res.stages[0]!.status).toBe('succeeded')

    expect(await headContent(d, 'selected.txt')).toBe('s\n')
    expect(await headContent(d, 'staged.txt')).toBeNull() // not committed
    // Unrelated staged entry survives; unselected untracked file untouched.
    expect(await stagedPaths(d)).toContain('staged.txt')
    expect(existsSync(join(d, 'unstaged.txt'))).toBe(true)
    const status = await repo.getStatus(d)
    expect(status.entries.find((e) => e.path === 'unstaged.txt')?.type).toBe('untracked')
  })

  test('commits selected added / deleted / renamed entries as whole-file paths', async () => {
    const d = tmp()
    await initRepo(d)
    writeFile(d, 'todelete.txt', 'x\n')
    writeFile(d, 'torename.txt', 'y\n')
    await git(d, ['add', '.'])
    await git(d, ['commit', '-m', 'seed tracked files'])

    writeFile(d, 'added.txt', 'z\n') // add
    await git(d, ['rm', '--quiet', 'todelete.txt']) // delete (staged)
    await git(d, ['mv', 'torename.txt', 'renamed.txt']) // rename (staged)

    const res = await svc.commit({
      dir: d,
      message: 'a/d/r',
      paths: ['added.txt', 'todelete.txt', 'renamed.txt'],
    })
    expect(res.stages[0]!.status).toBe('succeeded')

    expect(await headContent(d, 'added.txt')).toBe('z\n')
    expect(await headContent(d, 'todelete.txt')).toBeNull()
    expect(await headContent(d, 'renamed.txt')).toBe('y\n')
    expect(await headContent(d, 'torename.txt')).toBeNull()
    // Everything reconciled → clean working tree.
    const status = await repo.getStatus(d)
    expect(status.entries).toHaveLength(0)
  })

  test('commits the full working-tree content of a file with both staged and unstaged changes', async () => {
    const d = tmp()
    await initRepo(d)
    writeFile(d, 'both.txt', 'v1\n')
    writeFile(d, 'other.txt', 'o1\n')
    await git(d, ['add', '.'])
    await git(d, ['commit', '-m', 'seed'])

    writeFile(d, 'both.txt', 'v2\n')
    await git(d, ['add', 'both.txt']) // staged v2
    writeFile(d, 'both.txt', 'v3\n') // unstaged v3
    writeFile(d, 'other.txt', 'o2\n')
    await git(d, ['add', 'other.txt']) // unrelated staged entry

    const res = await svc.commit({ dir: d, message: 'commit both', paths: ['both.txt'] })
    expect(res.stages[0]!.status).toBe('succeeded')

    // The whole working-tree content (v3) is committed, not just the staged v2.
    expect(await headContent(d, 'both.txt')).toBe('v3\n')
    // The unrelated staged update to other.txt (o2) was NOT committed — HEAD
    // still has the seed content, and o2 remains staged for a later commit.
    expect(await headContent(d, 'other.txt')).toBe('o1\n')
    expect(await stagedPaths(d)).toContain('other.txt')
  })

  test('rejects an empty selection or empty message', async () => {
    const d = tmp()
    await initRepo(d)
    writeFile(d, 'a.txt', 'a\n')
    expect((await svc.commit({ dir: d, message: '   ', paths: ['a.txt'] })).stages[0]!.status).toBe(
      'failed',
    )
    const clean = await svc.commit({ dir: d, message: 'noop', paths: ['does-not-exist.txt'] })
    expect(clean.stages[0]!.status).toBe('failed')
  })
})

describe('GitActionService.commit — conflicted / merge-in-progress states', () => {
  /** Create a repo left mid-merge with a textual conflict on `conflict.txt`. */
  async function repoInMergeConflict(): Promise<string> {
    const d = tmp()
    await initRepo(d)
    writeFile(d, 'conflict.txt', 'base\n')
    await git(d, ['add', '.'])
    await git(d, ['commit', '-m', 'base'])
    await git(d, ['checkout', '-b', 'feature'])
    writeFile(d, 'conflict.txt', 'feature\n')
    await git(d, ['commit', '-am', 'feature change'])
    await git(d, ['checkout', 'main'])
    writeFile(d, 'conflict.txt', 'main\n')
    await git(d, ['commit', '-am', 'main change'])
    // Merge produces a conflict and leaves MERGE_HEAD in place.
    await runGit(['merge', 'feature'], { cwd: d, env: GIT_ENV, okExitCodes: [1] })
    return d
  }

  test('rejects a commit while a merge is in progress with unresolved conflicts', async () => {
    const d = await repoInMergeConflict()
    const status = await repo.getStatus(d)
    expect(status.operationInProgress).toBe('merge')
    expect(status.entries.some((e) => e.conflicted)).toBe(true)

    const res = await svc.commit({ dir: d, message: 'should not merge' })
    expect(res.stages[0]!.status).toBe('failed')
    expect(res.stages[0]!.error).toMatch(/merge|conflict/i)
    // No merge commit created: HEAD still has a single parent.
    const parents = (await git(d, ['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(' ')
    expect(parents).toHaveLength(2)
  })

  test('rejects a commit while a merge is in progress even after conflicts are resolved', async () => {
    const d = await repoInMergeConflict()
    // Resolve the conflict and stage it — MERGE_HEAD is still present, so a
    // commit here would create a merge commit, which V1 must refuse.
    writeFile(d, 'conflict.txt', 'resolved\n')
    await git(d, ['add', 'conflict.txt'])
    const status = await repo.getStatus(d)
    expect(status.operationInProgress).toBe('merge')
    expect(status.entries.some((e) => e.conflicted)).toBe(false)

    const res = await svc.commit({ dir: d, message: 'should not merge', paths: ['conflict.txt'] })
    expect(res.stages[0]!.status).toBe('failed')
    expect(res.stages[0]!.error).toMatch(/merge/i)
    const parents = (await git(d, ['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(' ')
    expect(parents).toHaveLength(2)
  })
})

describe('GitActionService.pull / push', () => {
  async function bareRemote(): Promise<string> {
    const remote = tmp()
    await runGit(['init', '--bare', '-b', 'main', remote], { cwd: process.cwd(), env: GIT_ENV })
    return remote
  }

  async function cloneWithIdentity(remote: string): Promise<string> {
    const clone = tmp()
    await runGit(['clone', remote, clone], { cwd: process.cwd(), env: GIT_ENV })
    await runGit(['config', 'user.name', 'Kata Test'], { cwd: clone, env: GIT_ENV })
    await runGit(['config', 'user.email', 'test@kata.sh'], { cwd: clone, env: GIT_ENV })
    return clone
  }

  test('fast-forward pull advances to the upstream commit', async () => {
    const remote = await bareRemote()
    const a = await cloneWithIdentity(remote)
    writeFile(a, 'f.txt', '1\n')
    await git(a, ['add', '.'])
    await git(a, ['commit', '-m', 'c1'])
    await git(a, ['push', '-u', 'origin', 'main'])

    const b = await cloneWithIdentity(remote)
    // A adds another commit and pushes.
    writeFile(a, 'f.txt', '2\n')
    await git(a, ['commit', '-am', 'c2'])
    await git(a, ['push'])

    const res = await svc.pull(b)
    expect(res.stages[0]!.status).toBe('succeeded')
    expect((await git(b, ['rev-parse', 'HEAD'])).trim()).toBe(
      (await git(a, ['rev-parse', 'HEAD'])).trim(),
    )
  })

  test('blocks a non-fast-forward pull without merging or rebasing', async () => {
    const remote = await bareRemote()
    const a = await cloneWithIdentity(remote)
    writeFile(a, 'f.txt', '1\n')
    await git(a, ['add', '.'])
    await git(a, ['commit', '-m', 'c1'])
    await git(a, ['push', '-u', 'origin', 'main'])

    const b = await cloneWithIdentity(remote)
    // Remote advances.
    writeFile(a, 'f.txt', '2\n')
    await git(a, ['commit', '-am', 'remote'])
    await git(a, ['push'])
    // B diverges with its own commit.
    writeFile(b, 'g.txt', 'local\n')
    await git(b, ['add', '.'])
    await git(b, ['commit', '-m', 'local'])
    const localHead = (await git(b, ['rev-parse', 'HEAD'])).trim()

    const res = await svc.pull(b)
    expect(res.stages[0]!.status).toBe('failed')
    expect(res.stages[0]!.error).toMatch(/diverg/i)
    // HEAD unchanged; no merge commit created.
    expect((await git(b, ['rev-parse', 'HEAD'])).trim()).toBe(localHead)
    const parents = (await git(b, ['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(' ')
    expect(parents).toHaveLength(2) // sha + single parent (no merge)
  })

  test('push configures upstream tracking when absent', async () => {
    const remote = await bareRemote()
    const work = tmp()
    await initRepo(work)
    await git(work, ['remote', 'add', 'origin', remote])

    const res = await svc.push(work)
    expect(res.stages[0]!.status).toBe('succeeded')
    expect((await git(work, ['rev-parse', '--abbrev-ref', '@{u}'])).trim()).toBe('origin/main')
  })

  test('push fails cleanly with no remote (partial-success building block)', async () => {
    const work = tmp()
    await initRepo(work)
    const res = await svc.push(work)
    expect(res.stages[0]!.status).toBe('failed')
    expect(res.stages[0]!.error).toMatch(/remote/i)
  })
})

describe('GitActionService.commit — literal pathspecs', () => {
  // `git add`'s operands are pathspecs, so a legal filename that begins with
  // pathspec magic would otherwise be interpreted as a pattern and stage
  // unrelated files. `--` ends option parsing but does not make paths literal.
  test('a selected file named with pathspec magic does not stage other files', async () => {
    const dir = tmp()
    await initRepo(dir)
    const magic = ':(glob)*.txt'
    writeFile(dir, magic, 'original\n')
    writeFile(dir, 'unrelated.txt', 'original\n')
    await git(dir, ['--literal-pathspecs', 'add', '--', magic, 'unrelated.txt'])
    await git(dir, ['commit', '-m', 'add both files'])

    // Both files are modified; only the magic-named one is selected.
    writeFile(dir, magic, 'selected change\n')
    writeFile(dir, 'unrelated.txt', 'must not be committed\n')

    const res = await svc.commit({ dir, message: 'commit only the magic-named file', paths: [magic] })
    expect(res.stages[0]!.status).toBe('succeeded')

    // The committed tree contains the selected change and the *original*
    // unrelated content — proof the pattern did not expand.
    const committed = await git(dir, ['show', `HEAD:${magic}`])
    expect(committed).toBe('selected change\n')
    const untouched = await git(dir, ['show', 'HEAD:unrelated.txt'])
    expect(untouched).toBe('original\n')

    // And the unrelated file is still pending in the working tree.
    const status = await svc.commit({ dir, message: 'second', paths: ['unrelated.txt'] })
    expect(status.stages[0]!.status).toBe('succeeded')
  })
})
