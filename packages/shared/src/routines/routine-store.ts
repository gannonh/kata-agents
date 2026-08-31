import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Cron } from 'croner'
import type {
  RoutineDestination,
  RoutineFailurePolicy,
  RoutineId,
  RoutineLifecycle,
  RoutineOccurrence,
  RoutinePublicDto,
  RoutineRecord,
  RoutineRevision,
  RoutineRun,
  RoutineRunId,
  RoutineRunPublicDto,
  RoutineRunState,
  RoutineTrigger,
  TriggerOccurrenceId,
  RoutineApprovalBoundary,
} from '@kata-sh/core'
import { ROUTINE_SCHEMA_VERSION } from '@kata-sh/core'
import { ensureDurableDirectory } from '../spawn-tasks/durable-fs.ts'
import { isPotentiallyCatastrophicRegex } from '../automations/regex-safety.ts'
import { readJsonFile, removePointer, writeJsonIfAbsent, writeJsonRecord } from '../conversations/durable-json.ts'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/
const MAX_TEXT_BYTES = 256 * 1024

type Clock = () => string

export interface RoutineStoreOptions {
  readonly workspaceRoot: string
  readonly workspaceId: string
  readonly clock?: Clock
  readonly randomId?: () => string
}

export interface CreateRoutineInput {
  readonly routineId?: RoutineId
  readonly ownerBotId: string
  readonly name: string
  readonly trigger: RoutineTrigger
  readonly input: string
  readonly expectedResult: string
  readonly approvalBoundary: RoutineApprovalBoundary
  readonly failurePolicy: RoutineFailurePolicy
  readonly destination: RoutineDestination
}

export interface UpdateRoutineInput {
  readonly name?: string
  readonly trigger?: RoutineTrigger
  readonly input?: string
  readonly expectedResult?: string
  readonly approvalBoundary?: RoutineApprovalBoundary
  readonly failurePolicy?: RoutineFailurePolicy
  readonly destination?: RoutineDestination
}

export interface RecordOccurrenceInput {
  readonly routineId: RoutineId
  readonly routineRevision: number
  readonly source: string
  readonly scheduledInstant?: string
  readonly externalEventId?: string
  readonly occurrenceId?: TriggerOccurrenceId
  readonly occurredAt?: string
}

export interface ClaimOccurrenceInput {
  readonly occurrenceId: TriggerOccurrenceId
  readonly workerId: string
  readonly leaseMs?: number
}

export interface CreateRoutineRunInput {
  readonly occurrenceId: TriggerOccurrenceId
  readonly ownerBotId: string
  readonly input?: string
  readonly destination?: RoutineDestination
  readonly origin?: RoutineRun['origin']
}

export interface RoutineRecoveryReport {
  readonly cutovers: string[]
  readonly transitions: string[]
}

export function routinesRootPath(workspaceRoot: string): string { return join(workspaceRoot, '.routines') }
export function deriveTriggerOccurrenceId(input: {
  routineId: RoutineId
  revision: number
  source: string
  scheduledInstant?: string
  externalEventId?: string
}): TriggerOccurrenceId {
  const discriminator = input.scheduledInstant ?? input.externalEventId
  if (!discriminator) throw new TypeError('scheduledInstant or externalEventId is required')
  return `occ_${createHash('sha256').update(`${input.routineId}\0${input.revision}\0${input.source}\0${discriminator}`, 'utf8').digest('hex').slice(0, 32)}` as TriggerOccurrenceId
}

export function deriveRoutineRunId(occurrenceId: TriggerOccurrenceId): RoutineRunId {
  return `run_${createHash('sha256').update(occurrenceId, 'utf8').digest('hex').slice(0, 32)}` as RoutineRunId
}

function clone<T>(value: T): T { return structuredClone(value) }
function assertId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new TypeError(`${field} must be an opaque path-safe ID`)
  return value
}
function assertText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be non-empty text`)
  if (Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES) throw new TypeError(`${field} exceeds ${MAX_TEXT_BYTES} bytes`)
  return value.trim()
}
function assertTimestamp(value: unknown, field: string): string {
  const timestamp = assertText(value, field)
  if (!Number.isFinite(Date.parse(timestamp))) throw new TypeError(`${field} must be an ISO timestamp`)
  return timestamp
}
function assertRevision(value: unknown, field = 'revision'): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${field} must be a positive safe integer`)
  return value as number
}
function assertTimezone(timezone: string): void {
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format() } catch { throw new TypeError(`Invalid timezone: ${timezone}`) }
}
function assertTrigger(value: unknown): RoutineTrigger {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('trigger must be an object')
  const trigger = value as Record<string, unknown>
  if (trigger.kind === 'schedule') {
    const cron = assertText(trigger.cron, 'trigger.cron')
    const timezone = assertText(trigger.timezone, 'trigger.timezone')
    assertTimezone(timezone)
    try { new Cron(cron, { timezone }) } catch (error) { throw new TypeError(`Invalid schedule: ${error instanceof Error ? error.message : String(error)}`) }
    const dst = trigger.dst
    if (!dst || typeof dst !== 'object' || (dst as Record<string, unknown>).gap !== 'skip' || (dst as Record<string, unknown>).fold !== 'once') {
      throw new TypeError('trigger.dst must specify gap=skip and fold=once')
    }
    return { kind: 'schedule', cron, timezone, dst: { gap: 'skip', fold: 'once' } }
  }
  if (trigger.kind === 'event') {
    const source = assertText(trigger.source, 'trigger.source')
    const matcher = trigger.matcher
    if (!matcher || typeof matcher !== 'object' || Array.isArray(matcher)) throw new TypeError('trigger.matcher must be an object')
    const field = assertText((matcher as Record<string, unknown>).field, 'trigger.matcher.field')
    const equals = (matcher as Record<string, unknown>).equals
    const matches = (matcher as Record<string, unknown>).matches
    if ((equals === undefined) === (matches === undefined)) throw new TypeError('trigger.matcher requires exactly one of equals or matches')
    if (equals !== undefined && typeof equals !== 'string') throw new TypeError('trigger.matcher.equals must be text')
    if (matches !== undefined && typeof matches !== 'string') throw new TypeError('trigger.matcher.matches must be text')
    if (matches !== undefined) {
      try { new RegExp(matches) } catch { throw new TypeError('trigger.matcher.matches must be a valid regex') }
      if (isPotentiallyCatastrophicRegex(matches)) throw new TypeError('trigger.matcher.matches is too complex')
    }
    return { kind: 'event', source, matcher: { field, ...(equals !== undefined ? { equals } : { matches }) } }
  }
  if (trigger.kind === 'on-demand') return { kind: 'on-demand' }
  throw new TypeError('Unsupported routine trigger kind')
}
function assertDestination(value: unknown): RoutineDestination {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('destination must be an object')
  const destination = value as Record<string, unknown>
  if (destination.kind !== 'direct' && destination.kind !== 'channel') throw new TypeError('Unsupported destination kind')
  const field = destination.kind === 'direct' ? 'chatId' : 'channelId'
  return { kind: destination.kind, [field]: assertId(destination[field], `destination.${field}`) } as RoutineDestination
}
function assertChoice<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new TypeError(`${field} is invalid`)
  return value as T
}
function assertRevisionRecord(value: unknown, workspaceId: string, routineId: string): RoutineRevision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Routine revision is corrupt')
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== ROUTINE_SCHEMA_VERSION || record.routineId !== routineId) throw new Error('Routine revision identity mismatch')
  return {
    schemaVersion: ROUTINE_SCHEMA_VERSION,
    routineId: routineId as RoutineId,
    revision: assertRevision(record.revision),
    trigger: assertTrigger(record.trigger),
    input: assertText(record.input, 'revision.input'),
    expectedResult: assertText(record.expectedResult, 'revision.expectedResult'),
    approvalBoundary: assertChoice(record.approvalBoundary, 'revision.approvalBoundary', ['safe', 'ask', 'allow-all'] as const),
    failurePolicy: assertChoice(record.failurePolicy, 'revision.failurePolicy', ['stop', 'retry', 'uncertain'] as const),
    destination: assertDestination(record.destination),
    createdAt: assertTimestamp(record.createdAt, 'revision.createdAt'),
  }
}
function assertRoutine(value: unknown, workspaceId: string): RoutineRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Routine record is corrupt')
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== ROUTINE_SCHEMA_VERSION || record.workspaceId !== workspaceId) throw new Error('Routine ownership or schema mismatch')
  return {
    schemaVersion: ROUTINE_SCHEMA_VERSION,
    routineId: assertId(record.routineId, 'routineId') as RoutineId,
    workspaceId,
    ownerBotId: assertId(record.ownerBotId, 'ownerBotId'),
    name: assertText(record.name, 'name'),
    lifecycle: assertChoice(record.lifecycle, 'lifecycle', ['enabled', 'paused', 'deleted'] as const),
    activeRevision: assertRevision(record.activeRevision, 'activeRevision'),
    createdAt: assertTimestamp(record.createdAt, 'createdAt'),
    updatedAt: assertTimestamp(record.updatedAt, 'updatedAt'),
  }
}
function assertOccurrence(value: unknown, workspaceId: string): RoutineOccurrence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Routine occurrence is corrupt')
  const record = value as Record<string, unknown>
  const occurrence = {
    schemaVersion: ROUTINE_SCHEMA_VERSION,
    occurrenceId: assertId(record.occurrenceId, 'occurrenceId') as TriggerOccurrenceId,
    routineId: assertId(record.routineId, 'routineId') as RoutineId,
    routineRevision: assertRevision(record.routineRevision, 'routineRevision'),
    source: assertText(record.source, 'source'),
    ...(record.scheduledInstant !== undefined ? { scheduledInstant: assertTimestamp(record.scheduledInstant, 'scheduledInstant') } : {}),
    ...(record.externalEventId !== undefined ? { externalEventId: assertText(record.externalEventId, 'externalEventId') } : {}),
    createdAt: assertTimestamp(record.createdAt, 'createdAt'),
    ...(record.claimedAt !== undefined ? { claimedAt: assertTimestamp(record.claimedAt, 'claimedAt') } : {}),
    ...(record.leaseUntil !== undefined ? { leaseUntil: assertTimestamp(record.leaseUntil, 'leaseUntil') } : {}),
    ...(record.workerId !== undefined ? { workerId: assertText(record.workerId, 'workerId') } : {}),
    ...(record.claimToken !== undefined ? { claimToken: assertText(record.claimToken, 'claimToken') } : {}),
  } as RoutineOccurrence
  if (!occurrence.scheduledInstant && !occurrence.externalEventId) throw new Error('Occurrence has no source identity')
  if (occurrence.scheduledInstant && occurrence.externalEventId) throw new Error('Occurrence has multiple source identities')
  if ((occurrence.claimedAt || occurrence.leaseUntil || occurrence.workerId || occurrence.claimToken) && (!occurrence.claimedAt || !occurrence.leaseUntil || !occurrence.workerId || !occurrence.claimToken)) throw new Error('Occurrence claim is incomplete')
  return occurrence
}
function assertRun(value: unknown, workspaceId: string): RoutineRun {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Routine run is corrupt')
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== ROUTINE_SCHEMA_VERSION) throw new Error('Routine run schema mismatch')
  const attempt = record.attempt === undefined ? 1 : record.attempt
  if (!Number.isSafeInteger(attempt) || (attempt as number) < 1) throw new Error('Routine run attempt is corrupt')
  if (!Number.isSafeInteger(record.version) || (record.version as number) < 1) throw new Error('Routine run version is corrupt')
  if (!record.origin || typeof record.origin !== 'object' || !record.state || typeof record.state !== 'object') throw new Error('Routine run is corrupt')
  const origin = record.origin as Record<string, unknown>
  if (origin.kind !== 'triggered' && origin.kind !== 'replay') throw new Error('Routine run origin is invalid')
  const parsedOrigin = origin.kind === 'triggered'
    ? { kind: 'triggered' as const, occurrenceId: assertId(origin.occurrenceId, 'origin.occurrenceId') as TriggerOccurrenceId }
    : { kind: 'replay' as const, occurrenceId: assertId(origin.occurrenceId, 'origin.occurrenceId') as TriggerOccurrenceId, replayOfRunId: assertId(origin.replayOfRunId, 'origin.replayOfRunId') as RoutineRunId }
  const state = record.state as Record<string, unknown>
  const kind = assertChoice(state.kind, 'state.kind', ['queued', 'claimed', 'running', 'awaiting-approval', 'succeeded', 'failed', 'cancelled', 'uncertain', 'reconciled'] as const)
  const at = assertTimestamp(state.at, 'state.at')
  let parsedState: RoutineRunState
  if (kind === 'queued' || kind === 'running') parsedState = { kind, at }
  else if (kind === 'claimed') parsedState = { kind, at, workerId: assertText(state.workerId, 'state.workerId'), leaseUntil: assertTimestamp(state.leaseUntil, 'state.leaseUntil') }
  else if (kind === 'awaiting-approval') parsedState = { kind, at, approvalId: assertId(state.approvalId, 'state.approvalId'), operationHash: assertText(state.operationHash, 'state.operationHash'), version: assertRevision(state.version, 'state.version') }
  else if (kind === 'succeeded' || kind === 'reconciled') parsedState = { kind, at, result: assertText(state.result, 'state.result') }
  else parsedState = { kind, at, ...(kind === 'failed' ? { error: assertText(state.error, 'state.error') } : { reason: assertText(state.reason, 'state.reason') }) } as RoutineRunState
  return {
    schemaVersion: ROUTINE_SCHEMA_VERSION,
    runId: assertId(record.runId, 'runId') as RoutineRunId,
    routineId: assertId(record.routineId, 'routineId') as RoutineId,
    routineRevision: assertRevision(record.routineRevision, 'routineRevision'),
    ownerBotId: assertId(record.ownerBotId, 'ownerBotId'),
    origin: parsedOrigin,
    destination: assertDestination(record.destination),
    input: assertText(record.input, 'input'),
    state: parsedState,
    attempt: attempt as number,
    version: record.version as number,
    createdAt: assertTimestamp(record.createdAt, 'createdAt'),
    updatedAt: assertTimestamp(record.updatedAt, 'updatedAt'),
  }
}

function publicState(state: RoutineRunState): RoutineRunPublicDto['state'] {
  if (state.kind === 'claimed') return { kind: 'claimed', at: state.at }
  if (state.kind === 'running' || state.kind === 'queued') return state
  if (state.kind === 'awaiting-approval') return { kind: 'awaiting-approval', at: state.at, approvalId: state.approvalId }
  return state
}

export function toRoutinePublicDto(record: RoutineRecord, revision: RoutineRevision): RoutinePublicDto {
  return { routineId: record.routineId, workspaceId: record.workspaceId, ownerBotId: record.ownerBotId, name: record.name, lifecycle: record.lifecycle, activeRevision: record.activeRevision, revision: clone(revision), createdAt: record.createdAt, updatedAt: record.updatedAt }
}
export function toRoutineRunPublicDto(run: RoutineRun): RoutineRunPublicDto {
  return { runId: run.runId, routineId: run.routineId, routineRevision: run.routineRevision, ownerBotId: run.ownerBotId, origin: clone(run.origin), destination: clone(run.destination), state: publicState(run.state), attempt: run.attempt, version: run.version, createdAt: run.createdAt, updatedAt: run.updatedAt }
}

export class RoutineStore {
  readonly rootPath: string
  readonly workspaceId: string
  private readonly clock: Clock
  private readonly randomId: () => string
  private readonly records = new Map<string, RoutineRecord>()

  constructor(options: RoutineStoreOptions) {
    this.workspaceId = assertId(options.workspaceId, 'workspaceId')
    this.rootPath = routinesRootPath(options.workspaceRoot)
    this.clock = options.clock ?? (() => new Date().toISOString())
    this.randomId = options.randomId ?? randomUUID
    for (const directory of ['routines', 'occurrences', 'runs', 'claims', 'occurrence-runs', 'cursors', 'cutovers', 'transitions']) ensureDurableDirectory(join(this.rootPath, directory))
    this.reload()
  }

  create(input: CreateRoutineInput): RoutineRecord {
    const routineId = assertId(input.routineId ?? `routine_${this.randomId()}`, 'routineId') as RoutineId
    if (this.records.has(routineId) || existsSync(this.recordPath(routineId))) throw new Error(`Routine already exists: ${routineId}`)
    const now = this.clock()
    const revision = this.buildRevision(routineId, 1, input, now)
    const record: RoutineRecord = { schemaVersion: ROUTINE_SCHEMA_VERSION, routineId, workspaceId: this.workspaceId, ownerBotId: assertId(input.ownerBotId, 'ownerBotId'), name: assertText(input.name, 'name'), lifecycle: 'enabled', activeRevision: 1, createdAt: now, updatedAt: now }
    writeJsonIfAbsent(this.revisionPath(routineId, 1), revision)
    writeJsonRecord(this.activePath(routineId), revision)
    writeJsonRecord(this.recordPath(routineId), record)
    this.records.set(routineId, record)
    return clone(record)
  }

  get(routineId: RoutineId): RoutineRecord | null { const record = this.records.get(assertId(routineId, 'routineId')); return record ? clone(record) : null }
  list(filter?: { ownerBotId?: string; lifecycle?: RoutineLifecycle }): RoutineRecord[] {
    return [...this.records.values()].filter(record => (!filter?.ownerBotId || record.ownerBotId === filter.ownerBotId) && (!filter?.lifecycle || record.lifecycle === filter.lifecycle)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(clone)
  }
  getRevision(routineId: RoutineId, revision: number): RoutineRevision {
    const id = assertId(routineId, 'routineId');
    const record = this.require(id)
    const number = assertRevision(revision)
    if (number > record.activeRevision) {
      const path = this.revisionPath(id, number)
      const raw = readJsonFile(path)
      if (!raw) throw new Error(`Routine revision not found: ${id}@${number}`)
      return clone(assertRevisionRecord(raw, this.workspaceId, id))
    }
    const raw = readJsonFile(this.revisionPath(id, number))
    if (!raw) throw new Error(`Routine revision not found: ${id}@${number}`)
    return clone(assertRevisionRecord(raw, this.workspaceId, id))
  }
  getActiveRevision(routineId: RoutineId): RoutineRevision { const record = this.require(routineId); return this.getRevision(record.routineId, record.activeRevision) }
  getPublic(routineId: RoutineId): RoutinePublicDto { const record = this.require(routineId); return toRoutinePublicDto(record, this.getRevision(record.routineId, record.activeRevision)) }

  update(routineId: RoutineId, input: UpdateRoutineInput): RoutineRecord {
    this.recover()
    const current = this.require(routineId)
    if (current.lifecycle === 'deleted') throw new Error('Cannot update a deleted routine')
    const previous = this.getActiveRevision(current.routineId)
    const nextRevision = current.activeRevision + 1
    const now = this.clock()
    const revision = this.buildRevision(current.routineId, nextRevision, {
      ownerBotId: current.ownerBotId,
      name: input.name ?? current.name,
      trigger: input.trigger ?? previous.trigger,
      input: input.input ?? previous.input,
      expectedResult: input.expectedResult ?? previous.expectedResult,
      approvalBoundary: input.approvalBoundary ?? previous.approvalBoundary,
      failurePolicy: input.failurePolicy ?? previous.failurePolicy,
      destination: input.destination ?? previous.destination,
    }, now)
    const revisionPath = this.revisionPath(current.routineId, nextRevision)
    const cutoverPath = this.cutoverPath(current.routineId, nextRevision)
    if (existsSync(revisionPath)) {
      const cutover = readJsonFile(cutoverPath) as Record<string, unknown> | null
      if (cutover?.state !== 'pending') throw new Error(`Routine revision has an incomplete cutover: ${current.routineId}@${nextRevision}`)
    }
    writeJsonIfAbsent(revisionPath, revision)
    writeJsonIfAbsent(cutoverPath, { routineId: current.routineId, previousRevision: current.activeRevision, nextRevision, nextName: assertText(input.name ?? current.name, 'name'), state: 'pending', createdAt: now })
    const active = this.readRevisionFile(current.routineId, nextRevision)
    writeJsonRecord(this.activePath(current.routineId), active)
    const next: RoutineRecord = { ...current, name: assertText(input.name ?? current.name, 'name'), activeRevision: nextRevision, updatedAt: now }
    writeJsonRecord(this.recordPath(current.routineId), next)
    writeJsonRecord(cutoverPath, { routineId: current.routineId, previousRevision: current.activeRevision, nextRevision, state: 'complete', createdAt: now, completedAt: this.clock() })
    this.records.set(current.routineId, next)
    return clone(next)
  }
  enable(routineId: RoutineId): RoutineRecord { return this.setLifecycle(routineId, 'enabled') }
  pause(routineId: RoutineId): RoutineRecord { return this.setLifecycle(routineId, 'paused') }
  delete(routineId: RoutineId): RoutineRecord { return this.setLifecycle(routineId, 'deleted') }
  private setLifecycle(routineId: RoutineId, lifecycle: RoutineLifecycle): RoutineRecord {
    const current = this.require(routineId)
    if (current.lifecycle === 'deleted' && lifecycle !== 'deleted') throw new Error('Deleted routines cannot be re-enabled')
    const next = { ...current, lifecycle, updatedAt: this.clock() }
    writeJsonRecord(this.recordPath(current.routineId), next)
    this.records.set(current.routineId, next)
    return clone(next)
  }

  recordOccurrence(input: RecordOccurrenceInput): RoutineOccurrence {
    const routine = this.require(input.routineId)
    const revision = this.getRevision(routine.routineId, input.routineRevision)
    if (revision.revision !== input.routineRevision) throw new Error('Routine occurrence revision mismatch')
    const scheduledInstant = input.scheduledInstant === undefined ? undefined : new Date(assertTimestamp(input.scheduledInstant, 'scheduledInstant')).toISOString()
    const externalEventId = input.externalEventId === undefined ? undefined : assertText(input.externalEventId, 'externalEventId')
    if ((scheduledInstant === undefined) === (externalEventId === undefined)) throw new TypeError('Exactly one occurrence identity is required')
    const source = assertText(input.source, 'source')
    const derivedOccurrenceId = deriveTriggerOccurrenceId({ routineId: routine.routineId, revision: input.routineRevision, source, ...(scheduledInstant ? { scheduledInstant } : { externalEventId }) })
    if (input.occurrenceId !== undefined && input.occurrenceId !== derivedOccurrenceId) throw new TypeError('occurrenceId does not match its trigger identity')
    const occurrenceId = (input.occurrenceId ?? derivedOccurrenceId) as TriggerOccurrenceId
    const createdAt = input.occurredAt === undefined ? this.clock() : new Date(assertTimestamp(input.occurredAt, 'occurredAt')).toISOString()
    const occurrence: RoutineOccurrence = { schemaVersion: ROUTINE_SCHEMA_VERSION, occurrenceId: assertId(occurrenceId, 'occurrenceId') as TriggerOccurrenceId, routineId: routine.routineId, routineRevision: input.routineRevision, source, ...(scheduledInstant ? { scheduledInstant } : { externalEventId }), createdAt }
    const path = this.occurrencePath(occurrence.occurrenceId)
    if (!writeJsonIfAbsent(path, occurrence)) {
      const existing = this.readOccurrence(occurrence.occurrenceId)
      if (existing.routineId !== occurrence.routineId || existing.routineRevision !== occurrence.routineRevision || existing.source !== occurrence.source || existing.scheduledInstant !== occurrence.scheduledInstant || existing.externalEventId !== occurrence.externalEventId) throw new Error('Occurrence identity collision')
      return existing
    }
    return clone(occurrence)
  }

  claimOccurrence(input: ClaimOccurrenceInput): RoutineOccurrence | null {
    const occurrence = this.readOccurrence(input.occurrenceId)
    const now = this.clock()
    const leaseMs = input.leaseMs ?? 120_000
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new TypeError('leaseMs must be positive')
    if (occurrence.leaseUntil && Date.parse(occurrence.leaseUntil) > Date.parse(now)) {
      return occurrence.workerId === input.workerId ? clone(occurrence) : null
    }
    const leaseUntil = new Date(Date.parse(now) + leaseMs).toISOString()
    const claimToken = `claim_${this.randomId()}`
    const claimPath = this.claimPath(occurrence.occurrenceId)
    const claim = { occurrenceId: occurrence.occurrenceId, workerId: assertText(input.workerId, 'workerId'), claimToken, leaseUntil }
    if (!writeJsonIfAbsent(claimPath, claim)) {
      const existing = readJsonFile(claimPath) as Record<string, unknown> | null
      if (existing?.leaseUntil && typeof existing.leaseUntil === 'string' && Date.parse(existing.leaseUntil) > Date.parse(now)) return null
      writeJsonRecord(claimPath, claim)
    }
    const claimed: RoutineOccurrence = { ...occurrence, claimedAt: now, leaseUntil, workerId: claim.workerId, claimToken }
    writeJsonRecord(this.occurrencePath(occurrence.occurrenceId), claimed)
    return clone(claimed)
  }

  createRun(input: CreateRoutineRunInput): RoutineRun {
    const occurrence = this.readOccurrence(input.occurrenceId)
    const routine = this.require(occurrence.routineId)
    const revision = this.getRevision(routine.routineId, occurrence.routineRevision)
    const runId = deriveRoutineRunId(occurrence.occurrenceId)
    const origin = input.origin ?? { kind: 'triggered' as const, occurrenceId: occurrence.occurrenceId }
    if (origin.occurrenceId !== occurrence.occurrenceId) throw new Error('Routine run origin occurrence mismatch')
    const now = this.clock()
    const run: RoutineRun = { schemaVersion: ROUTINE_SCHEMA_VERSION, runId, routineId: routine.routineId, routineRevision: occurrence.routineRevision, ownerBotId: assertId(input.ownerBotId, 'ownerBotId'), origin, destination: input.destination ? assertDestination(input.destination) : revision.destination, input: assertText(input.input ?? revision.input, 'input'), state: { kind: 'queued', at: now }, attempt: 1, version: 1, createdAt: now, updatedAt: now }
    if (run.ownerBotId !== routine.ownerBotId) throw new Error('Routine run owner mismatch')
    const runPath = this.runPath(runId)
    if (!writeJsonIfAbsent(runPath, run)) return this.readRun(runId)
    const pointerPath = this.occurrenceRunPath(occurrence.occurrenceId)
    if (!writeJsonIfAbsent(pointerPath, `${runId}\n`)) {
      const existing = readJsonFile(runPath)
      if (!existing) throw new Error('Occurrence run index points to a missing run')
      return this.readRun(runId)
    }
    return clone(run)
  }

  getRun(runId: RoutineRunId): RoutineRun | null { return existsSync(this.runPath(runId)) ? this.readRun(runId) : null }
  listAllRuns(): RoutineRun[] {
    const directory = join(this.rootPath, 'runs')
    if (!existsSync(directory)) return []
    return readdirSync(directory).filter(file => file.endsWith('.json')).map(file => this.readRun(file.slice(0, -5) as RoutineRunId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(clone)
  }
  listRuns(routineId: RoutineId): RoutineRun[] {
    const id = assertId(routineId, 'routineId')
    return this.listAllRuns().filter(run => run.routineId === id)
  }
  listHistory(routineId: RoutineId, limit = 50): RoutineRunPublicDto[] {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError('limit must be a non-negative safe integer')
    const runs = limit === 0 ? [] : this.listRuns(routineId).slice(-limit)
    return runs.reverse().map(toRoutineRunPublicDto)
  }

  transitionRun(runId: RoutineRunId, expectedVersion: number, next: RoutineRunState, options?: { attempt?: number }): RoutineRun {
    const current = this.readRun(runId)
    if (current.version !== expectedVersion) throw new Error(`Routine run version conflict: expected ${expectedVersion}, current ${current.version}`)
    assertTransition(current.state, next)
    const path = this.transitionPath(current.runId, expectedVersion)
    const attempt = options?.attempt ?? current.attempt
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new TypeError('attempt must be a positive safe integer')
    const marker = { runId: current.runId, expectedVersion, next, attempt }
    if (!writeJsonIfAbsent(path, marker)) {
      const existing = readJsonFile(path) as Record<string, unknown> | null
      if (!existing || JSON.stringify(existing.next) !== JSON.stringify(next)) throw new Error('Routine run transition conflict')
    }
    const updated: RoutineRun = { ...current, state: clone(next), attempt, version: current.version + 1, updatedAt: this.clock() }
    writeJsonRecord(this.runPath(current.runId), updated)
    removePointer(path)
    return clone(updated)
  }

  retryRun(runId: RoutineRunId, expectedVersion: number): RoutineRun {
    const current = this.readRun(runId)
    if (current.state.kind !== 'running') throw new Error('Only running routine runs can be retried')
    return this.transitionRun(runId, expectedVersion, { kind: 'queued', at: this.clock() }, { attempt: current.attempt + 1 })
  }

  listRecoverableRuns(now = this.clock()): RoutineRun[] {
    return this.allRuns().filter(run => run.state.kind === 'queued' || run.state.kind === 'running' || run.state.kind === 'awaiting-approval' || (run.state.kind === 'claimed' && Date.parse(run.state.leaseUntil) <= Date.parse(now))).map(clone)
  }

  getScheduleCursor(routineId: RoutineId, revision: number): string | null {
    const raw = readJsonFile(this.cursorPath(routineId, revision)) as Record<string, unknown> | null
    if (!raw) return null
    if (raw.routineId !== routineId || raw.revision !== revision) throw new Error('Schedule cursor identity mismatch')
    return assertTimestamp(raw.cursor, 'schedule cursor')
  }
  advanceScheduleCursor(routineId: RoutineId, revision: number, cursor: string): string {
    const next = assertTimestamp(cursor, 'schedule cursor')
    const current = this.getScheduleCursor(routineId, revision)
    if (current && Date.parse(next) < Date.parse(current)) throw new Error('Schedule cursor cannot move backwards')
    writeJsonRecord(this.cursorPath(routineId, revision), { routineId, revision, cursor: next })
    return next
  }

  recover(): RoutineRecoveryReport {
    const cutovers: string[] = []
    const transitions: string[] = []
    const cutoverDir = join(this.rootPath, 'cutovers')
    for (const file of readdirSync(cutoverDir).filter(name => name.endsWith('.json'))) {
      const raw = readJsonFile(join(cutoverDir, file)) as Record<string, unknown> | null
      if (!raw || raw.state !== 'pending') continue
      try {
        const routineId = assertId(raw.routineId, 'routineId') as RoutineId
        const nextRevision = assertRevision(raw.nextRevision, 'nextRevision')
        const current = this.require(routineId)
        const revision = this.readRevisionFile(routineId, nextRevision)
        writeJsonRecord(this.activePath(routineId), revision)
        const next = { ...current, name: assertText(raw.nextName ?? current.name, 'name'), activeRevision: nextRevision, updatedAt: this.clock() }
        writeJsonRecord(this.recordPath(routineId), next)
        this.records.set(routineId, next)
        writeJsonRecord(join(cutoverDir, file), { ...raw, state: 'complete', completedAt: this.clock() })
        cutovers.push(file)
      } catch { /* Leave corrupt data visible for operator recovery. */ }
    }
    const transitionDir = join(this.rootPath, 'transitions')
    for (const file of readdirSync(transitionDir).filter(name => name.endsWith('.json'))) {
      const raw = readJsonFile(join(transitionDir, file)) as Record<string, unknown> | null
      if (!raw) continue
      const runId = assertId(raw.runId, 'runId') as RoutineRunId
      const current = this.getRun(runId)
      if (!current) continue
      if (current.version === raw.expectedVersion) {
        this.transitionRun(runId, raw.expectedVersion as number, raw.next as RoutineRunState, { attempt: raw.attempt as number | undefined })
        transitions.push(runId)
      } else removePointer(join(transitionDir, file))
    }
    return { cutovers, transitions }
  }

  reload(): void {
    this.records.clear()
    const directory = join(this.rootPath, 'routines')
    if (!existsSync(directory)) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const raw = readJsonFile(this.recordPath(entry.name))
      if (raw) this.records.set(entry.name, assertRoutine(raw, this.workspaceId))
    }
  }

  private buildRevision(routineId: RoutineId, revision: number, input: CreateRoutineInput, createdAt: string): RoutineRevision {
    return { schemaVersion: ROUTINE_SCHEMA_VERSION, routineId, revision, trigger: assertTrigger(input.trigger), input: assertText(input.input, 'input'), expectedResult: assertText(input.expectedResult, 'expectedResult'), approvalBoundary: assertChoice(input.approvalBoundary, 'approvalBoundary', ['safe', 'ask', 'allow-all'] as const), failurePolicy: assertChoice(input.failurePolicy, 'failurePolicy', ['stop', 'retry', 'uncertain'] as const), destination: assertDestination(input.destination), createdAt: assertTimestamp(createdAt, 'createdAt') }
  }
  private require(routineId: RoutineId | string): RoutineRecord { const record = this.records.get(assertId(routineId, 'routineId')); if (!record) throw new Error(`Routine not found: ${routineId}`); return record }
  private readRevisionFile(routineId: RoutineId | string, revision: number): RoutineRevision { const raw = readJsonFile(this.revisionPath(routineId, revision)); if (!raw) throw new Error(`Routine revision not found: ${routineId}@${revision}`); return assertRevisionRecord(raw, this.workspaceId, assertId(routineId, 'routineId')) }
  private readOccurrence(id: TriggerOccurrenceId): RoutineOccurrence { const raw = readJsonFile(this.occurrencePath(id)); if (!raw) throw new Error(`Routine occurrence not found: ${id}`); return clone(assertOccurrence(raw, this.workspaceId)) }
  private readRun(id: RoutineRunId): RoutineRun { const raw = readJsonFile(this.runPath(id)); if (!raw) throw new Error(`Routine run not found: ${id}`); return clone(assertRun(raw, this.workspaceId)) }
  private allRuns(): RoutineRun[] { return this.listAllRuns() }
  private recordPath(id: RoutineId | string): string { return join(this.rootPath, 'routines', assertId(id, 'routineId'), 'record.json') }
  private revisionPath(id: RoutineId | string, revision: number): string { return join(this.rootPath, 'routines', assertId(id, 'routineId'), 'revisions', `${assertRevision(revision)}.json`) }
  private activePath(id: RoutineId | string): string { return join(this.rootPath, 'routines', assertId(id, 'routineId'), 'active.json') }
  private occurrencePath(id: TriggerOccurrenceId): string { return join(this.rootPath, 'occurrences', `${assertId(id, 'occurrenceId')}.json`) }
  private claimPath(id: TriggerOccurrenceId): string { return join(this.rootPath, 'claims', `${assertId(id, 'occurrenceId')}.json`) }
  private runPath(id: RoutineRunId): string { return join(this.rootPath, 'runs', `${assertId(id, 'runId')}.json`) }
  private occurrenceRunPath(id: TriggerOccurrenceId): string { return join(this.rootPath, 'occurrence-runs', `${assertId(id, 'occurrenceId')}.json`) }
  private cursorPath(id: RoutineId, revision: number): string { return join(this.rootPath, 'cursors', `${assertId(id, 'routineId')}-${assertRevision(revision)}.json`) }
  private cutoverPath(id: RoutineId, revision: number): string { return join(this.rootPath, 'cutovers', `${assertId(id, 'routineId')}-${assertRevision(revision)}.json`) }
  private transitionPath(id: RoutineRunId, version: number): string { return join(this.rootPath, 'transitions', `${assertId(id, 'runId')}-${version}.json`) }
}

function assertTransition(current: RoutineRunState, next: RoutineRunState): void {
  const allowed: Record<RoutineRunState['kind'], readonly RoutineRunState['kind'][]> = {
    queued: ['claimed', 'cancelled'], claimed: ['running', 'queued', 'uncertain', 'cancelled'], running: ['queued', 'awaiting-approval', 'succeeded', 'failed', 'uncertain', 'cancelled'], 'awaiting-approval': ['running', 'failed', 'cancelled', 'uncertain'], succeeded: [], failed: [], cancelled: [], uncertain: ['reconciled'], reconciled: [],
  }
  if (!allowed[current.kind].includes(next.kind)) throw new Error(`Invalid routine run transition: ${current.kind} -> ${next.kind}`)
}
