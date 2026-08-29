import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  APPROVAL_LIMITS,
  type ApprovalAllowedOnce,
  type ApprovalConsumed,
  type ApprovalExpired,
  type ApprovalId,
  type ApprovalPending,
  type ApprovalRecord,
  type ApprovalStale,
  type StandingRule,
  type StandingRuleId,
  type ToolInvocation,
} from '@kata-sh/core'
import {
  ensureDurableDirectory,
  writeDurableFileIfAbsent,
} from '../spawn-tasks/durable-fs.ts'
import { readJsonFile, writeJsonIfAbsent, writeJsonRecord } from '../conversations/durable-json.ts'
import { truncateUtf8 } from '../spawn-tasks/utf8.ts'
import { computeOperationHash } from './hash.ts'

export class ApprovalConflictError extends Error {
  override readonly name = 'ApprovalConflictError'
  constructor(readonly reason: 'unauthorized' | 'mismatch' | 'consumed' | 'expired' | 'denied' | 'stale') {
    super(`Approval ${reason}`)
  }
}

export interface ApprovalStoreOptions {
  readonly workspaceRoot: string
  readonly workspaceId: string
  readonly clock?: () => string
  readonly now?: () => string
}

function isRecord(value: unknown): value is ApprovalRecord {
  return typeof value === 'object' && value !== null && 'approvalId' in value && 'status' in value
}

function isRule(value: unknown): value is StandingRule {
  return typeof value === 'object' && value !== null && 'ruleId' in value && 'effect' in value
}

export class ApprovalStore {
  readonly rootPath: string
  private readonly workspaceId: string
  private readonly clock: () => string
  private readonly records = new Map<string, ApprovalRecord>()

  constructor(options: ApprovalStoreOptions) {
    this.rootPath = join(options.workspaceRoot, 'approvals')
    this.workspaceId = options.workspaceId
    this.clock = options.clock ?? options.now ?? (() => new Date().toISOString())
    ensureDurableDirectory(this.rootPath)
    this.reload()
  }

  private recordDir(approvalId: string): string {
    return join(this.rootPath, approvalId)
  }

  private recordPath(approvalId: string): string {
    return join(this.recordDir(approvalId), 'record.json')
  }

  private casPath(approvalId: string, version: number): string {
    return join(this.recordDir(approvalId), 'cas', String(version))
  }

  reload(): void {
    this.records.clear()
    if (!existsSync(this.rootPath)) return
    for (const entry of readdirSync(this.rootPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const parsed = readJsonFile(this.recordPath(entry.name))
      if (!isRecord(parsed)) continue
      this.dropOrphanCasClaim(parsed.approvalId, parsed.version)
      this.records.set(parsed.approvalId, parsed)
    }
  }

  private dropOrphanCasClaim(approvalId: string, version: number): void {
    const path = this.casPath(approvalId, version)
    if (existsSync(path)) rmSync(path, { force: true })
  }

  get(approvalId: string): ApprovalRecord | null {
    return this.records.get(approvalId) ?? null
  }

  listPending(conversationId: string): ApprovalPending[] {
    return [...this.records.values()].filter(
      (record): record is ApprovalPending => record.status === 'pending' && record.conversationId === conversationId,
    )
  }

  listForConversation(conversationId: string): ApprovalRecord[] {
    return [...this.records.values()].filter((record) => record.conversationId === conversationId)
  }

  findOpenByHash(operationHash: string): ApprovalPending | ApprovalAllowedOnce | null {
    for (const record of this.records.values()) {
      if (record.operationHash !== operationHash) continue
      if (record.status === 'pending' || record.status === 'allowed-once') return record
    }
    return null
  }

  createPending(record: ApprovalPending): ApprovalPending {
    const existing = this.get(record.approvalId)
    if (existing?.status === 'pending') return existing
    ensureDurableDirectory(this.recordDir(record.approvalId))
    if (!writeJsonIfAbsent(this.recordPath(record.approvalId), record)) {
      this.reload()
      const latest = this.get(record.approvalId)
      if (latest?.status === 'pending') return latest
      throw new ApprovalConflictError('consumed')
    }
    this.records.set(record.approvalId, record)
    return record
  }

  private cas(current: ApprovalRecord, next: ApprovalRecord): ApprovalRecord {
    ensureDurableDirectory(join(this.recordDir(current.approvalId), 'cas'))
    const marker = this.casPath(current.approvalId, current.version)
    let claimed = writeDurableFileIfAbsent(marker, `${next.status}\n`)
    if (!claimed) {
      this.reload()
      const latest = this.get(current.approvalId)
      if (!latest || latest.version !== current.version) throw new ApprovalConflictError('consumed')
      claimed = writeDurableFileIfAbsent(marker, `${next.status}\n`)
      if (!claimed) {
        this.reload()
        throw new ApprovalConflictError('consumed')
      }
    }
    writeJsonRecord(this.recordPath(current.approvalId), next)
    this.records.set(current.approvalId, next)
    return next
  }

  expireIfDue(approvalId: ApprovalId, now = this.clock()): ApprovalRecord {
    const current = this.get(approvalId)
    if (!current) throw new ApprovalConflictError('unauthorized')
    if (current.status !== 'pending') return current
    if (now < current.expiresAt) return current
    const expired: ApprovalExpired = {
      ...current,
      status: 'expired',
      version: current.version + 1,
      expiredAt: now,
      updatedAt: now,
    }
    try {
      return this.cas(current, expired)
    } catch (error) {
      if (error instanceof ApprovalConflictError) {
        const latest = this.get(approvalId)
        if (latest) return latest
      }
      throw error
    }
  }

  resolve(
    approvalId: ApprovalId,
    expectedVersion: number,
    choice: 'deny' | 'allow-once',
    now = this.clock(),
  ): ApprovalRecord {
    const current = this.expireIfDue(approvalId, now)
    if (current.status === 'expired') throw new ApprovalConflictError('expired')
    if (current.status === 'denied') throw new ApprovalConflictError('denied')
    if (current.status !== 'pending') throw new ApprovalConflictError('consumed')
    if (current.version !== expectedVersion) throw new ApprovalConflictError('mismatch')
    if (current.workspaceId !== this.workspaceId) throw new ApprovalConflictError('unauthorized')
    const nextBase = {
      ...current,
      version: current.version + 1,
      updatedAt: now,
      resolvedAt: now,
    }
    const next: ApprovalRecord = choice === 'deny'
      ? { ...nextBase, status: 'denied' }
      : { ...nextBase, status: 'allowed-once' }
    return this.cas(current, next)
  }

  consume(approvalId: ApprovalId, invocation: ToolInvocation, now = this.clock()): ApprovalConsumed {
    const current = this.expireIfDue(approvalId, now)
    if (current.status === 'expired') throw new ApprovalConflictError('expired')
    if (current.status === 'stale') throw new ApprovalConflictError('stale')
    if (current.status === 'denied') throw new ApprovalConflictError('denied')
    if (current.status !== 'allowed-once') throw new ApprovalConflictError('consumed')
    const liveHash = computeOperationHash(invocation)
    if (current.operationHash !== liveHash || current.targetFingerprint !== invocation.target.fingerprint) {
      const stale: ApprovalStale = {
        ...current,
        status: 'stale',
        version: current.version + 1,
        staleAt: now,
        updatedAt: now,
      }
      this.cas(current, stale)
      throw new ApprovalConflictError('stale')
    }
    const consumed: ApprovalConsumed = {
      ...current,
      status: 'consumed',
      version: current.version + 1,
      consumedAt: now,
      updatedAt: now,
    }
    this.cas(current, consumed)
    return consumed
  }

  markStale(approvalId: ApprovalId, now = this.clock()): ApprovalStale {
    const current = this.get(approvalId)
    if (!current) throw new ApprovalConflictError('unauthorized')
    if (current.status === 'stale') return current
    if (current.status === 'consumed' || current.status === 'denied' || current.status === 'expired') {
      throw new ApprovalConflictError(current.status === 'consumed' ? 'consumed' : current.status === 'denied' ? 'denied' : 'expired')
    }
    const stale: ApprovalStale = {
      ...current,
      status: 'stale',
      version: current.version + 1,
      staleAt: now,
      updatedAt: now,
    }
    this.cas(current, stale)
    return stale
  }
}

export class StandingRuleStore {
  readonly rootPath: string
  private readonly workspaceId: string
  private readonly clock: () => string
  private readonly rules = new Map<string, StandingRule>()

  constructor(options: ApprovalStoreOptions) {
    this.rootPath = join(options.workspaceRoot, 'standing-rules')
    this.workspaceId = options.workspaceId
    this.clock = options.clock ?? options.now ?? (() => new Date().toISOString())
    ensureDurableDirectory(this.rootPath)
    this.reload()
  }

  reload(): void {
    this.rules.clear()
    if (!existsSync(this.rootPath)) return
    for (const entry of readdirSync(this.rootPath)) {
      if (!entry.endsWith('.json')) continue
      const parsed = readJsonFile(join(this.rootPath, entry))
      if (isRule(parsed)) this.rules.set(parsed.ruleId, parsed)
    }
  }

  list(botId?: string): StandingRule[] {
    return [...this.rules.values()].filter((rule) => botId === undefined || rule.botId === botId)
  }

  get(ruleId: StandingRuleId): StandingRule | null {
    return this.rules.get(ruleId) ?? null
  }

  create(rule: StandingRule): StandingRule {
    if (rule.workspaceId !== this.workspaceId) throw new ApprovalConflictError('unauthorized')
    const bounded: StandingRule = {
      ...rule,
      target: truncateUtf8(rule.target, APPROVAL_LIMITS.ruleTargetBytes),
    }
    const path = join(this.rootPath, `${bounded.ruleId}.json`)
    if (!writeJsonIfAbsent(path, bounded)) {
      this.reload()
      const existing = this.get(bounded.ruleId)
      if (existing) return existing
      throw new ApprovalConflictError('mismatch')
    }
    this.rules.set(bounded.ruleId, bounded)
    return bounded
  }

  disable(ruleId: StandingRuleId, expectedVersion: number): StandingRule {
    const current = this.get(ruleId)
    if (!current) throw new ApprovalConflictError('unauthorized')
    if (current.version !== expectedVersion) throw new ApprovalConflictError('mismatch')
    const now = this.clock()
    const next: StandingRule = {
      ...current,
      version: current.version + 1,
      state: 'disabled',
      updatedAt: now,
      disabledAt: now,
    }
    writeJsonRecord(join(this.rootPath, `${ruleId}.json`), next)
    this.rules.set(ruleId, next)
    return next
  }

  delete(ruleId: StandingRuleId): void {
    const current = this.get(ruleId)
    if (!current) throw new ApprovalConflictError('unauthorized')
    rmSync(join(this.rootPath, `${ruleId}.json`), { force: true })
    this.rules.delete(ruleId)
  }
}
