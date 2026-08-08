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

/** Append-only resolution marker line written by reconcile (Task 5). */
export interface ForkOrphanResolutionMarker {
  type: 'resolution'
  attemptId: string
  result: 'resolved'
  resolvedAt: number
}

export interface ForkOrphanReconcileInput {
  /**
   * True when the fork transaction is now durably established (the fork
   * journal records the child session + established state under the same
   * transaction id). The caller wires this to the journal.
   */
  isEstablished: (transactionId: string) => boolean
  /** Injectable clock for deterministic retention tests (defaults to now). */
  now?: number
  /** Retention window for unresolved entries (defaults to 30 days). */
  retentionMs?: number
}

export interface ForkOrphanReconcileReport {
  /** Ledger entries retired because their transaction later established. */
  resolved: number
  /** Unresolved entries still within the retention window. */
  retained: number
  /** Unresolved entries older than the retention window (operator/UI decides). */
  expiredUnresolved: number
  /** Attempt ids of the expired unresolved entries (surfaced, never deleted). */
  expiredAttemptIds: string[]
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

  /**
   * Every ledger entry, oldest first, excluding retired (resolved) entries.
   * Pass `includeResolved: true` to also return entries that received a
   * resolution marker. Torn tail lines are crash artifacts.
   */
  entries(options?: { includeResolved?: boolean }): ForkOrphanEntry[] {
    if (!existsSync(this.path)) return []
    const raw = readFileSync(this.path, 'utf8')
    const resolvedAttemptIds = new Set<string>()
    const all: ForkOrphanEntry[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as Partial<ForkOrphanEntry> & Partial<ForkOrphanResolutionMarker>
        if (parsed.type === 'resolution') {
          if (typeof parsed.attemptId === 'string' && parsed.result === 'resolved') {
            resolvedAttemptIds.add(parsed.attemptId)
          }
          continue
        }
        if (
          typeof parsed.attemptId !== 'string' ||
          typeof parsed.transactionId !== 'string' ||
          typeof parsed.idempotencyKey !== 'string'
        ) {
          continue
        }
        all.push({
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
    // Resolution markers always follow their attempt line, so resolved
    // attempts are excluded only after the full scan.
    return options?.includeResolved ? all : all.filter((entry) => !resolvedAttemptIds.has(entry.attemptId))
  }

  /**
   * Reconcile the ledger (Task 5). An entry is retired when its fork
   * transaction is now durably established — the establish succeeded after
   * the failed attempt, and the journal records the child session + established
   * state under the same transaction id. Retirement is an append-only
   * resolution marker line; entries are never rewritten or deleted, so the
   * ledger stays a complete durable audit trail. Unresolved entries older than
   * the retention window are surfaced in the report (never auto-deleted — the
   * operator/UI decides; Task 8/UAT owns the surface). Reconciliation NEVER
   * attaches an orphan to a session binding: the ledger has no session access
   * and only annotates its own file.
   */
  reconcile(input: ForkOrphanReconcileInput): ForkOrphanReconcileReport {
    const now = input.now ?? Date.now()
    const retentionMs = input.retentionMs ?? 30 * 24 * 60 * 60 * 1000
    const report: ForkOrphanReconcileReport = {
      resolved: 0,
      retained: 0,
      expiredUnresolved: 0,
      expiredAttemptIds: [],
    }
    const markers: string[] = []
    for (const entry of this.entries()) {
      if (input.isEstablished(entry.transactionId)) {
        markers.push(
          JSON.stringify({
            type: 'resolution',
            attemptId: entry.attemptId,
            result: 'resolved',
            resolvedAt: now,
          } satisfies ForkOrphanResolutionMarker),
        )
        report.resolved += 1
        continue
      }
      if (now - entry.attemptedAt > retentionMs) {
        report.expiredUnresolved += 1
        report.expiredAttemptIds.push(entry.attemptId)
        continue
      }
      report.retained += 1
    }
    if (markers.length > 0) {
      this.lock.runSync(() => {
        appendFileSync(this.path, `${markers.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 })
      })
    }
    return report
  }
}

/** Ledger path next to a registry file (mirrors journalPathFor). */
export function forkOrphanLedgerPathFor(registryPath: string): string {
  return join(dirname(registryPath), 'fork-orphan-ledger.jsonl')
}
