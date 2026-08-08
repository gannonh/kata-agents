import { describe, test, expect, afterEach } from 'bun:test'
import { join } from 'node:path'
import { WorktreeJournal } from '../worktree-journal'
import { cleanup, makeTmpDir } from './test-helpers'

const cleanups: string[] = []
function tmp(): string {
  const dir = makeTmpDir('kata-journal-test-')
  cleanups.push(dir)
  return dir
}
afterEach(() => {
  while (cleanups.length) cleanup(cleanups.pop()!)
})

describe('WorktreeJournal', () => {
  test('records durable begin/step/commit lifecycle with a commit marker', () => {
    const root = tmp()
    const journal = new WorktreeJournal(join(root, 'journal.jsonl'))

    const entry = journal.begin({
      op: 'delete',
      recordId: 'repo-aabbccdd',
      sessionIds: ['session-1'],
      policyVersion: 3,
    })
    expect(entry.status).toBe('in-progress')

    journal.step(entry.journalId, 'preview-validated')
    journal.step(entry.journalId, 'captured')
    journal.commit(entry.journalId, 'delete-committed')

    const reloaded = new WorktreeJournal(join(root, 'journal.jsonl'))
    const committed = reloaded.entries()
    expect(committed).toHaveLength(1)
    expect(committed[0]!.status).toBe('committed')
    expect(committed[0]!.steps).toEqual(['preview-validated', 'captured'])
    expect(committed[0]!.commitMarker).toBe('delete-committed')
    expect(reloaded.inProgress()).toEqual([])
  })

  test('surfaces interrupted in-progress entries for startup classification', () => {
    const root = tmp()
    const journal = new WorktreeJournal(join(root, 'journal.jsonl'))

    journal.begin({ op: 'restore', recordId: 'repo-aabbccdd', sessionIds: [], policyVersion: 1 })
    journal.begin({ op: 'delete', recordId: 'repo-11223344', sessionIds: ['s1'], policyVersion: 1 })

    const reloaded = new WorktreeJournal(join(root, 'journal.jsonl'))
    expect(reloaded.inProgress().map((e) => e.op)).toEqual(['restore', 'delete'])
    expect(reloaded.inProgress()[0]!.steps).toEqual([])
  })

  test('marks failures and compacts committed entries', () => {
    const root = tmp()
    const journal = new WorktreeJournal(join(root, 'journal.jsonl'))

    const failed = journal.begin({ op: 'cleanup', recordId: 'repo-aabbccdd', sessionIds: [], policyVersion: 1 })
    journal.fail(failed.journalId, 'snapshot limit exceeded')
    const committed = journal.begin({ op: 'delete', recordId: 'repo-11223344', sessionIds: [], policyVersion: 1 })
    journal.commit(committed.journalId, 'done')

    expect(journal.entries().map((e) => e.status)).toEqual(['failed', 'committed'])

    journal.compact()
    // Failed entries stay (recovery evidence); committed entries are dropped.
    expect(journal.entries().map((e) => e.status)).toEqual(['failed'])
    expect(journal.inProgress()).toEqual([])
  })

  test('compaction keeps committed fork entries so establishment metadata and orphan resolution survive restarts', () => {
    const root = tmp()
    const journal = new WorktreeJournal(join(root, 'journal.jsonl'))

    // A committed fork entry receives its establishment marker AFTER the
    // commit (first-Send establish flow) and cross-restart orphan resolution
    // matches ledger attempts against committed+established fork entries —
    // compacting it away would make the orphan ledger permanently unresolvable.
    const fork = journal.begin({ op: 'fork', recordId: '0123456789abcdef', sessionIds: ['s1'], policyVersion: 1 })
    journal.commit(fork.journalId, '0123456789abcdef')
    const handoff = journal.begin({ op: 'handoff', recordId: 'fedcba9876543210', sessionIds: ['s2'], policyVersion: 1 })
    journal.commit(handoff.journalId, 'm2')

    journal.compact()
    const after = journal.entries()
    expect(after.map((e) => e.op)).toEqual(['fork'])
    expect(after[0]?.status).toBe('committed')
    // Establishment metadata can still be written to the retained entry.
    journal.updateMetadata(after[0]!.journalId, { state: 'established', childSdkSessionId: 'sdk-child' })
    expect(new WorktreeJournal(join(root, 'journal.jsonl')).entries()[0]?.metadata?.state).toBe('established')
  })

  test('appends entries from separate instances without losing records', () => {
    const root = tmp()
    const path = join(root, 'journal.jsonl')
    const first = new WorktreeJournal(path)
    const second = new WorktreeJournal(path)

    const a = first.begin({ op: 'delete', recordId: 'r1', sessionIds: [], policyVersion: 1 })
    first.commit(a.journalId, 'm1')
    const b = second.begin({ op: 'restore', recordId: 'r2', sessionIds: [], policyVersion: 1 })
    second.commit(b.journalId, 'm2')

    expect(new WorktreeJournal(path).entries().map((e) => e.recordId)).toEqual(['r1', 'r2'])
  })

  test('step and commit on an unknown journal id are no-ops', () => {
    const root = tmp()
    const journal = new WorktreeJournal(join(root, 'journal.jsonl'))
    expect(() => journal.step('missing', 'x')).not.toThrow()
    expect(() => journal.commit('missing', 'm')).not.toThrow()
    expect(journal.entries()).toEqual([])
  })
})
