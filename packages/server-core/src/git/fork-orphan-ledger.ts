/**
 * Durable orphan ledger for isolated-fork establishment attempts.
 *
 * When first-Send provider establishment THROWS, the server cannot know
 * whether the provider created a native child SDK session before throwing.
 * Every failed/malformed attempt is appended here so an unlinked provider
 * artifact is never silently attached: reconciliation (Task 5) reads this
 * ledger to find provider children that may exist without a persisted
 * session link.
 *
 * The ledger is an append-only JSONL file next to the registry (mirroring
 * the worktree journal). Entries are never rewritten; concurrent writers
 * serialize on a small file lock.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { CrossProcessFileLock } from './mutation-lock'

export type ForkOrphanResult = 'failed' | 'unverified'

export interface ForkOrphanEntry {
  /** Opaque ledger entry id (dedupe/reconciliation handle). */
  attemptId: string
  /** Fork transaction id whose child establishment was attempted. */
  transactionId: string
  /** Persisted idempotency key used for the attempt (never regenerated). */
  idempotencyKey: string
  parentSdkSessionId: string
  parentSdkTurnId: string
  executionCwd: string
  attemptedAt: number
  /** 'failed': establish threw (provider may have created an artifact). */
  result: ForkOrphanResult
  error?: string
}

export class ForkOrphanLedger {
  private readonly path: string
  private readonly lock: CrossProcessFileLock

  constructor(path: string) {
    this.path = path
    this.lock = new CrossProcessFileLock(`${path}.lock`)
    mkdirSync(dirname(path), { recursive: true })
  }

  getLedgerPath(): string {
    return this.path
  }

  /** Append a failed/unverified establishment attempt (best-effort durable). */
  recordAttempt(
    input: Omit<ForkOrphanEntry, 'attemptId' | 'attemptedAt'>,
  ): ForkOrphanEntry {
    const entry: ForkOrphanEntry = {
      attemptId: randomBytes(8).toString('hex'),
      attemptedAt: Date.now(),
      ...input,
    }
    this.lock.runSync(() => {
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
    })
    return entry
  }

  /** Every ledger entry, oldest first. Torn tail lines are crash artifacts. */
  entries(): ForkOrphanEntry[] {
    if (!existsSync(this.path)) return []
    const raw = readFileSync(this.path, 'utf8')
    const entries: ForkOrphanEntry[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as Partial<ForkOrphanEntry>
        if (
          typeof parsed.attemptId !== 'string' ||
          typeof parsed.transactionId !== 'string' ||
          typeof parsed.idempotencyKey !== 'string'
        ) {
          continue
        }
        entries.push({
          attemptId: parsed.attemptId,
          transactionId: parsed.transactionId,
          idempotencyKey: parsed.idempotencyKey,
          parentSdkSessionId: typeof parsed.parentSdkSessionId === 'string' ? parsed.parentSdkSessionId : '',
          parentSdkTurnId: typeof parsed.parentSdkTurnId === 'string' ? parsed.parentSdkTurnId : '',
          executionCwd: typeof parsed.executionCwd === 'string' ? parsed.executionCwd : '',
          attemptedAt: Number.isFinite(parsed.attemptedAt) ? parsed.attemptedAt! : 0,
          result: parsed.result === 'unverified' ? 'unverified' : 'failed',
          ...(typeof parsed.error === 'string' ? { error: parsed.error } : {}),
        })
      } catch {
        // A torn tail line is a crash artifact, never a fatal read error.
      }
    }
    return entries
  }
}

/** Ledger path next to a registry file (mirrors journalPathFor). */
export function forkOrphanLedgerPathFor(registryPath: string): string {
  return join(dirname(registryPath), 'fork-orphan-ledger.jsonl')
}
