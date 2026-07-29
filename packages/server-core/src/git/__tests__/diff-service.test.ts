import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import {
  RepositoryService,
  parseNumstatZ,
  countLineDiff,
  isBinaryBuffer,
} from '../repository-service'
import { GIT_DIFF_MAX_BYTES } from '@kata-sh/shared/protocol'
import { makeTmpDir, cleanup, initRepo, git, writeFile } from './test-helpers'

describe('parseNumstatZ', () => {
  it('parses ordinary and rename records', () => {
    // ordinary: "5\t3\tsrc/a.ts\0" ; rename: "2\t1\t\0old\0new\0"
    const out = '5\t3\tsrc/a.ts\x002\t1\t\x00old/x.ts\x00new/y.ts\x00'
    const recs = parseNumstatZ(out)
    expect(recs).toEqual([
      { additions: 5, deletions: 3, path: 'src/a.ts', previousPath: undefined },
      { additions: 2, deletions: 1, path: 'new/y.ts', previousPath: 'old/x.ts' },
    ])
  })

  it('marks binary numstat entries with null counts', () => {
    const recs = parseNumstatZ('-\t-\tassets/logo.png\x00')
    expect(recs[0]!.additions).toBeNull()
    expect(recs[0]!.deletions).toBeNull()
  })

  it('handles paths with spaces', () => {
    const recs = parseNumstatZ('1\t0\tdir with space/a b.txt\x00')
    expect(recs[0]!.path).toBe('dir with space/a b.txt')
  })
})

describe('countLineDiff', () => {
  it('counts additions and deletions by trimming common prefix/suffix', () => {
    expect(countLineDiff('a\nb\nc', 'a\nB\nc')).toEqual({ additions: 1, deletions: 1 })
    expect(countLineDiff('', 'a\nb')).toEqual({ additions: 2, deletions: 0 })
    expect(countLineDiff('a\nb', '')).toEqual({ additions: 0, deletions: 2 })
    expect(countLineDiff('same', 'same')).toEqual({ additions: 0, deletions: 0 })
  })
})

describe('isBinaryBuffer', () => {
  it('detects NUL bytes as binary', () => {
    expect(isBinaryBuffer(Buffer.from('hello'))).toBe(false)
    expect(isBinaryBuffer(Buffer.from([104, 0, 105]))).toBe(true)
  })
})

describe('RepositoryService.getFileDiff', () => {
  let dir: string
  const repo = new RepositoryService()

  beforeEach(async () => {
    dir = makeTmpDir()
    await initRepo(dir)
  })
  afterEach(() => cleanup(dir))

  it('produces a text diff for a modified file', async () => {
    writeFile(dir, 'src/a.ts', 'export const a = 1\n')
    await git(dir, ['add', '.'])
    await git(dir, ['commit', '-m', 'add a'])
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 2\n')

    const diff = await repo.getFileDiff(dir, { path: 'src/a.ts', type: 'modified' })
    expect(diff.state).toBe('text')
    expect(diff.oldContent).toContain('a = 1')
    expect(diff.newContent).toContain('a = 2')
    expect(diff.fingerprint).toBeTruthy()
    expect(diff.language).toBe('typescript')
  })

  it('reports an added/untracked file with empty old content', async () => {
    writeFile(dir, 'fresh.txt', 'new file\n')
    const diff = await repo.getFileDiff(dir, { path: 'fresh.txt', type: 'untracked' })
    expect(diff.state).toBe('text')
    expect(diff.oldContent).toBe('')
    expect(diff.newContent).toBe('new file\n')
  })

  it('reports a deleted file with empty new content', async () => {
    writeFile(dir, 'gone.txt', 'bye\n')
    await git(dir, ['add', '.'])
    await git(dir, ['commit', '-m', 'add gone'])
    unlinkSync(join(dir, 'gone.txt'))
    const diff = await repo.getFileDiff(dir, { path: 'gone.txt', type: 'deleted' })
    expect(diff.state).toBe('text')
    expect(diff.oldContent).toBe('bye\n')
    expect(diff.newContent).toBe('')
  })

  it('resolves rename old content via previousPath', async () => {
    writeFile(dir, 'old-name.ts', 'export const x = 1\n')
    await git(dir, ['add', '.'])
    await git(dir, ['commit', '-m', 'add old-name'])
    await git(dir, ['mv', 'old-name.ts', 'new-name.ts'])
    const diff = await repo.getFileDiff(dir, {
      path: 'new-name.ts',
      previousPath: 'old-name.ts',
      type: 'renamed',
    })
    expect(diff.oldContent).toContain('x = 1')
    expect(diff.newContent).toContain('x = 1')
  })

  it('reports a binary state for files containing NUL bytes', async () => {
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([1, 2, 0, 3, 4]))
    const diff = await repo.getFileDiff(dir, { path: 'blob.bin', type: 'untracked' })
    expect(diff.state).toBe('binary')
  })

  it('reports an oversized state above the 2 MiB cap', async () => {
    const big = 'a'.repeat(GIT_DIFF_MAX_BYTES + 10) + '\n'
    writeFileSync(join(dir, 'big.txt'), big)
    const diff = await repo.getFileDiff(dir, { path: 'big.txt', type: 'untracked' })
    expect(diff.state).toBe('oversized')
    expect(diff.sizeBytes).toBeGreaterThan(GIT_DIFF_MAX_BYTES)
  })

  it('reports a missing state when the working-tree file is unreadable', async () => {
    // Tracked in HEAD, but removed from disk while status still lists it modified.
    writeFile(dir, 'ghost.txt', 'here\n')
    await git(dir, ['add', '.'])
    await git(dir, ['commit', '-m', 'add ghost'])
    unlinkSync(join(dir, 'ghost.txt'))
    const diff = await repo.getFileDiff(dir, { path: 'ghost.txt', type: 'modified' })
    expect(diff.state).toBe('missing')
  })

  it('rejects a path that escapes the repository', async () => {
    const diff = await repo.getFileDiff(dir, { path: '../escape.txt', type: 'modified' })
    expect(diff.state).toBe('error')
  })
})

describe('RepositoryService.getStatus additions/deletions', () => {
  let dir: string
  const repo = new RepositoryService()

  beforeEach(async () => {
    dir = makeTmpDir()
    await initRepo(dir)
  })
  afterEach(() => cleanup(dir))

  it('aggregates per-entry and total additions/deletions', async () => {
    writeFile(dir, 'tracked.txt', 'l1\nl2\nl3\n')
    await git(dir, ['add', '.'])
    await git(dir, ['commit', '-m', 'add tracked'])
    writeFileSync(join(dir, 'tracked.txt'), 'l1\nCHANGED\nl3\nl4\n')
    writeFile(dir, 'untracked.txt', 'a\nb\n')

    const status = await repo.getStatus(dir)
    const tracked = status.entries.find((e) => e.path === 'tracked.txt')
    const untracked = status.entries.find((e) => e.path === 'untracked.txt')
    expect(tracked?.additions).toBeGreaterThan(0)
    expect(untracked?.additions).toBe(2)
    expect(status.additions).toBeGreaterThan(0)
  })
})
