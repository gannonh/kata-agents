import { describe, expect, test } from 'bun:test'
import { matchesRepositoryLabel } from './worktree-allocator.ts'

describe('matchesRepositoryLabel', () => {
  test('accepts workspace name, checkout basename, and remote name', () => {
    expect(matchesRepositoryLabel('kata-agents', 'kata-agents', '/tmp/other', [])).toBe(true)
    expect(matchesRepositoryLabel('demo', 'workspace', '/tmp/demo', [])).toBe(true)
    expect(matchesRepositoryLabel('origin', 'workspace', '/tmp/other', [
      { name: 'origin', url: 'https://github.com/acme/demo.git' },
    ])).toBe(true)
  })

  test('accepts exact remote path suffixes and rejects substring matches', () => {
    const remotes = [{ name: 'origin', url: 'https://github.com/acme/kata-agents.git' }]
    expect(matchesRepositoryLabel('kata-agents', 'workspace', '/tmp/other', remotes)).toBe(true)
    expect(matchesRepositoryLabel('kata-agents', 'workspace', '/tmp/other', [
      { name: 'origin', url: 'git@github.com:acme/kata-agents.git' },
    ])).toBe(true)
    expect(matchesRepositoryLabel('kata-agents', 'workspace', '/tmp/other', [
      { name: 'origin', url: 'https://github.com/acme/kata-agents' },
    ])).toBe(true)
    expect(matchesRepositoryLabel('kata', 'workspace', '/tmp/other', remotes)).toBe(false)
    expect(matchesRepositoryLabel('agents', 'workspace', '/tmp/other', remotes)).toBe(false)
    expect(matchesRepositoryLabel('github.com', 'workspace', '/tmp/other', remotes)).toBe(false)
  })
})
