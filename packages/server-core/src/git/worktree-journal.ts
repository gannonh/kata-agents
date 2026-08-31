/**
 * Durable worktree lifecycle journal.
 *
 * Every destructive lifecycle transaction records its intent before touching
 * the checkout, appends an idempotent step per completed phase, and writes a
 * commit marker only after the registry/owner-session writes are durable. A
 * crash between steps leaves an `in-progress` entry that startup
 * reconciliation classifies using journal + registry + ref + path evidence.
 *
 * The journal is an append-only JSONL file under server-owned storage. Step
 * and commit updates rewrite the line in place; concurrent writers serialize
 * on a small file lock.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { writeDurableFileIfAbsent, syncDirectory } from '@kata-sh/shared/spawn-tasks/durable-fs'
import { CrossProcessFileLock } from './mutation-lock'

export type WorktreeJournalOp =
  | 'delete'
  | 'restore'
  | 'permanent-delete'
  | 'session-delete'
  | 'cleanup'
  | 'handoff'
  | 'fork'

export type WorktreeJournalStatus = 'in-progress' | 'committed' | 'failed' | 'recovered'

export interface WorktreeJournalEntry {
  journalId: string
  op: WorktreeJournalOp
  recordId: string
  sessionIds: string[]
  policyVersion: number
  startedAt: number
  /** Idempotent steps completed so far, in order. */
  steps: string[]
  /** Sanitized transaction facts needed for restart reconciliation. */
  metadata?: Record<string, unknown>
  status: WorktreeJournalStatus
  commitMarker?: string
  error?: string
}

function newJournalId(): string {
  return randomBytes(8).toString('hex')
}

export class WorktreeJournal {
  private readonly path: string
  private readonly lock: CrossProcessFileLock

  constructor(path: string) {
    this.path = path
    this.lock = new CrossProcessFileLock(`${path}.lock`)
    mkdirSync(dirname(path), { recursive: true })
  }

  getJournalPath(): string {
    return this.path
  }

  private readAll(): WorktreeJournalEntry[] {
    if (!existsSync(this.path)) return []
    const raw = readFileSync(this.path, 'utf8')
    const entries: WorktreeJournalEntry[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as Partial<WorktreeJournalEntry>
        if (
          typeof parsed.journalId !== 'string' ||
          typeof parsed.op !== 'string' ||
          typeof parsed.recordId !== 'string' ||
          !Array.isArray(parsed.steps) ||
          !parsed.steps.every((step) => typeof step === 'string') ||
          (parsed.status !== 'in-progress' &&
            parsed.status !== 'committed' &&
            parsed.status !== 'failed' &&
            parsed.status !== 'recovered')
        ) {
          continue
        }
        entries.push({
          journalId: parsed.journalId,
          op: parsed.op as WorktreeJournalOp,
          recordId: parsed.recordId,
          sessionIds: Array.isArray(parsed.sessionIds)
            ? parsed.sessionIds.filter((id): id is string => typeof id === 'string')
            : [],
          policyVersion: Number.isFinite(parsed.policyVersion) ? parsed.policyVersion! : 0,
          startedAt: Number.isFinite(parsed.startedAt) ? parsed.startedAt! : 0,
          steps: parsed.steps,
          metadata: parsed.metadata && typeof parsed.metadata === 'object' && !Array.isArray(parsed.metadata)
            ? parsed.metadata as Record<string, unknown>
            : undefined,
          status: parsed.status,
          commitMarker: typeof parsed.commitMarker === 'string' ? parsed.commitMarker : undefined,
          error: typeof parsed.error === 'string' ? parsed.error : undefined,
        })
      } catch {
        // A torn tail line is a crash artifact, never a fatal read error.
      }
    }
    return entries
  }

  private writeAll(entries: WorktreeJournalEntry[]): void {
    const lines = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
    const tmp = `${this.path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
    if (!writeDurableFileIfAbsent(tmp, lines)) throw new Error('Could not create a unique worktree journal temporary file')
    try {
      renameSync(tmp, this.path)
      syncDirectory(dirname(this.path))
    } catch (error) {
      try {
        rmSync(tmp, { force: true })
      } catch {
        /* preserve the original error */
      }
      throw error
    }
  }

  /** Record transaction intent before any checkout mutation. */
  begin(input: {
    op: WorktreeJournalOp
    recordId: string
    sessionIds: string[]
    policyVersion: number
    metadata?: Record<string, unknown>
  }): WorktreeJournalEntry {
    const entry: WorktreeJournalEntry = {
      journalId: newJournalId(),
      op: input.op,
      recordId: input.recordId,
      sessionIds: [...input.sessionIds],
      policyVersion: input.policyVersion,
      startedAt: Date.now(),
      steps: [],
      metadata: input.metadata ? { ...input.metadata } : undefined,
      status: 'in-progress',
    }
    this.lock.runSync(() => {
      const entries = this.readAll()
      entries.push(entry)
      this.writeAll(entries)
    })
    return entry
  }

  /** Record a completed idempotent step (append-only history). */
  step(journalId: string, step: string): void {
    this.lock.runSync(() => {
      const entries = this.readAll()
      const entry = entries.find((candidate) => candidate.journalId === journalId)
      if (!entry || entry.status !== 'in-progress' || entry.steps.includes(step)) return
      entry.steps.push(step)
      this.writeAll(entries)
    })
  }

  /**
   * Update restart-relevant transaction facts without changing its state.
   * In-progress and failed entries always accept metadata; committed entries
   * accept metadata-only updates too (e.g. the fork journal records the
   * child provider identity on first-Send establishment after commit).
   */
  updateMetadata(journalId: string, metadata: Record<string, unknown>): void {
    this.lock.runSync(() => {
      const entries = this.readAll()
      const entry = entries.find((candidate) => candidate.journalId === journalId)
      if (!entry || (entry.status !== 'in-progress' && entry.status !== 'failed' && entry.status !== 'committed')) return
      entry.metadata = { ...(entry.metadata ?? {}), ...metadata }
      this.writeAll(entries)
    })
  }

  /** Mark the transaction committed after registry/session durability. */
  commit(journalId: string, commitMarker: string): void {
    this.lock.runSync(() => {
      const entries = this.readAll()
      const entry = entries.find((candidate) => candidate.journalId === journalId)
      if (!entry || entry.status !== 'in-progress') return
      entry.status = 'committed'
      entry.commitMarker = commitMarker
      this.writeAll(entries)
    })
  }

  /** Record a definitive failure (recovery may still retry safe steps). */
  fail(journalId: string, error: string): void {
    this.lock.runSync(() => {
      const entries = this.readAll()
      const entry = entries.find((candidate) => candidate.journalId === journalId)
      if (!entry || entry.status !== 'in-progress') return
      entry.status = 'failed'
      entry.error = error
      this.writeAll(entries)
    })
  }

  /** Reconciliation marks an interrupted or failed entry as resolved. */
  recover(journalId: string, marker: string): void {
    this.lock.runSync(() => {
      const entries = this.readAll()
      const entry = entries.find((candidate) => candidate.journalId === journalId)
      if (!entry || (entry.status !== 'in-progress' && entry.status !== 'failed')) return
      entry.status = 'recovered'
      entry.commitMarker = marker
      this.writeAll(entries)
    })
  }

  /** Interrupted entries needing startup classification, oldest first. */
  inProgress(): WorktreeJournalEntry[] {
    return this.readAll().filter((entry) => entry.status === 'in-progress')
  }

  /** Every journal entry, oldest first. */
  entries(): WorktreeJournalEntry[] {
    return this.readAll()
  }

  /**
   * Drop committed/recovered entries; keep failures as recovery evidence.
   * Committed fork entries are EXEMPT: their establishment metadata (and the
   * orphan-ledger resolution that depends on it) must survive restarts until
   * the fork is durably established — the first-Send establish flow writes
   * `markEstablished` after the commit marker, and startup reconciliation
   * resolves ledger entries against committed+established fork entries.
   */
  compact(): void {
    this.lock.runSync(() => {
      const entries = this.readAll().filter(
        (entry) => entry.status === 'failed' || (entry.status === 'committed' && entry.op === 'fork'),
      )
      if (entries.length === this.readAll().length) return
      this.writeAll(entries)
    })
  }
}

/** Journal path next to a registry file. */
export function journalPathFor(registryPath: string): string {
  return join(dirname(registryPath), 'worktree-journal.jsonl')
}
