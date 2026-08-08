import { describe, test, expect, afterEach } from 'bun:test'
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeTmpDir, cleanup } from './test-helpers'
import { ForkOrphanLedger } from '../fork-orphan-ledger'

const cleanups: string[] = []
function tmp(): string {
  const dir = makeTmpDir('kata-orphan-ledger-')
  cleanups.push(dir)
  return dir
}
afterEach(() => {
  while (cleanups.length) cleanup(cleanups.pop()!)
})

function makeLedger(): ForkOrphanLedger {
  return new ForkOrphanLedger(join(tmp(), 'fork-orphan-ledger.jsonl'))
}

describe('ForkOrphanLedger reconcile', () => {
  test('retires a ledger entry with an append-only resolution marker when its transaction later establishes', () => {
    const ledger = makeLedger()
    const entry = ledger.recordAttempt({
      transactionId: 'a'.repeat(16),
      idempotencyKey: 'key-1',
      parentSdkSessionId: 'parent',
      parentSdkTurnId: 'turn-1',
      executionCwd: '/wt/child',
      result: 'failed',
    })
    expect(ledger.entries()).toHaveLength(1)

    const report = ledger.reconcile({ isEstablished: (txId) => txId === 'a'.repeat(16) })

    expect(report).toEqual({ resolved: 1, retained: 0, expiredUnresolved: 0, expiredAttemptIds: [] })
    // Default entries() skips the resolved attempt (never rewritten/deleted).
    expect(ledger.entries()).toHaveLength(0)
    // The raw file gained exactly one resolution marker line after the attempt.
    const raw = readFileSync(ledger.getLedgerPath(), 'utf8')
    const lines = raw.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toMatchObject({ attemptId: entry.attemptId, transactionId: 'a'.repeat(16) })
    expect(JSON.parse(lines[1]!)).toMatchObject({
      type: 'resolution',
      attemptId: entry.attemptId,
      result: 'resolved',
      resolvedAt: expect.any(Number),
    })
    // includeResolved exposes the original attempt alongside the marker.
    expect(ledger.entries({ includeResolved: true })).toHaveLength(1)
  })

  test('resolves only entries whose transaction established; unrelated entries stay', () => {
    const ledger = makeLedger()
    ledger.recordAttempt({
      transactionId: 'txn-established',
      idempotencyKey: 'k1',
      parentSdkSessionId: 'p',
      parentSdkTurnId: 't',
      executionCwd: '/a',
      result: 'failed',
    })
    ledger.recordAttempt({
      transactionId: 'txn-unrelated',
      idempotencyKey: 'k2',
      parentSdkSessionId: 'p',
      parentSdkTurnId: 't',
      executionCwd: '/b',
      result: 'failed',
    })

    const report = ledger.reconcile({ isEstablished: (txId) => txId === 'txn-established' })

    expect(report).toEqual({ resolved: 1, retained: 1, expiredUnresolved: 0, expiredAttemptIds: [] })
    const remaining = ledger.entries()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.transactionId).toBe('txn-unrelated')
    expect(remaining[0]!.idempotencyKey).toBe('k2')
  })

  test('respects the retention window: stale unresolved entries are surfaced, never auto-deleted', () => {
    const ledger = makeLedger()
    const now = Date.now()
    // A stale attempt appended directly (the ledger treats it as a normal line).
    appendFileSync(
      ledger.getLedgerPath(),
      `${JSON.stringify({
        attemptId: 'old-attempt',
        transactionId: 'old',
        idempotencyKey: 'k-old',
        parentSdkSessionId: 'p',
        parentSdkTurnId: 't',
        executionCwd: '/old',
        attemptedAt: now - 2 * 24 * 60 * 60 * 1000,
        result: 'failed',
      })}\n`,
      'utf8',
    )
    const fresh = ledger.recordAttempt({
      transactionId: 'fresh',
      idempotencyKey: 'k-fresh',
      parentSdkSessionId: 'p',
      parentSdkTurnId: 't',
      executionCwd: '/fresh',
      result: 'unverified',
    })

    const report = ledger.reconcile({ isEstablished: () => false, now, retentionMs: 24 * 60 * 60 * 1000 })

    // The stale attempt is surfaced (not resolved, not deleted); the fresh one
    // is retained within the window. The file gained no lines at all.
    expect(report).toEqual({
      resolved: 0,
      retained: 1,
      expiredUnresolved: 1,
      expiredAttemptIds: ['old-attempt'],
    })
    const raw = readFileSync(ledger.getLedgerPath(), 'utf8')
    expect(raw.trim().split('\n')).toHaveLength(2)
    // The stale entry is still listed (never auto-deleted).
    expect(ledger.entries().map((e) => e.attemptId).sort()).toEqual([fresh.attemptId, 'old-attempt'].sort())
    expect(ledger.entries().find((e) => e.attemptId === 'old-attempt')?.attemptedAt).toBe(now - 2 * 24 * 60 * 60 * 1000)
  })

  test('reconcile only annotates; it never attaches an orphan to a session binding', () => {
    const ledger = makeLedger()
    ledger.recordAttempt({
      transactionId: 'txn',
      idempotencyKey: 'k',
      parentSdkSessionId: 'p',
      parentSdkTurnId: 't',
      executionCwd: '/wt',
      result: 'failed',
    })
    const before = readFileSync(ledger.getLedgerPath(), 'utf8')

    const report = ledger.reconcile({ isEstablished: (txId) => txId === 'txn' })

    const after = readFileSync(ledger.getLedgerPath(), 'utf8')
    // The original attempt line is byte-for-byte untouched; only a marker was
    // appended. No session id / binding was written into the entry.
    expect(after.startsWith(before)).toBe(true)
    expect(after.trim().split('\n')).toHaveLength(2)
    expect(report.resolved).toBe(1)
    const original = ledger.entries({ includeResolved: true })[0]!
    expect(original).toMatchObject({
      transactionId: 'txn',
      idempotencyKey: 'k',
      parentSdkSessionId: 'p',
      parentSdkTurnId: 't',
      executionCwd: '/wt',
      result: 'failed',
    })
    expect(original).not.toHaveProperty('childSdkSessionId')
    expect(original).not.toHaveProperty('boundSessionId')
  })

  test('reconcile is idempotent: a second run does not re-resolve or re-append', () => {
    const ledger = makeLedger()
    ledger.recordAttempt({
      transactionId: 'idem',
      idempotencyKey: 'k',
      parentSdkSessionId: 'p',
      parentSdkTurnId: 't',
      executionCwd: '/idem',
      result: 'failed',
    })

    const first = ledger.reconcile({ isEstablished: (txId) => txId === 'idem' })
    const second = ledger.reconcile({ isEstablished: (txId) => txId === 'idem' })

    expect(first.resolved).toBe(1)
    expect(second).toEqual({ resolved: 0, retained: 0, expiredUnresolved: 0, expiredAttemptIds: [] })
    expect(readFileSync(ledger.getLedgerPath(), 'utf8').trim().split('\n')).toHaveLength(2)
  })
})
