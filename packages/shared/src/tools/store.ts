import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, renameSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { join } from 'node:path'
import {
  APPROVAL_LIMITS,
  APPROVAL_SCHEMA_VERSION,
  APPROVAL_STATUSES,
  STANDING_RULE_EFFECTS,
  STANDING_RULE_STATES,
  TOOL_SIDE_EFFECTS,
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
  assertDirectory,
  assertDurableLock,
  assertRegularFile,
  ensureDurableDirectory,
  withDurableLock,
} from '../spawn-tasks/durable-fs.ts'
import { readJsonFile, removePointer, writeJsonIfAbsent, writeJsonRecord } from '../conversations/durable-json.ts'
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

const SAFE_APPROVAL_ID = /^approval_[A-Za-z0-9_-]{1,254}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clone<T>(value: T): T { return structuredClone(value) }
function assertTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value || !Number.isFinite(Date.parse(value))) throw new TypeError(`${field} must be an ISO timestamp`)
  return value
}

function parseApprovalRecord(value: unknown, expectedApprovalId: string, workspaceId: string): ApprovalRecord {
  if (!isRecord(value) || value.schemaVersion !== APPROVAL_SCHEMA_VERSION || value.approvalId !== expectedApprovalId || value.workspaceId !== workspaceId) throw new Error('Approval record is corrupt')
  if (!SAFE_APPROVAL_ID.test(expectedApprovalId) || typeof value.status !== 'string' || !APPROVAL_STATUSES.includes(value.status as typeof APPROVAL_STATUSES[number])) throw new Error('Approval record is corrupt')
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 1 || !Number.isSafeInteger(value.attempt) || (value.attempt as number) < 1) throw new Error('Approval record is corrupt')
  for (const field of ['botId', 'conversationId', 'runtimeId', 'toolName', 'toolSchemaVersion', 'operationHash', 'targetFingerprint', 'policyRevision', 'expiresAt', 'createdAt', 'updatedAt']) {
    if (typeof value[field] !== 'string' || !value[field]) throw new Error('Approval record is corrupt')
  }
  if (!isRecord(value.sanitized) || value.sanitized.toolName !== value.toolName || typeof value.sanitized.target !== 'string' || !value.sanitized.target || typeof value.sanitized.preview !== 'string' || !value.sanitized.preview || typeof value.sanitized.sideEffect !== 'string' || !TOOL_SIDE_EFFECTS.includes(value.sanitized.sideEffect as typeof TOOL_SIDE_EFFECTS[number])) throw new Error('Approval record is corrupt')
  for (const field of ['expiresAt', 'createdAt', 'updatedAt']) {
    if (!Number.isFinite(Date.parse(value[field] as string))) throw new Error('Approval record is corrupt')
  }
  const statusField = value.status === 'denied' || value.status === 'allowed-once' ? 'resolvedAt' : value.status === 'consumed' ? 'consumedAt' : value.status === 'expired' ? 'expiredAt' : value.status === 'stale' ? 'staleAt' : null
  if (statusField && (typeof value[statusField] !== 'string' || !Number.isFinite(Date.parse(value[statusField] as string)))) throw new Error('Approval record is corrupt')
  return value as unknown as ApprovalRecord
}

function assertApprovalId(value: string): string {
  if (!SAFE_APPROVAL_ID.test(value)) throw new TypeError('approvalId must be an opaque path-safe ID')
  return value
}

const SAFE_RULE_ID = /^rule_[A-Za-z0-9_-]{1,254}$/

function parseStandingRule(value: unknown, expectedRuleId: string, workspaceId: string): StandingRule {
  if (!isRecord(value) || value.schemaVersion !== APPROVAL_SCHEMA_VERSION || value.ruleId !== expectedRuleId || value.workspaceId !== workspaceId) throw new Error('Standing rule is corrupt')
  if (!SAFE_RULE_ID.test(expectedRuleId) || typeof value.effect !== 'string' || !STANDING_RULE_EFFECTS.includes(value.effect as typeof STANDING_RULE_EFFECTS[number]) || typeof value.state !== 'string' || !STANDING_RULE_STATES.includes(value.state as typeof STANDING_RULE_STATES[number])) throw new Error('Standing rule is corrupt')
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 1) throw new Error('Standing rule is corrupt')
  for (const field of ['botId', 'toolName', 'target', 'targetFingerprint', 'createdAt', 'updatedAt']) {
    if (typeof value[field] !== 'string' || !value[field]) throw new Error('Standing rule is corrupt')
  }
  for (const field of ['createdAt', 'updatedAt']) {
    if (!Number.isFinite(Date.parse(value[field] as string))) throw new Error('Standing rule is corrupt')
  }
  if (value.disabledAt !== undefined && (typeof value.disabledAt !== 'string' || !Number.isFinite(Date.parse(value.disabledAt)))) throw new Error('Standing rule is corrupt')
  return value as unknown as StandingRule
}

function assertRuleId(value: string): string {
  if (!SAFE_RULE_ID.test(value)) throw new TypeError('ruleId must be an opaque path-safe ID')
  return value
}

function isValidApprovalCasTransition(current: ApprovalRecord, next: ApprovalRecord): boolean {
  const allowed = current.status === 'pending'
    ? ['denied', 'allowed-once', 'expired', 'stale']
    : current.status === 'allowed-once'
      ? ['consumed', 'stale']
      : []
  if (!allowed.includes(next.status) || next.version !== current.version + 1) return false
  const field = next.status === 'denied' || next.status === 'allowed-once'
    ? 'resolvedAt'
    : next.status === 'consumed'
      ? 'consumedAt'
      : next.status === 'expired'
        ? 'expiredAt'
        : 'staleAt'
  const expected = { ...current, status: next.status, version: next.version, updatedAt: next.updatedAt } as Record<string, unknown>
  expected[field] = (next as unknown as Record<string, unknown>)[field]
  return isDeepStrictEqual(next, expected)
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
    return join(this.rootPath, assertApprovalId(approvalId))
  }

  private recordPath(approvalId: string): string {
    return join(this.recordDir(approvalId), 'record.json')
  }

  private casPath(approvalId: string, version: number): string {
    return join(this.recordDir(approvalId), 'cas', String(version))
  }

  private lockPath(approvalId: string): string {
    return join(this.recordDir(approvalId), '.lock')
  }

  private quarantine(path: string, _error: unknown): void {
    try { renameSync(path, `${path}.corrupt-${randomUUID()}`) } catch { /* another process may have removed it */ }
  }

  reload(): void {
    this.records.clear()
    if (!existsSync(this.rootPath)) return
    for (const entry of readdirSync(this.rootPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      let approvalId: string
      try { approvalId = assertApprovalId(entry.name) } catch (error) {
        this.quarantine(join(this.rootPath, entry.name), error)
        continue
      }
      const path = this.recordPath(approvalId)
      try {
        assertRegularFile(path, 'Approval record')
        const parsed = readJsonFile(path)
        if (parsed) this.records.set(approvalId, parseApprovalRecord(parsed, approvalId, this.workspaceId))
      } catch (error) {
        this.quarantine(path, error)
      }
    }
    this.recoverCasMarkers()
  }

  private readCasMarker(path: string, approvalId: string, expectedVersion: number): ApprovalRecord {
    assertRegularFile(path, 'Approval CAS marker')
    const next = parseApprovalRecord(readJsonFile(path), approvalId, this.workspaceId)
    if (next.version !== expectedVersion + 1) throw new Error('Approval CAS marker version is corrupt')
    return next
  }

  private recoverCasMarkers(): void {
    for (const entry of readdirSync(this.rootPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      let approvalId: string
      try { approvalId = assertApprovalId(entry.name) } catch { continue }
      const casDirectory = join(this.recordDir(approvalId), 'cas')
      if (!existsSync(casDirectory)) continue
      let markers: string[]
      try {
        assertDirectory(casDirectory, 'Approval CAS directory')
        markers = readdirSync(casDirectory)
      } catch (error) {
        this.quarantine(casDirectory, error)
        continue
      }
      for (const marker of markers) {
        const path = join(casDirectory, marker)
        const expectedVersion = Number(marker)
        if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || String(expectedVersion) !== marker) {
          try {
            withDurableLock(this.lockPath(approvalId), (lockToken) => {
              if (existsSync(path)) {
                assertDurableLock(this.lockPath(approvalId), lockToken)
                this.quarantine(path, new Error('Approval CAS marker identity is corrupt'))
              }
            })
          } catch (error) {
            if (!(error instanceof Error) || !error.message.startsWith('Durable lock ')) throw error
          }
          continue
        }
        try {
          withDurableLock(this.lockPath(approvalId), (lockToken) => {
            try {
              const current = this.get(approvalId)
              const next = this.readCasMarker(path, approvalId, expectedVersion)
              if (!current) {
                assertDurableLock(this.lockPath(approvalId), lockToken)
                this.quarantine(path, new Error('Approval CAS marker has no record'))
                return
              }
              if (current.version > expectedVersion) {
                if (current.version === next.version && !isDeepStrictEqual(current, next)) throw new Error('Approval CAS marker conflicts with committed record')
                assertDurableLock(this.lockPath(approvalId), lockToken)
                removePointer(path)
                return
              }
              if (current.version < expectedVersion) throw new Error('Approval CAS marker is ahead of its record')
              if (!isValidApprovalCasTransition(current, next)) throw new Error('Approval CAS transition is invalid')
              assertDurableLock(this.lockPath(approvalId), lockToken)
              writeJsonRecord(this.recordPath(approvalId), next)
              assertDurableLock(this.lockPath(approvalId), lockToken)
              this.records.set(approvalId, next)
              assertDurableLock(this.lockPath(approvalId), lockToken)
              removePointer(path)
            } catch (error) {
              if (error instanceof Error && error.message.startsWith('Durable lock ')) throw error
              assertDurableLock(this.lockPath(approvalId), lockToken)
              if (existsSync(path)) this.quarantine(path, error)
            }
          })
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('Durable lock ')) continue
          throw error
        }
      }
    }
  }

  get(approvalId: string): ApprovalRecord | null {
    const path = this.recordPath(approvalId)
    if (!existsSync(path)) {
      this.records.delete(approvalId)
      return null
    }
    try {
      assertRegularFile(path, 'Approval record')
      const parsed = parseApprovalRecord(readJsonFile(path), assertApprovalId(approvalId), this.workspaceId)
      this.records.set(approvalId, parsed)
      return clone(parsed)
    } catch (error) {
      this.records.delete(approvalId)
      this.quarantine(path, error)
      return null
    }
  }

  listPending(conversationId: string): ApprovalPending[] {
    this.reload()
    return [...this.records.values()].filter(
      (record): record is ApprovalPending => record.status === 'pending' && record.conversationId === conversationId,
    ).map(clone)
  }

  listForConversation(conversationId: string): ApprovalRecord[] {
    this.reload()
    return [...this.records.values()].filter((record) => record.conversationId === conversationId).map(clone)
  }

  findOpenByHash(operationHash: string): ApprovalPending | ApprovalAllowedOnce | null {
    this.reload()
    for (const record of this.records.values()) {
      if (record.operationHash !== operationHash) continue
      if (record.status === 'pending' || record.status === 'allowed-once') return clone(record)
    }
    return null
  }

  createPending(record: ApprovalPending): ApprovalPending {
    const pending = parseApprovalRecord(record, assertApprovalId(record.approvalId), this.workspaceId)
    if (pending.status !== 'pending') throw new TypeError('Approval record must be pending')
    ensureDurableDirectory(this.recordDir(pending.approvalId))
    return withDurableLock(this.lockPath(pending.approvalId), (lockToken) => {
      const existing = this.get(pending.approvalId)
      if (existing?.status === 'pending') {
        if (existing.operationHash !== pending.operationHash || existing.targetFingerprint !== pending.targetFingerprint || existing.botId !== pending.botId || existing.conversationId !== pending.conversationId || existing.runtimeId !== pending.runtimeId) throw new ApprovalConflictError('mismatch')
        return clone(existing)
      }
      assertDurableLock(this.lockPath(pending.approvalId), lockToken)
      if (!writeJsonIfAbsent(this.recordPath(pending.approvalId), pending)) {
        const latest = this.get(pending.approvalId)
        if (latest?.status === 'pending') {
          if (latest.operationHash !== pending.operationHash || latest.targetFingerprint !== pending.targetFingerprint || latest.botId !== pending.botId || latest.conversationId !== pending.conversationId || latest.runtimeId !== pending.runtimeId) throw new ApprovalConflictError('mismatch')
          return clone(latest)
        }
        throw new ApprovalConflictError('consumed')
      }
      assertDurableLock(this.lockPath(pending.approvalId), lockToken)
      this.records.set(pending.approvalId, pending)
      return clone(pending)
    })
  }

  private cas(current: ApprovalRecord, next: ApprovalRecord): ApprovalRecord {
    ensureDurableDirectory(join(this.recordDir(current.approvalId), 'cas'))
    return withDurableLock(this.lockPath(current.approvalId), (lockToken) => {
      const latest = this.get(current.approvalId)
      if (!latest || latest.version !== current.version) throw new ApprovalConflictError('consumed')
      const marker = this.casPath(current.approvalId, current.version)
      let existing: ApprovalRecord | null = null
      if (existsSync(marker)) {
        try {
          existing = this.readCasMarker(marker, current.approvalId, current.version)
        } catch (error) {
          assertDurableLock(this.lockPath(current.approvalId), lockToken)
          this.quarantine(marker, error)
        }
      }
      if (existing && !isValidApprovalCasTransition(current, existing)) {
        assertDurableLock(this.lockPath(current.approvalId), lockToken)
        this.quarantine(marker, new Error('Approval CAS transition is invalid'))
        existing = null
      }
      if (existing && !isDeepStrictEqual(existing, next)) throw new ApprovalConflictError('consumed')
      if (!existing) {
        assertDurableLock(this.lockPath(current.approvalId), lockToken)
        if (!writeJsonIfAbsent(marker, next)) throw new ApprovalConflictError('consumed')
      }
      assertDurableLock(this.lockPath(current.approvalId), lockToken)
      writeJsonRecord(this.recordPath(current.approvalId), next)
      assertDurableLock(this.lockPath(current.approvalId), lockToken)
      const committed = this.get(current.approvalId)
      if (!committed || committed.version !== next.version || committed.status !== next.status) throw new ApprovalConflictError('consumed')
      assertDurableLock(this.lockPath(current.approvalId), lockToken)
      removePointer(marker)
      this.records.set(current.approvalId, committed)
      return clone(committed)
    })
  }

  expireIfDue(approvalId: ApprovalId, now = this.clock()): ApprovalRecord {
    const at = assertTimestamp(now, 'now')
    const current = this.get(approvalId)
    if (!current) throw new ApprovalConflictError('unauthorized')
    if (current.status !== 'pending') return current
    if (Date.parse(at) < Date.parse(current.expiresAt)) return current
    const expired: ApprovalExpired = {
      ...current,
      status: 'expired',
      version: current.version + 1,
      expiredAt: at,
      updatedAt: at,
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
    const at = assertTimestamp(now, 'now')
    const current = this.expireIfDue(approvalId, at)
    if (current.status === 'expired') throw new ApprovalConflictError('expired')
    if (current.status === 'denied') throw new ApprovalConflictError('denied')
    if (current.status !== 'pending') throw new ApprovalConflictError('consumed')
    if (current.version !== expectedVersion) throw new ApprovalConflictError('mismatch')
    if (current.workspaceId !== this.workspaceId) throw new ApprovalConflictError('unauthorized')
    const nextBase = {
      ...current,
      version: current.version + 1,
      updatedAt: at,
      resolvedAt: at,
    }
    const next: ApprovalRecord = choice === 'deny'
      ? { ...nextBase, status: 'denied' }
      : { ...nextBase, status: 'allowed-once' }
    return this.cas(current, next)
  }

  consume(approvalId: ApprovalId, invocation: ToolInvocation, now = this.clock()): ApprovalConsumed {
    const at = assertTimestamp(now, 'now')
    const current = this.expireIfDue(approvalId, at)
    if (current.status === 'expired') throw new ApprovalConflictError('expired')
    if (current.status === 'stale') throw new ApprovalConflictError('stale')
    if (current.status === 'denied') throw new ApprovalConflictError('denied')
    if (current.status !== 'allowed-once') throw new ApprovalConflictError('consumed')
    if (
      current.workspaceId !== invocation.workspaceId
      || current.botId !== invocation.botId
      || current.conversationId !== invocation.conversationId
      || current.runtimeId !== invocation.runtimeId
    ) throw new ApprovalConflictError('unauthorized')
    const liveHash = computeOperationHash(invocation)
    if (current.operationHash !== liveHash || current.targetFingerprint !== invocation.target.fingerprint) {
      const stale: ApprovalStale = {
        ...current,
        status: 'stale',
        version: current.version + 1,
        staleAt: at,
        updatedAt: at,
      }
      this.cas(current, stale)
      throw new ApprovalConflictError('stale')
    }
    const consumed: ApprovalConsumed = {
      ...current,
      status: 'consumed',
      version: current.version + 1,
      consumedAt: at,
      updatedAt: at,
    }
    this.cas(current, consumed)
    return clone(consumed)
  }

  markStale(approvalId: ApprovalId, now = this.clock()): ApprovalStale {
    const at = assertTimestamp(now, 'now')
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
      staleAt: at,
      updatedAt: at,
    }
    this.cas(current, stale)
    return clone(stale)
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
      const path = join(this.rootPath, entry)
      try {
        assertRegularFile(path, 'Standing rule')
        const raw = readJsonFile(path)
        if (raw) {
          const ruleId = assertRuleId(entry.slice(0, -5))
          this.rules.set(ruleId, parseStandingRule(raw, ruleId, this.workspaceId))
        }
      } catch (error) {
        try { renameSync(path, `${path}.corrupt-${randomUUID()}`) } catch { /* another process may have removed it */ }
      }
    }
  }

  list(botId?: string): StandingRule[] {
    this.reload()
    return [...this.rules.values()].filter((rule) => botId === undefined || rule.botId === botId).map(clone)
  }

  get(ruleId: StandingRuleId): StandingRule | null {
    const id = assertRuleId(ruleId)
    const path = join(this.rootPath, `${id}.json`)
    if (!existsSync(path)) {
      this.rules.delete(id)
      return null
    }
    try {
      assertRegularFile(path, 'Standing rule')
      const rule = parseStandingRule(readJsonFile(path), id, this.workspaceId)
      this.rules.set(id, rule)
      return clone(rule)
    } catch (error) {
      this.rules.delete(id)
      try { renameSync(path, `${path}.corrupt-${randomUUID()}`) } catch { /* another process may have removed it */ }
      return null
    }
  }

  create(rule: StandingRule): StandingRule {
    const bounded = parseStandingRule({ ...rule, target: truncateUtf8(rule.target, APPROVAL_LIMITS.ruleTargetBytes) }, assertRuleId(rule.ruleId), this.workspaceId)
    const path = join(this.rootPath, `${bounded.ruleId}.json`)
    return withDurableLock(this.lockPath(bounded.ruleId), (lockToken) => {
      const existing = this.get(bounded.ruleId)
      if (existing) {
        if (existing.botId !== bounded.botId || existing.toolName !== bounded.toolName || existing.targetFingerprint !== bounded.targetFingerprint || existing.effect !== bounded.effect) throw new ApprovalConflictError('mismatch')
        return clone(existing)
      }
      assertDurableLock(this.lockPath(bounded.ruleId), lockToken)
      if (!writeJsonIfAbsent(path, bounded)) {
        const latest = this.get(bounded.ruleId)
        if (latest) return clone(latest)
        throw new ApprovalConflictError('mismatch')
      }
      assertDurableLock(this.lockPath(bounded.ruleId), lockToken)
      this.rules.set(bounded.ruleId, bounded)
      return clone(bounded)
    })
  }

  disable(ruleId: StandingRuleId, expectedVersion: number): StandingRule {
    const id = assertRuleId(ruleId)
    return withDurableLock(this.lockPath(id), (lockToken) => {
      const current = this.get(id)
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
      assertDurableLock(this.lockPath(id), lockToken)
      writeJsonRecord(join(this.rootPath, `${id}.json`), next)
      assertDurableLock(this.lockPath(id), lockToken)
      this.rules.set(id, next)
      return clone(next)
    })
  }

  delete(ruleId: StandingRuleId): void {
    const id = assertRuleId(ruleId)
    withDurableLock(this.lockPath(id), (lockToken) => {
      if (!this.get(id)) throw new ApprovalConflictError('unauthorized')
      assertDurableLock(this.lockPath(id), lockToken)
      removePointer(join(this.rootPath, `${id}.json`))
      this.rules.delete(id)
    })
  }

  private lockPath(ruleId: string): string { return join(this.rootPath, `.${assertRuleId(ruleId)}.lock`) }
}
