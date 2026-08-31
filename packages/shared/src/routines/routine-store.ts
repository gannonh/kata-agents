import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readdirSync, renameSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
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
import { assertDurableLock, assertRegularFile, ensureDurableDirectory, withDurableLock } from '../spawn-tasks/durable-fs.ts'
import { isPotentiallyCatastrophicRegex } from '../automations/regex-safety.ts'
import { readJsonFile, removePointer, writeJsonIfAbsent, writeJsonRecord } from '../conversations/durable-json.ts'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/
const MAX_TEXT_BYTES = 256 * 1024
const CURSOR_LEASE_MS = 5_000

type Clock = () => string

type RoutineClaim = {
  readonly occurrenceId: TriggerOccurrenceId
  readonly workerId: string
  readonly claimToken: string
  readonly leaseUntil: string
}

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

export interface RoutineRecoveryError {
  readonly path: string
  readonly message: string
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
function isDurableLockBusy(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Durable lock is busy:')
}
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
function assertRoutine(value: unknown, workspaceId: string, expectedRoutineId?: string): RoutineRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Routine record is corrupt')
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== ROUTINE_SCHEMA_VERSION || record.workspaceId !== workspaceId || (expectedRoutineId !== undefined && record.routineId !== expectedRoutineId)) throw new Error('Routine ownership or schema mismatch')
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
  if (record.workspaceId !== workspaceId) throw new Error('Routine occurrence workspace mismatch')
  const occurrence = {
    schemaVersion: ROUTINE_SCHEMA_VERSION,
    workspaceId,
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
function assertClaim(value: unknown, expectedOccurrenceId?: string): RoutineClaim {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Routine occurrence claim is corrupt')
  const claim = value as Record<string, unknown>
  const occurrenceId = assertId(claim.occurrenceId, 'claim.occurrenceId') as TriggerOccurrenceId
  if (expectedOccurrenceId !== undefined && occurrenceId !== expectedOccurrenceId) throw new Error('Routine occurrence claim identity mismatch')
  return {
    occurrenceId,
    workerId: assertText(claim.workerId, 'claim.workerId'),
    claimToken: assertText(claim.claimToken, 'claim.claimToken'),
    leaseUntil: assertTimestamp(claim.leaseUntil, 'claim.leaseUntil'),
  }
}
function assertRunState(value: unknown): RoutineRunState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Routine run state is corrupt')
  const state = value as Record<string, unknown>
  const kind = assertChoice(state.kind, 'state.kind', ['queued', 'claimed', 'running', 'awaiting-approval', 'succeeded', 'failed', 'cancelled', 'uncertain', 'reconciled'] as const)
  const at = assertTimestamp(state.at, 'state.at')
  if (kind === 'queued' || kind === 'running') return { kind, at }
  if (kind === 'claimed') return { kind, at, workerId: assertText(state.workerId, 'state.workerId'), claimToken: assertText(state.claimToken, 'state.claimToken'), leaseUntil: assertTimestamp(state.leaseUntil, 'state.leaseUntil') }
  if (kind === 'awaiting-approval') return { kind, at, approvalId: assertId(state.approvalId, 'state.approvalId'), operationHash: assertText(state.operationHash, 'state.operationHash'), version: assertRevision(state.version, 'state.version') }
  if (kind === 'succeeded' || kind === 'reconciled') return { kind, at, result: assertText(state.result, 'state.result') }
  return { kind, at, ...(kind === 'failed' ? { error: assertText(state.error, 'state.error') } : { reason: assertText(state.reason, 'state.reason') }) } as RoutineRunState
}
function assertRun(value: unknown, workspaceId: string): RoutineRun {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Routine run is corrupt')
  const record = value as Record<string, unknown>
  if (record.workspaceId !== workspaceId) throw new Error('Routine run workspace mismatch')
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
  const parsedState = assertRunState(record.state)
  return {
    schemaVersion: ROUTINE_SCHEMA_VERSION,
    workspaceId,
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

function assertCutoverMarker(value: unknown, workspaceId: string): { routineId: RoutineId; previousRevision: number; nextRevision: number; nextName: string; state: 'pending' | 'complete'; createdAt: string; completedAt?: string; revision: RoutineRevision; record?: RoutineRecord } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Routine cutover marker is corrupt')
  const marker = value as Record<string, unknown>
  if (marker.schemaVersion !== ROUTINE_SCHEMA_VERSION) throw new Error('Routine cutover marker schema mismatch')
  const routineId = assertId(marker.routineId, 'routineId') as RoutineId
  const previousRevision = marker.previousRevision === 0 ? 0 : assertRevision(marker.previousRevision, 'previousRevision')
  const nextRevision = assertRevision(marker.nextRevision, 'nextRevision')
  if ((previousRevision === 0 && nextRevision !== 1) || (previousRevision > 0 && nextRevision !== previousRevision + 1)) throw new Error('Routine cutover marker revision sequence is corrupt')
  const nextName = assertText(marker.nextName, 'nextName')
  const state = assertChoice(marker.state, 'state', ['pending', 'complete'] as const)
  const createdAt = assertTimestamp(marker.createdAt, 'createdAt')
  const revision = assertRevisionRecord(marker.revision, workspaceId, routineId)
  if (revision.revision !== nextRevision) throw new Error('Routine cutover marker revision mismatch')
  const record = previousRevision === 0 ? assertRoutine(marker.record, workspaceId, routineId) : undefined
  if (record && (record.activeRevision !== nextRevision || record.name !== nextName)) throw new Error('Routine creation marker mismatch')
  const completedAt = marker.completedAt === undefined ? undefined : assertTimestamp(marker.completedAt, 'completedAt')
  if (state === 'pending' && completedAt !== undefined) throw new Error('Pending routine cutover marker is complete')
  if (state === 'complete' && completedAt === undefined) throw new Error('Completed routine cutover marker has no completion time')
  return { routineId, previousRevision, nextRevision, nextName, state, createdAt, ...(completedAt ? { completedAt } : {}), revision, ...(record ? { record } : {}) }
}

function parseTransitionMarker(value: unknown, runId: string, expectedVersion: number): { next: RoutineRunState; attempt: number; claim?: RoutineClaim } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Routine transition marker is corrupt')
  const marker = value as Record<string, unknown>
  if (marker.runId !== runId || marker.expectedVersion !== expectedVersion || typeof marker.token !== 'string' || !marker.token || !/^transition-[A-Za-z0-9_-]+$/.test(marker.token)) throw new Error('Routine transition marker identity mismatch')
  if (!Number.isSafeInteger(marker.attempt) || (marker.attempt as number) < 1) throw new Error('Routine transition marker attempt is corrupt')
  const next = assertRunState(marker.next)
  return { next, attempt: marker.attempt as number, ...(marker.claim === undefined ? {} : { claim: assertClaim(marker.claim) }) }
}

type CutoverMarkerIdentity = { routineId: RoutineId }
function cutoverMarkerIdentity(file: string): CutoverMarkerIdentity | null {
  const match = /^(.+)-[1-9][0-9]*\.json$/.exec(file)
  const routineId = match?.[1]
  return routineId && SAFE_ID.test(routineId) ? { routineId: routineId as RoutineId } : null
}
function cutoverMarkerIdentityFromRaw(raw: unknown): CutoverMarkerIdentity | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const routineId = (raw as Record<string, unknown>).routineId
  return typeof routineId === 'string' && SAFE_ID.test(routineId) ? { routineId: routineId as RoutineId } : null
}

type TransitionMarkerIdentity = { runId: RoutineRunId; expectedVersion: number }
function transitionMarkerIdentity(file: string): TransitionMarkerIdentity | null {
  const match = /^(.+)-([1-9][0-9]*)\.json$/.exec(file)
  const runId = match?.[1]
  const version = match?.[2]
  if (!runId || !version || !SAFE_ID.test(runId)) return null
  const expectedVersion = Number(version)
  return Number.isSafeInteger(expectedVersion) ? { runId: runId as RoutineRunId, expectedVersion } : null
}
function transitionMarkerIdentityFromRaw(raw: unknown): TransitionMarkerIdentity | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const marker = raw as Record<string, unknown>
  if (typeof marker.runId !== 'string' || !SAFE_ID.test(marker.runId) || !Number.isSafeInteger(marker.expectedVersion) || (marker.expectedVersion as number) < 1) return null
  return { runId: marker.runId as RoutineRunId, expectedVersion: marker.expectedVersion as number }
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
  private readonly routineLockTokens = new Map<string, string>()
  private readonly recoveryErrors: RoutineRecoveryError[] = []

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
    return this.withRoutineLock(routineId, (lockToken) => {
      if (this.get(routineId) || existsSync(this.revisionPath(routineId, 1)) || existsSync(this.activePath(routineId)) || existsSync(this.cutoverPath(routineId, 1))) throw new Error(`Routine already exists: ${routineId}`)
      const now = this.clock()
      const revision = this.buildRevision(routineId, 1, input, now)
      const record: RoutineRecord = { schemaVersion: ROUTINE_SCHEMA_VERSION, routineId, workspaceId: this.workspaceId, ownerBotId: assertId(input.ownerBotId, 'ownerBotId'), name: assertText(input.name, 'name'), lifecycle: 'enabled', activeRevision: 1, createdAt: now, updatedAt: now }
      const cutoverPath = this.cutoverPath(routineId, 1)
      const pending = { schemaVersion: ROUTINE_SCHEMA_VERSION, routineId, previousRevision: 0, nextRevision: 1, nextName: record.name, state: 'pending', createdAt: now, revision, record }
      assertDurableLock(this.routineLockPath(routineId), lockToken)
      if (!writeJsonIfAbsent(cutoverPath, pending)) throw new Error(`Routine creation already exists: ${routineId}`)
      assertDurableLock(this.routineLockPath(routineId), lockToken)
      if (!writeJsonIfAbsent(this.revisionPath(routineId, 1), revision)) throw new Error(`Routine revision already exists: ${routineId}@1`)
      assertDurableLock(this.routineLockPath(routineId), lockToken)
      writeJsonRecord(this.activePath(routineId), revision)
      assertDurableLock(this.routineLockPath(routineId), lockToken)
      writeJsonRecord(this.recordPath(routineId), record)
      this.records.set(routineId, record)
      assertDurableLock(this.routineLockPath(routineId), lockToken)
      writeJsonRecord(cutoverPath, { ...pending, state: 'complete', completedAt: this.clock() })
      return clone(record)
    })
  }

  get(routineId: RoutineId): RoutineRecord | null {
    const id = assertId(routineId, 'routineId') as RoutineId
    try {
      return this.withRoutineLock(id, (lockToken) => {
        const path = this.recordPath(id)
        const activePath = this.activePath(id)
        if (!existsSync(path)) {
          this.records.delete(id)
          return null
        }
        let artifactPath = path
        try {
          assertDurableLock(this.routineLockPath(id), lockToken)
          const record = this.readRoutineRecord(id, lockToken)
          if (!record) return null
          artifactPath = activePath
          this.assertActiveRevision(record, lockToken)
          assertDurableLock(this.routineLockPath(id), lockToken)
          this.records.set(id, record)
          return clone(record)
        } catch (error) {
          this.records.delete(id)
          assertDurableLock(this.routineLockPath(id), lockToken)
          this.quarantine(artifactPath, error)
          return null
        }
      })
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Durable lock is busy:')) return clone(this.records.get(id) ?? null)
      throw error
    }
  }
  list(filter?: { ownerBotId?: string; lifecycle?: RoutineLifecycle }): RoutineRecord[] {
    this.reload()
    return [...this.records.values()].filter(record => (!filter?.ownerBotId || record.ownerBotId === filter.ownerBotId) && (!filter?.lifecycle || record.lifecycle === filter.lifecycle)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(clone)
  }
  getRevision(routineId: RoutineId, revision: number): RoutineRevision {
    const id = assertId(routineId, 'routineId')
    this.require(id)
    return clone(this.readRevisionFile(id, assertRevision(revision)))
  }
  getActiveRevision(routineId: RoutineId): RoutineRevision { const record = this.require(routineId); return this.getRevision(record.routineId, record.activeRevision) }
  getPublic(routineId: RoutineId): RoutinePublicDto { const record = this.require(routineId); return toRoutinePublicDto(record, this.getRevision(record.routineId, record.activeRevision)) }

  update(routineId: RoutineId, input: UpdateRoutineInput): RoutineRecord {
    const id = assertId(routineId, 'routineId') as RoutineId
    this.recover()
    return this.withRoutineLock(id, (lockToken) => {
      const current = this.require(id)
      if (current.lifecycle === 'deleted') throw new Error('Cannot update a deleted routine')
      const previous = this.getActiveRevision(current.routineId)
      const nextRevision = current.activeRevision + 1
      const now = this.clock()
      const name = assertText(input.name ?? current.name, 'name')
      const revision = this.buildRevision(current.routineId, nextRevision, {
        ownerBotId: current.ownerBotId,
        name,
        trigger: input.trigger ?? previous.trigger,
        input: input.input ?? previous.input,
        expectedResult: input.expectedResult ?? previous.expectedResult,
        approvalBoundary: input.approvalBoundary ?? previous.approvalBoundary,
        failurePolicy: input.failurePolicy ?? previous.failurePolicy,
        destination: input.destination ?? previous.destination,
      }, now)
      const revisionPath = this.revisionPath(current.routineId, nextRevision)
      const cutoverPath = this.cutoverPath(current.routineId, nextRevision)
      if (existsSync(revisionPath) || existsSync(cutoverPath)) throw new Error(`Routine revision has an incomplete cutover: ${current.routineId}@${nextRevision}`)
      const pending = { schemaVersion: ROUTINE_SCHEMA_VERSION, routineId: current.routineId, previousRevision: current.activeRevision, nextRevision, nextName: name, state: 'pending', createdAt: now, revision }
      assertDurableLock(this.routineLockPath(id), lockToken)
      if (!writeJsonIfAbsent(cutoverPath, pending)) throw new Error(`Routine revision cutover already exists: ${current.routineId}@${nextRevision}`)
      assertDurableLock(this.routineLockPath(id), lockToken)
      if (!writeJsonIfAbsent(revisionPath, revision)) throw new Error(`Routine revision already exists: ${current.routineId}@${nextRevision}`)
      const active = this.readRevisionFile(current.routineId, nextRevision)
      assertDurableLock(this.routineLockPath(id), lockToken)
      writeJsonRecord(this.activePath(current.routineId), active)
      const next: RoutineRecord = { ...current, name, activeRevision: nextRevision, updatedAt: now }
      assertDurableLock(this.routineLockPath(id), lockToken)
      writeJsonRecord(this.recordPath(current.routineId), next)
      assertDurableLock(this.routineLockPath(id), lockToken)
      writeJsonRecord(cutoverPath, { ...pending, state: 'complete', completedAt: this.clock() })
      this.records.set(current.routineId, next)
      return clone(next)
    })
  }
  enable(routineId: RoutineId): RoutineRecord { return this.setLifecycle(routineId, 'enabled') }
  pause(routineId: RoutineId): RoutineRecord { return this.setLifecycle(routineId, 'paused') }
  delete(routineId: RoutineId): RoutineRecord { return this.setLifecycle(routineId, 'deleted') }
  private setLifecycle(routineId: RoutineId, lifecycle: RoutineLifecycle): RoutineRecord {
    const id = assertId(routineId, 'routineId') as RoutineId
    return this.withRoutineLock(id, (lockToken) => {
      const current = this.require(id)
      if (current.lifecycle === 'deleted' && lifecycle !== 'deleted') throw new Error('Deleted routines cannot be re-enabled')
      const next = { ...current, lifecycle, updatedAt: this.clock() }
      assertDurableLock(this.routineLockPath(id), lockToken)
      writeJsonRecord(this.recordPath(current.routineId), next)
      this.records.set(current.routineId, next)
      return clone(next)
    })
  }

  recordOccurrence(input: RecordOccurrenceInput): RoutineOccurrence {
    const routineId = assertId(input.routineId, 'routineId') as RoutineId
    return this.withRoutineLock(routineId, (routineLockToken) => {
      const routine = this.require(routineId)
      if (routine.lifecycle !== 'enabled') throw new Error(`Routine is not enabled: ${routine.routineId}`)
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
      const occurrence: RoutineOccurrence = { schemaVersion: ROUTINE_SCHEMA_VERSION, workspaceId: this.workspaceId, occurrenceId: assertId(occurrenceId, 'occurrenceId') as TriggerOccurrenceId, routineId: routine.routineId, routineRevision: input.routineRevision, source, ...(scheduledInstant ? { scheduledInstant } : { externalEventId }), createdAt }
      const path = this.occurrencePath(occurrence.occurrenceId)
      assertDurableLock(this.routineLockPath(routineId), routineLockToken)
      return withDurableLock(`${path}.lock`, (lockToken) => {
        assertDurableLock(this.routineLockPath(routineId), routineLockToken)
        assertDurableLock(`${path}.lock`, lockToken)
        if (!writeJsonIfAbsent(path, occurrence)) {
          let existing: RoutineOccurrence
          try {
            existing = this.readOccurrence(occurrence.occurrenceId)
          } catch (error) {
            assertDurableLock(this.routineLockPath(routineId), routineLockToken)
            assertDurableLock(`${path}.lock`, lockToken)
            this.quarantine(path, error)
            assertDurableLock(this.routineLockPath(routineId), routineLockToken)
            assertDurableLock(`${path}.lock`, lockToken)
            if (!writeJsonIfAbsent(path, occurrence)) return this.readOccurrence(occurrence.occurrenceId)
            return clone(occurrence)
          }
          if (existing.routineId !== occurrence.routineId || existing.routineRevision !== occurrence.routineRevision || existing.source !== occurrence.source || existing.scheduledInstant !== occurrence.scheduledInstant || existing.externalEventId !== occurrence.externalEventId) throw new Error('Occurrence identity collision')
          return existing
        }
        assertDurableLock(this.routineLockPath(routineId), routineLockToken)
        assertDurableLock(`${path}.lock`, lockToken)
        return clone(occurrence)
      })
    })
  }

  claimOccurrence(input: ClaimOccurrenceInput & { readonly claimToken?: string }): RoutineOccurrence | null {
    const occurrenceId = input.occurrenceId
    const workerId = assertText(input.workerId, 'workerId')
    const expectedClaimToken = input.claimToken === undefined ? undefined : assertText(input.claimToken, 'claimToken')
    const leaseMs = input.leaseMs ?? 120_000
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new TypeError('leaseMs must be positive')
    const routineId = this.readOccurrence(occurrenceId).routineId
    return this.withRoutineLock(routineId, (routineLockToken) => {
      const routine = this.require(routineId)
      if (routine.lifecycle !== 'enabled') throw new Error(`Routine is not enabled: ${routine.routineId}`)
      return withDurableLock(this.occurrenceLockPath(occurrenceId), (lockToken) => {
        assertDurableLock(this.routineLockPath(routineId), routineLockToken)
      let occurrence: RoutineOccurrence
      try {
        occurrence = this.readOccurrence(occurrenceId)
      } catch (error) {
        const path = this.occurrencePath(occurrenceId)
        if (existsSync(path)) this.quarantine(path, error)
        return null
      }
      const now = this.clock()
      const claimPath = this.claimPath(occurrence.occurrenceId)
      let existing: RoutineClaim | null
      try {
        if (existsSync(claimPath)) assertRegularFile(claimPath, 'Routine occurrence claim')
        existing = existsSync(claimPath) ? assertClaim(readJsonFile(claimPath), occurrence.occurrenceId) : null
      } catch (error) {
        if (existsSync(claimPath)) this.quarantine(claimPath, error)
        existing = null
      }
      if (occurrence.leaseUntil && Date.parse(occurrence.leaseUntil) > Date.parse(now)) {
        const claimMatches = !!existing
          && existing.workerId === occurrence.workerId
          && existing.claimToken === occurrence.claimToken
          && existing.leaseUntil === occurrence.leaseUntil
          && (expectedClaimToken === undefined || existing.claimToken === expectedClaimToken)
        if (!claimMatches && occurrence.workerId && occurrence.claimToken) {
          const repaired: RoutineClaim = { occurrenceId: occurrence.occurrenceId, workerId: occurrence.workerId, claimToken: occurrence.claimToken, leaseUntil: occurrence.leaseUntil }
          assertDurableLock(this.occurrenceLockPath(occurrenceId), lockToken)
          writeJsonRecord(claimPath, repaired)
        }
        return occurrence.workerId === workerId && (expectedClaimToken === undefined || occurrence.claimToken === expectedClaimToken) ? clone(occurrence) : null
      }
      if (existing && Date.parse(existing.leaseUntil) > Date.parse(now)) {
        if (!occurrence.leaseUntil && !occurrence.workerId && !occurrence.claimToken) {
          assertDurableLock(this.occurrenceLockPath(occurrenceId), lockToken)
          removePointer(claimPath)
          existing = null
        } else return null
      }
      const leaseUntil = new Date(Date.parse(now) + leaseMs).toISOString()
      const claimToken = `claim_${this.randomId()}`
      const claim: RoutineClaim = { occurrenceId: occurrence.occurrenceId, workerId, claimToken, leaseUntil }
      assertDurableLock(this.occurrenceLockPath(occurrenceId), lockToken)
      writeJsonRecord(claimPath, claim)
      assertDurableLock(this.occurrenceLockPath(occurrenceId), lockToken)
      const claimed: RoutineOccurrence = { ...occurrence, claimedAt: now, leaseUntil, workerId, claimToken }
      writeJsonRecord(this.occurrencePath(occurrence.occurrenceId), claimed)
      assertDurableLock(this.occurrenceLockPath(occurrenceId), lockToken)
      return clone(claimed)
      })
    })
  }

  createRun(input: CreateRoutineRunInput): RoutineRun {
    const occurrenceId = assertId(input.occurrenceId, 'occurrenceId') as TriggerOccurrenceId
    const runId = deriveRoutineRunId(occurrenceId)
    const routineId = this.readOccurrence(occurrenceId).routineId
    return this.withRoutineLock(routineId, (routineLockToken) => withDurableLock(this.runLockPath(runId), (lockToken) => {
      const occurrence = this.readOccurrence(occurrenceId)
      const routine = this.require(occurrence.routineId)
      const revision = this.getRevision(routine.routineId, occurrence.routineRevision)
      const inputOwnerBotId = assertId(input.ownerBotId, 'ownerBotId')
      if (inputOwnerBotId !== routine.ownerBotId) throw new Error('Routine run owner mismatch')
      const origin = input.origin ?? { kind: 'triggered' as const, occurrenceId }
      if (origin.kind !== 'triggered' && origin.kind !== 'replay') throw new TypeError('Routine run origin is invalid')
      const normalizedOrigin = origin.kind === 'triggered'
        ? { kind: 'triggered' as const, occurrenceId: assertId(origin.occurrenceId, 'origin.occurrenceId') as TriggerOccurrenceId }
        : { kind: 'replay' as const, occurrenceId: assertId(origin.occurrenceId, 'origin.occurrenceId') as TriggerOccurrenceId, replayOfRunId: assertId(origin.replayOfRunId, 'origin.replayOfRunId') as RoutineRunId }
      if (normalizedOrigin.occurrenceId !== occurrenceId) throw new Error('Routine run origin occurrence mismatch')
      const now = this.clock()
      const run: RoutineRun = {
        schemaVersion: ROUTINE_SCHEMA_VERSION,
        workspaceId: this.workspaceId,
        runId,
        routineId: routine.routineId,
        routineRevision: occurrence.routineRevision,
        ownerBotId: inputOwnerBotId,
        origin: normalizedOrigin,
        destination: input.destination ? assertDestination(input.destination) : revision.destination,
        input: assertText(input.input ?? revision.input, 'input'),
        state: { kind: 'queued', at: now },
        attempt: 1,
        version: 1,
        createdAt: now,
        updatedAt: now,
      }
      const runPath = this.runPath(runId)
      if (routine.lifecycle !== 'enabled' && existsSync(runPath)) {
        const existing = this.readRun(runId)
        if (existing.routineId !== run.routineId || existing.routineRevision !== run.routineRevision || existing.ownerBotId !== run.ownerBotId || !isDeepStrictEqual(existing.origin, run.origin)) throw new Error('Routine run identity collision')
        assertDurableLock(this.routineLockPath(routine.routineId), routineLockToken)
        assertDurableLock(this.runLockPath(runId), lockToken)
        this.ensureOccurrenceRunPointer(occurrence.occurrenceId, runId)
        return clone(existing)
      }
      if (routine.lifecycle !== 'enabled') throw new Error(`Routine is not enabled: ${routine.routineId}`)
      assertDurableLock(this.routineLockPath(routine.routineId), routineLockToken)
      assertDurableLock(this.runLockPath(runId), lockToken)
      if (!writeJsonIfAbsent(runPath, run)) {
        let existing: RoutineRun
        try {
          existing = this.readRun(runId)
        } catch (error) {
          assertDurableLock(this.runLockPath(runId), lockToken)
          this.quarantine(runPath, error)
          assertDurableLock(this.runLockPath(runId), lockToken)
          if (!writeJsonIfAbsent(runPath, run)) existing = this.readRun(runId)
          else existing = run
        }
        if (existing.routineId !== run.routineId || existing.routineRevision !== run.routineRevision || existing.ownerBotId !== run.ownerBotId || !isDeepStrictEqual(existing.origin, run.origin)) throw new Error('Routine run identity collision')
        this.ensureOccurrenceRunPointer(occurrence.occurrenceId, runId)
        return clone(existing)
      }
      assertDurableLock(this.runLockPath(runId), lockToken)
      this.ensureOccurrenceRunPointer(occurrence.occurrenceId, runId)
      return clone(run)
    }))
  }

  repairOccurrenceRunPointer(occurrenceId: TriggerOccurrenceId, runId: RoutineRunId): void {
    const id = assertId(occurrenceId, 'occurrenceId') as TriggerOccurrenceId
    const derivedRunId = deriveRoutineRunId(id)
    if (derivedRunId !== runId) throw new Error('Occurrence run identity mismatch')
    const occurrence = this.readOccurrence(id)
    this.withRoutineLock(occurrence.routineId, (routineLockToken) => withDurableLock(this.runLockPath(runId), (runLockToken) => {
      const currentOccurrence = this.readOccurrence(id)
      const run = this.readRun(runId)
      if (run.origin.occurrenceId !== currentOccurrence.occurrenceId || run.routineId !== currentOccurrence.routineId || run.routineRevision !== currentOccurrence.routineRevision) throw new Error('Occurrence run identity mismatch')
      assertDurableLock(this.routineLockPath(currentOccurrence.routineId), routineLockToken)
      assertDurableLock(this.runLockPath(runId), runLockToken)
      this.ensureOccurrenceRunPointer(id, runId)
    }))
  }

  getOccurrence(occurrenceId: TriggerOccurrenceId): RoutineOccurrence | null {
    const id = assertId(occurrenceId, 'occurrenceId') as TriggerOccurrenceId
    const path = this.occurrencePath(id)
    if (!existsSync(path)) return null
    try {
      return this.readOccurrence(id)
    } catch {
      let structural: RoutineOccurrence | null
      try {
        structural = withDurableLock(this.occurrenceLockPath(id), (lockToken) => {
          if (!existsSync(path)) return null
          try {
            return this.readOccurrenceFile(id)
          } catch (error) {
            assertDurableLock(this.occurrenceLockPath(id), lockToken)
            this.quarantine(path, error)
            return null
          }
        })
      } catch (error) {
        if (isDurableLockBusy(error)) return null
        throw error
      }
      if (!structural) return null
      try {
        return this.withRoutineLock(structural.routineId, (routineLockToken) => withDurableLock(this.occurrenceLockPath(id), (occurrenceLockToken) => {
          if (!existsSync(path)) return null
          try {
            return this.readOccurrence(id)
          } catch (error) {
            if (isDurableLockBusy(error)) return null
            assertDurableLock(this.routineLockPath(structural.routineId), routineLockToken)
            assertDurableLock(this.occurrenceLockPath(id), occurrenceLockToken)
            this.quarantine(path, error)
            return null
          }
        }))
      } catch (error) {
        if (isDurableLockBusy(error)) return null
        throw error
      }
    }
  }
  getRun(runId: RoutineRunId): RoutineRun | null {
    const id = assertId(runId, 'runId') as RoutineRunId
    const path = this.runPath(id)
    if (!existsSync(path)) return null
    try {
      return this.readRun(id)
    } catch {
      let structural: RoutineRun | null
      try {
        structural = withDurableLock(this.runLockPath(id), (lockToken) => {
          if (!existsSync(path)) return null
          try {
            return this.readRunFile(id)
          } catch (error) {
            assertDurableLock(this.runLockPath(id), lockToken)
            this.quarantine(path, error)
            return null
          }
        })
      } catch (error) {
        if (isDurableLockBusy(error)) return null
        throw error
      }
      if (!structural) return null
      try {
        return this.withRoutineLock(structural.routineId, (routineLockToken) => withDurableLock(this.runLockPath(id), (runLockToken) => {
          if (!existsSync(path)) return null
          try {
            return this.readRun(id)
          } catch (error) {
            if (isDurableLockBusy(error)) return null
            assertDurableLock(this.routineLockPath(structural.routineId), routineLockToken)
            assertDurableLock(this.runLockPath(id), runLockToken)
            this.quarantine(path, error)
            return null
          }
        }))
      } catch (error) {
        if (isDurableLockBusy(error)) return null
        throw error
      }
    }
  }
  listAllRuns(): RoutineRun[] {
    const directory = join(this.rootPath, 'runs')
    if (!existsSync(directory)) return []
    const runs: RoutineRun[] = []
    for (const file of readdirSync(directory).filter(file => file.endsWith('.json'))) {
      const path = join(directory, file)
      try {
        const runId = assertId(file.slice(0, -5), 'runId') as RoutineRunId
        const run = this.getRun(runId)
        if (run) runs.push(run)
      } catch (error) {
        if (isDurableLockBusy(error)) continue
        if (existsSync(path)) this.quarantine(path, error)
      }
    }
    return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(clone)
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

  transitionRun(runId: RoutineRunId, expectedVersion: number, next: RoutineRunState, options?: { attempt?: number; claim?: RoutineClaim }): RoutineRun {
    return withDurableLock(this.transitionLockPath(runId), (transitionLockToken) => {
      const current = this.readRun(runId)
      if (current.version !== expectedVersion) throw new Error(`Routine run version conflict: expected ${expectedVersion}, current ${current.version}`)
      const nextState = assertRunState(next)
      assertTransition(current.state, nextState)
      const claim = options?.claim
      const requiresClaim = transitionRequiresClaim(current.state, nextState)
      if (requiresClaim && !claim) throw new Error('Routine run claim is required')
      if (claim && claim.occurrenceId !== current.origin.occurrenceId) throw new Error('Routine run claim occurrence mismatch')
      if (claim) assertClaimMatchesState(nextState, claim)
      if (requiresClaim) {
        return this.withRoutineLock(current.routineId, (routineLockToken) => {
          const routine = this.get(current.routineId)
          if (!routine || routine.lifecycle !== 'enabled') throw new Error(`Routine is not enabled: ${current.routineId}`)
          assertDurableLock(this.routineLockPath(current.routineId), routineLockToken)
          return this.transitionRunWithClaim(current, expectedVersion, nextState, claim!, options?.attempt, transitionLockToken)
        })
      }
      const attempt = options?.attempt ?? current.attempt
      if (!Number.isSafeInteger(attempt) || attempt < 1) throw new TypeError('attempt must be a positive safe integer')
      if (!claim) return this.transitionRunLocked(current, expectedVersion, nextState, attempt, transitionLockToken)
      return withDurableLock(this.occurrenceLockPath(claim.occurrenceId), (occurrenceLockToken) => {
        this.assertOccurrenceClaim(claim.occurrenceId, claim)
        return this.transitionRunLocked(current, expectedVersion, nextState, attempt, transitionLockToken, occurrenceLockToken, claim)
      })
    })
  }

  transitionRunWithLifecycle(runId: RoutineRunId, expectedVersion: number, next: RoutineRunState): RoutineRun {
    const initial = this.readRun(runId)
    return withDurableLock(this.transitionLockPath(runId), (transitionLockToken) => this.withRoutineLock(initial.routineId, (routineLockToken) => {
      const current = this.readRun(runId)
      if (current.version !== expectedVersion) throw new Error(`Routine run version conflict: expected ${expectedVersion}, current ${current.version}`)
      const routine = this.get(current.routineId)
      const nextState = routine?.lifecycle === 'enabled'
        ? next
        : { kind: 'cancelled' as const, at: this.clock(), reason: routine?.lifecycle === 'deleted' ? 'routine-deleted' : 'routine-paused' }
      const validatedState = assertRunState(nextState)
      assertTransition(current.state, validatedState)
      if (transitionRequiresClaim(current.state, validatedState)) throw new Error('Routine run claim is required')
      assertDurableLock(this.routineLockPath(initial.routineId), routineLockToken)
      return this.transitionRunLocked(current, expectedVersion, validatedState, current.attempt, transitionLockToken)
    }))
  }

  transitionRunAfterExecution(runId: RoutineRunId, expectedVersion: number, next: RoutineRunState, attempt?: number): RoutineRun {
    const initial = this.readRun(runId)
    return withDurableLock(this.transitionLockPath(runId), (transitionLockToken) => this.withRoutineLock(initial.routineId, (routineLockToken) => {
      const current = this.readRun(runId)
      if (current.version !== expectedVersion) throw new Error(`Routine run version conflict: expected ${expectedVersion}, current ${current.version}`)
      if (current.state.kind !== 'running') throw new Error(`Routine run is not running: ${runId}`)
      const routine = this.get(current.routineId)
      const nextState = routine?.lifecycle === 'enabled'
        ? next
        : { kind: 'cancelled' as const, at: this.clock(), reason: routine?.lifecycle === 'deleted' ? 'routine-deleted' : 'routine-paused' }
      const validatedState = assertRunState(nextState)
      assertTransition(current.state, validatedState)
      const nextAttempt = attempt ?? current.attempt
      if (!Number.isSafeInteger(nextAttempt) || nextAttempt < 1) throw new TypeError('attempt must be a positive safe integer')
      assertDurableLock(this.routineLockPath(initial.routineId), routineLockToken)
      return this.transitionRunLocked(current, expectedVersion, validatedState, nextAttempt, transitionLockToken)
    }))
  }

  private transitionRunWithClaim(current: RoutineRun, expectedVersion: number, nextState: RoutineRunState, claim: RoutineClaim, requestedAttempt: number | undefined, transitionLockToken: string): RoutineRun {
    const attempt = requestedAttempt ?? current.attempt
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new TypeError('attempt must be a positive safe integer')
    return withDurableLock(this.occurrenceLockPath(claim.occurrenceId), (occurrenceLockToken) => {
      this.assertOccurrenceClaim(claim.occurrenceId, claim)
      return this.transitionRunLocked(current, expectedVersion, nextState, attempt, transitionLockToken, occurrenceLockToken, claim)
    })
  }

  private transitionRunLocked(current: RoutineRun, expectedVersion: number, nextState: RoutineRunState, attempt: number, transitionLockToken: string, occurrenceLockToken?: string, claim?: RoutineClaim): RoutineRun {
    if (claim) {
      if (!occurrenceLockToken) throw new Error('Routine occurrence lock is required')
      assertClaimMatchesState(nextState, claim)
      this.assertOccurrenceClaim(claim.occurrenceId, claim)
    }
    const path = this.transitionPath(current.runId, expectedVersion)
    let existing: { next: RoutineRunState; attempt: number; claim?: RoutineClaim } | null = null
    try {
      if (existsSync(path)) assertRegularFile(path, 'Routine transition marker')
      const raw = readJsonFile(path)
      existing = raw === null ? null : parseTransitionMarker(raw, current.runId, expectedVersion)
    } catch (error) {
      if (existsSync(path)) {
        assertDurableLock(this.transitionLockPath(current.runId), transitionLockToken)
        this.quarantine(path, error)
      }
    }
    if (existing) {
      if (existing.attempt !== attempt || JSON.stringify(existing.next) !== JSON.stringify(nextState) || !isDeepStrictEqual(existing.claim, claim)) throw new Error('Routine run transition conflict')
    } else {
      const marker = { runId: current.runId, expectedVersion, next: nextState, attempt, ...(claim ? { claim } : {}), token: `transition-${randomUUID()}` }
      assertDurableLock(this.transitionLockPath(current.runId), transitionLockToken)
      if (!writeJsonIfAbsent(path, marker)) throw new Error('Routine run transition conflict')
    }
    if (claim) this.assertOccurrenceClaim(claim.occurrenceId, claim)
    const updated: RoutineRun = { ...current, state: clone(nextState), attempt, version: current.version + 1, updatedAt: this.clock() }
    assertDurableLock(this.transitionLockPath(current.runId), transitionLockToken)
    const latest = this.readRun(current.runId)
    if (latest.version !== expectedVersion) throw new Error(`Routine run version conflict: expected ${expectedVersion}, current ${latest.version}`)
    if (claim) this.assertOccurrenceClaim(claim.occurrenceId, claim)
    assertDurableLock(this.transitionLockPath(current.runId), transitionLockToken)
    writeJsonRecord(this.runPath(current.runId), updated)
    assertDurableLock(this.transitionLockPath(current.runId), transitionLockToken)
    const committed = this.readRun(current.runId)
    if (committed.version !== expectedVersion + 1 || JSON.stringify(committed.state) !== JSON.stringify(nextState)) throw new Error('Routine run transition was not committed')
    assertDurableLock(this.transitionLockPath(current.runId), transitionLockToken)
    removePointer(path)
    return clone(committed)
  }

  retryRun(runId: RoutineRunId, expectedVersion: number): RoutineRun {
    const current = this.readRun(runId)
    if (current.state.kind !== 'running') throw new Error('Only running routine runs can be retried')
    return this.transitionRunAfterExecution(runId, expectedVersion, { kind: 'queued', at: this.clock() }, current.attempt + 1)
  }

  listRecoverableRuns(now = this.clock()): RoutineRun[] {
    return this.allRuns().filter(run => run.state.kind === 'queued' || run.state.kind === 'running' || run.state.kind === 'awaiting-approval' || (run.state.kind === 'claimed' && Date.parse(run.state.leaseUntil) <= Date.parse(now))).map(clone)
  }

  getScheduleCursor(routineId: RoutineId, revision: number): string | null {
    const id = assertId(routineId, 'routineId') as RoutineId
    const number = assertRevision(revision)
    const path = this.cursorPath(id, number)
    return withDurableLock(this.cursorLockPath(id, number), (lockToken) => {
      const current = this.readCursor(path, id, number, 'schedule cursor', lockToken)
      const pending = this.readCursor(`${path}.pending`, id, number, 'schedule cursor update', lockToken)
      if (!pending) return current
      return !current || Date.parse(pending) > Date.parse(current) ? pending : current
    })
  }
  advanceScheduleCursor(routineId: RoutineId, revision: number, cursor: string): string {
    const id = assertId(routineId, 'routineId') as RoutineId
    const number = assertRevision(revision)
    const next = assertTimestamp(cursor, 'schedule cursor')
    const path = this.cursorPath(id, number)
    const pendingPath = `${path}.pending`
    return withDurableLock(this.cursorLockPath(id, number), (lockToken) => {
      let current = this.readCursor(path, id, number, 'schedule cursor', lockToken)
      const pending = this.readCursor(pendingPath, id, number, 'schedule cursor update', lockToken)
      if (pending) {
        const committed = this.readCursor(path, id, number, 'schedule cursor', lockToken)
        current = !committed || Date.parse(pending) > Date.parse(committed) ? pending : committed
        if (!committed || Date.parse(current) > Date.parse(committed)) {
          assertDurableLock(this.cursorLockPath(id, number), lockToken)
          writeJsonRecord(path, { routineId: id, revision: number, cursor: current })
        }
        assertDurableLock(this.cursorLockPath(id, number), lockToken)
        removePointer(pendingPath)
      }
      if (current && Date.parse(next) < Date.parse(current)) throw new Error('Schedule cursor cannot move backwards')
      if (current && Date.parse(current) >= Date.parse(next)) return current
      const token = `cursor-${randomUUID()}`
      const now = this.clock()
      const leaseUntil = new Date(Date.parse(now) + CURSOR_LEASE_MS).toISOString()
      assertDurableLock(this.cursorLockPath(id, number), lockToken)
      writeJsonRecord(pendingPath, { routineId: id, revision: number, cursor: next, token, leaseUntil })
      assertDurableLock(this.cursorLockPath(id, number), lockToken)
      const committed = this.readCursor(path, id, number, 'schedule cursor', lockToken)
      const finalCursor = committed && Date.parse(committed) > Date.parse(next) ? committed : next
      assertDurableLock(this.cursorLockPath(id, number), lockToken)
      writeJsonRecord(path, { routineId: id, revision: number, cursor: finalCursor })
      assertDurableLock(this.cursorLockPath(id, number), lockToken)
      const marker = readJsonFile(pendingPath) as Record<string, unknown> | null
      if (marker?.token === token) {
        assertDurableLock(this.cursorLockPath(id, number), lockToken)
        removePointer(pendingPath)
      }
      return finalCursor
    })
  }

  recover(): RoutineRecoveryReport {
    const cutovers: string[] = []
    const transitions: string[] = []
    const cutoverDir = join(this.rootPath, 'cutovers')
    for (const file of readdirSync(cutoverDir).filter(name => name.endsWith('.json'))) {
      const path = join(cutoverDir, file)
      const filenameIdentity = cutoverMarkerIdentity(file)
      let raw: unknown = null
      let marker: ReturnType<typeof assertCutoverMarker> | undefined
      try {
        assertRegularFile(path, 'Routine cutover marker')
        raw = readJsonFile(path)
        marker = assertCutoverMarker(raw, this.workspaceId)
        if (file !== `${marker.routineId}-${marker.nextRevision}.json`) throw new Error('Routine cutover marker identity mismatch')
      } catch (error) {
        if (isDurableLockBusy(error)) continue
        const identity = filenameIdentity ?? cutoverMarkerIdentityFromRaw(raw)
        if (identity) this.quarantineCutoverMarker(path, raw, identity, error)
        else if (existsSync(path)) this.quarantine(path, error)
        continue
      }
      if (!marker || marker.state !== 'pending' || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const pendingMarker = marker
      const pendingRaw = raw as Record<string, unknown>
      try {
        const routineId = pendingMarker.routineId
        const nextRevision = pendingMarker.nextRevision
        this.withRoutineLock(routineId, (lockToken) => {
          const current = this.readRoutineRecord(routineId, lockToken)
          if (!current) {
            if (pendingMarker.previousRevision !== 0 || nextRevision !== 1) throw new Error(`Routine cutover has no predecessor: ${routineId}@${nextRevision}`)
            const revision = pendingMarker.revision
            if (revision.revision !== nextRevision) throw new Error(`Routine revision identity mismatch: ${routineId}@${nextRevision}`)
            const record = pendingMarker.record
            if (!record || record.activeRevision !== nextRevision || record.name !== pendingMarker.nextName) throw new Error(`Routine creation marker mismatch: ${routineId}`)
            assertDurableLock(this.routineLockPath(routineId), lockToken)
            if (!writeJsonIfAbsent(this.revisionPath(routineId, nextRevision), revision)) {
              if (!isDeepStrictEqual(this.readRevisionFile(routineId, nextRevision), revision)) throw new Error(`Routine revision collision: ${routineId}@${nextRevision}`)
            }
            assertDurableLock(this.routineLockPath(routineId), lockToken)
            writeJsonRecord(this.activePath(routineId), revision)
            assertDurableLock(this.routineLockPath(routineId), lockToken)
            writeJsonRecord(this.recordPath(routineId), record)
            this.records.set(routineId, record)
            assertDurableLock(this.routineLockPath(routineId), lockToken)
            writeJsonRecord(path, { ...pendingRaw, state: 'complete', completedAt: this.clock() })
            return
          }
          if (nextRevision <= current.activeRevision) {
            if (nextRevision === current.activeRevision) {
              if (current.name !== pendingMarker.nextName || !isDeepStrictEqual(this.readRevisionFile(routineId, nextRevision), pendingMarker.revision)) throw new Error(`Routine cutover conflicts with active revision: ${routineId}@${nextRevision}`)
            }
            assertDurableLock(this.routineLockPath(routineId), lockToken)
            writeJsonRecord(path, { ...pendingRaw, state: 'complete', completedAt: this.clock() })
            return
          }
          if (nextRevision !== current.activeRevision + 1) throw new Error(`Routine cutover is out of order: ${routineId}@${nextRevision}`)
          if (pendingMarker.previousRevision !== current.activeRevision) throw new Error(`Routine cutover predecessor mismatch: ${routineId}@${nextRevision}`)
          const revisionPath = this.revisionPath(routineId, nextRevision)
          let revision: RoutineRevision
          if (existsSync(revisionPath)) {
            revision = this.readRevisionFile(routineId, nextRevision)
          } else {
            revision = pendingMarker.revision
            assertDurableLock(this.routineLockPath(routineId), lockToken)
            if (!writeJsonIfAbsent(revisionPath, revision)) revision = this.readRevisionFile(routineId, nextRevision)
          }
          if (!isDeepStrictEqual(revision, pendingMarker.revision)) throw new Error(`Routine revision cutover mismatch: ${routineId}@${nextRevision}`)
          assertDurableLock(this.routineLockPath(routineId), lockToken)
          writeJsonRecord(this.activePath(routineId), revision)
          const next = { ...current, name: pendingMarker.nextName, activeRevision: nextRevision, updatedAt: this.clock() }
          assertDurableLock(this.routineLockPath(routineId), lockToken)
          writeJsonRecord(this.recordPath(routineId), next)
          this.records.set(routineId, next)
          assertDurableLock(this.routineLockPath(routineId), lockToken)
          writeJsonRecord(path, { ...pendingRaw, state: 'complete', completedAt: this.clock() })
        })
        cutovers.push(file)
      } catch (error) {
        if (isDurableLockBusy(error)) continue
        this.quarantineCutoverMarker(path, pendingRaw, { routineId: pendingMarker.routineId }, error)
      }
    }
    const transitionDir = join(this.rootPath, 'transitions')
    for (const file of readdirSync(transitionDir).filter(name => name.endsWith('.json'))) {
      const path = join(transitionDir, file)
      const filenameIdentity = transitionMarkerIdentity(file)
      let raw: unknown = null
      try {
        assertRegularFile(path, 'Routine transition marker')
        raw = readJsonFile(path)
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Routine transition marker is corrupt')
        const marker = raw as Record<string, unknown>
        const runId = assertId(marker.runId, 'runId') as RoutineRunId
        const expectedVersion = marker.expectedVersion
        if (!Number.isSafeInteger(expectedVersion) || (expectedVersion as number) < 1) throw new Error('Routine transition marker version is corrupt')
        const expected = expectedVersion as number
        if (file !== `${runId}-${expected}.json`) throw new Error('Routine transition marker identity mismatch')
        const parsedMarker = parseTransitionMarker(marker, runId, expected)
        const current = this.getRun(runId)
        if (!current) {
          this.quarantineTransitionMarker(path, raw, filenameIdentity ?? { runId, expectedVersion: expected }, new Error(`Routine transition marker has no run: ${runId}`))
          continue
        }
        if (current.version === expected) {
          const recovered = this.transitionRun(runId, expected, parsedMarker.next, { attempt: parsedMarker.attempt, ...(parsedMarker.claim ? { claim: parsedMarker.claim } : {}) })
          if (recovered.version > current.version) transitions.push(runId)
        } else if (current.version > expected) {
          this.removeTransitionMarkerIfCommitted(path, runId, expected)
        } else {
          this.quarantineTransitionMarker(path, raw, filenameIdentity ?? { runId, expectedVersion: expected }, new Error(`Routine transition marker is ahead of run: ${runId}@${expected}`))
        }
      } catch (error) {
        if (isDurableLockBusy(error)) continue
        const identity = filenameIdentity ?? transitionMarkerIdentityFromRaw(raw)
        if (identity) {
          try {
            if (this.removeTransitionMarkerIfCommitted(path, identity.runId, identity.expectedVersion)) continue
          } catch (cleanupError) {
            if (isDurableLockBusy(cleanupError)) continue
            this.quarantineTransitionMarker(path, raw, identity, cleanupError)
            continue
          }
          this.quarantineTransitionMarker(path, raw, identity, error)
          continue
        }
        if (existsSync(path)) this.quarantine(path, error)
      }
    }
    return { cutovers, transitions }
  }

  getRecoveryErrors(): RoutineRecoveryError[] { return this.recoveryErrors.map(error => ({ ...error })) }

  reload(): void {
    const cached = new Map(this.records)
    this.records.clear()
    const directory = join(this.rootPath, 'routines')
    if (!existsSync(directory)) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      let path = join(directory, entry.name)
      try {
        const routineId = assertId(entry.name, 'routineId') as RoutineId
        this.withRoutineLock(routineId, (lockToken) => {
          path = this.recordPath(routineId)
          if (!existsSync(path)) return
          assertRegularFile(path, 'Routine record')
          const record = this.readRoutineRecord(routineId, lockToken)
          if (record) {
            path = this.activePath(routineId)
            this.assertActiveRevision(record, lockToken)
            assertDurableLock(this.routineLockPath(routineId), lockToken)
            this.records.set(routineId, record)
          }
        })
      } catch (error) {
        if (isDurableLockBusy(error)) {
          const routineId = entry.name as RoutineId
          const record = cached.get(routineId)
          if (record) this.records.set(routineId, record)
          continue
        }
        this.quarantine(path, error)
      }
    }
  }

  private quarantineTransitionMarker(path: string, raw: unknown, identity: TransitionMarkerIdentity, error: unknown): void {
    try {
      withDurableLock(this.transitionLockPath(identity.runId), (lockToken) => {
        if (!existsSync(path)) return
        try {
          assertRegularFile(path, 'Routine transition marker')
          const current = readJsonFile(path)
          if (!isDeepStrictEqual(current, raw)) return
        } catch {
          if (!existsSync(path)) return
        }
        assertDurableLock(this.transitionLockPath(identity.runId), lockToken)
        this.quarantine(path, error)
      })
    } catch (quarantineError) {
      if (!isDurableLockBusy(quarantineError)) this.recoveryErrors.push({ path, message: `${error instanceof Error ? error.message : String(error)}; quarantine failed: ${quarantineError instanceof Error ? quarantineError.message : String(quarantineError)}` })
    }
  }

  private quarantineCutoverMarker(path: string, raw: unknown, identity: CutoverMarkerIdentity, error: unknown): void {
    try {
      this.withRoutineLock(identity.routineId, (lockToken) => {
        if (!existsSync(path)) return
        try {
          assertRegularFile(path, 'Routine cutover marker')
          const current = readJsonFile(path)
          if (!isDeepStrictEqual(current, raw)) return
          try {
            if (assertCutoverMarker(current, this.workspaceId).state === 'complete') return
          } catch {
            // The same malformed artifact remains under the routine lock.
          }
        } catch {
          if (!existsSync(path)) return
        }
        assertDurableLock(this.routineLockPath(identity.routineId), lockToken)
        this.quarantine(path, error)
      })
    } catch (quarantineError) {
      if (!isDurableLockBusy(quarantineError)) this.recoveryErrors.push({ path, message: `${error instanceof Error ? error.message : String(error)}; quarantine failed: ${quarantineError instanceof Error ? quarantineError.message : String(quarantineError)}` })
    }
  }

  private buildRevision(routineId: RoutineId, revision: number, input: CreateRoutineInput, createdAt: string): RoutineRevision {
    return { schemaVersion: ROUTINE_SCHEMA_VERSION, routineId, revision, trigger: assertTrigger(input.trigger), input: assertText(input.input, 'input'), expectedResult: assertText(input.expectedResult, 'expectedResult'), approvalBoundary: assertChoice(input.approvalBoundary, 'approvalBoundary', ['safe', 'ask', 'allow-all'] as const), failurePolicy: assertChoice(input.failurePolicy, 'failurePolicy', ['stop', 'retry', 'uncertain'] as const), destination: assertDestination(input.destination), createdAt: assertTimestamp(createdAt, 'createdAt') }
  }
  private require(routineId: RoutineId | string): RoutineRecord {
    const id = assertId(routineId, 'routineId') as RoutineId
    const record = this.get(id)
    if (!record) throw new Error(`Routine not found: ${routineId}`)
    return record
  }
  private assertOccurrenceClaim(occurrenceId: TriggerOccurrenceId, claim: RoutineClaim): void {
    const occurrence = this.readOccurrence(occurrenceId)
    if (occurrence.workerId !== claim.workerId || occurrence.claimToken !== claim.claimToken || occurrence.leaseUntil !== claim.leaseUntil) throw new Error(`Routine occurrence claim lost: ${occurrenceId}`)
    const claimPath = this.claimPath(occurrenceId)
    if (!existsSync(claimPath)) throw new Error(`Routine occurrence claim is missing: ${occurrenceId}`)
    assertRegularFile(claimPath, 'Routine occurrence claim')
    const persisted = assertClaim(readJsonFile(claimPath), occurrenceId)
    if (!isDeepStrictEqual(persisted, claim)) throw new Error(`Routine occurrence claim lost: ${occurrenceId}`)
    if (Date.parse(claim.leaseUntil) <= Date.parse(this.clock())) throw new Error(`Routine occurrence claim expired: ${occurrenceId}`)
  }

  private ensureOccurrenceRunPointer(occurrenceId: TriggerOccurrenceId, runId: RoutineRunId): void {
    const path = this.occurrenceRunPath(occurrenceId)
    withDurableLock(`${path}.lock`, (lockToken) => {
      const expected = `${runId}\n`
      let pointer: string | undefined
      try {
        if (existsSync(path)) {
          assertRegularFile(path, 'Occurrence run index')
          const parsed = readJsonFile(path)
          if (typeof parsed !== 'string' || !parsed) throw new Error('Occurrence run index is corrupt')
          pointer = parsed
        }
      } catch (error) {
        if (existsSync(path)) this.quarantine(path, error)
      }
      if (pointer === undefined) {
        assertDurableLock(`${path}.lock`, lockToken)
        if (!writeJsonIfAbsent(path, expected)) {
          const observed = readJsonFile(path)
          if (typeof observed !== 'string' || observed !== expected) throw new Error('Occurrence run index collision')
        }
      } else if (pointer !== expected) throw new Error('Occurrence run index collision')
    })
  }

  private readCursor(path: string, routineId: RoutineId, revision: number, label: string, lockToken: string): string | null {
    if (!existsSync(path)) return null
    try {
      assertRegularFile(path, label)
      const raw = readJsonFile(path)
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${label} is corrupt`)
      const record = raw as Record<string, unknown>
      if (record.routineId !== routineId || record.revision !== revision) throw new Error(`${label} identity mismatch`)
      if (path.endsWith('.pending') && (typeof record.token !== 'string' || !record.token || typeof record.leaseUntil !== 'string' || !Number.isFinite(Date.parse(record.leaseUntil)))) throw new Error(`${label} lease is corrupt`)
      return assertTimestamp(record.cursor, label)
    } catch (error) {
      if (existsSync(path)) {
        assertDurableLock(this.cursorLockPath(routineId, revision), lockToken)
        this.quarantine(path, error)
      }
      return null
    }
  }

  private readRoutineRecord(id: RoutineId, lockToken?: string): RoutineRecord | null {
    const path = this.recordPath(id)
    try {
      assertRegularFile(path, 'Routine record')
      return assertRoutine(readJsonFile(path), this.workspaceId, id)
    } catch (error) {
      if (existsSync(path)) {
        if (lockToken) assertDurableLock(this.routineLockPath(id), lockToken)
        this.quarantine(path, error)
      }
      return null
    }
  }
  private assertActiveRevision(record: RoutineRecord, lockToken?: string): void {
    const path = this.activePath(record.routineId)
    assertRegularFile(path, 'Routine active revision')
    const active = assertRevisionRecord(readJsonFile(path), this.workspaceId, record.routineId)
    const revision = this.readRevisionFile(record.routineId, record.activeRevision, lockToken)
    if (active.revision !== record.activeRevision || !isDeepStrictEqual(active, revision)) throw new Error(`Routine active revision mismatch: ${record.routineId}@${record.activeRevision}`)
  }
  private readRevisionFile(routineId: RoutineId | string, revision: number, lockToken?: string): RoutineRevision {
    const path = this.revisionPath(routineId, revision)
    try {
      assertRegularFile(path, 'Routine revision')
      const raw = readJsonFile(path)
      if (!raw) throw new Error(`Routine revision not found: ${routineId}@${revision}`)
      const parsed = assertRevisionRecord(raw, this.workspaceId, assertId(routineId, 'routineId'))
      if (parsed.revision !== revision) throw new Error(`Routine revision identity mismatch: ${routineId}@${revision}`)
      return parsed
    } catch (error) {
      if (existsSync(path)) {
        if (lockToken) assertDurableLock(this.routineLockPath(routineId), lockToken)
        this.quarantine(path, error)
      }
      throw error
    }
  }
  private readOccurrenceFile(id: TriggerOccurrenceId): RoutineOccurrence {
    const path = this.occurrencePath(id)
    assertRegularFile(path, 'Routine occurrence')
    const raw = readJsonFile(path)
    if (!raw) throw new Error(`Routine occurrence not found: ${id}`)
    const occurrence = assertOccurrence(raw, this.workspaceId)
    const expectedId = deriveTriggerOccurrenceId({ routineId: occurrence.routineId, revision: occurrence.routineRevision, source: occurrence.source, ...(occurrence.scheduledInstant ? { scheduledInstant: occurrence.scheduledInstant } : { externalEventId: occurrence.externalEventId }) })
    if (occurrence.occurrenceId !== id || occurrence.occurrenceId !== expectedId) throw new Error(`Routine occurrence identity mismatch: ${id}`)
    return clone(occurrence)
  }
  private readOccurrence(id: TriggerOccurrenceId): RoutineOccurrence {
    const occurrence = this.readOccurrenceFile(id)
    const routine = this.get(occurrence.routineId)
    if (!routine || routine.workspaceId !== this.workspaceId) throw new Error(`Routine occurrence owner is unavailable: ${id}`)
    this.getRevision(occurrence.routineId, occurrence.routineRevision)
    return occurrence
  }
  private readRunFile(id: RoutineRunId): RoutineRun {
    const path = this.runPath(id)
    assertRegularFile(path, 'Routine run')
    const raw = readJsonFile(path)
    if (!raw) throw new Error(`Routine run not found: ${id}`)
    const run = assertRun(raw, this.workspaceId)
    if (run.runId !== id || run.runId !== deriveRoutineRunId(run.origin.occurrenceId)) throw new Error(`Routine run identity mismatch: ${id}`)
    return clone(run)
  }
  private readRun(id: RoutineRunId): RoutineRun {
    const run = this.readRunFile(id)
    const routine = this.get(run.routineId)
    if (routine && run.ownerBotId !== routine.ownerBotId) throw new Error(`Routine run owner mismatch: ${id}`)
    if (routine) {
      const occurrence = this.getOccurrence(run.origin.occurrenceId)
      if (occurrence && (occurrence.routineId !== run.routineId || occurrence.routineRevision !== run.routineRevision)) throw new Error(`Routine run occurrence mismatch: ${id}`)
      this.getRevision(run.routineId, run.routineRevision)
    }
    return run
  }
  private removeTransitionMarkerIfCommitted(path: string, runId: RoutineRunId, expectedVersion: number): boolean {
    return withDurableLock(this.transitionLockPath(runId), (lockToken) => {
      const current = this.getRun(runId)
      if (!current || current.version <= expectedVersion) return false
      assertDurableLock(this.transitionLockPath(runId), lockToken)
      removePointer(path)
      return true
    })
  }
  private withRoutineLock<T>(routineId: RoutineId | string, operation: (lockToken: string) => T): T {
    const id = assertId(routineId, 'routineId')
    const path = this.routineLockPath(id)
    const existingToken = this.routineLockTokens.get(id)
    if (existingToken) {
      assertDurableLock(path, existingToken)
      return operation(existingToken)
    }
    return withDurableLock(path, (lockToken) => {
      this.routineLockTokens.set(id, lockToken)
      try {
        return operation(lockToken)
      } finally {
        if (this.routineLockTokens.get(id) === lockToken) this.routineLockTokens.delete(id)
      }
    })
  }

  private quarantine(path: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    try {
      renameSync(path, `${path}.corrupt-${randomUUID()}`)
      this.recoveryErrors.push({ path, message })
    } catch (quarantineError) {
      this.recoveryErrors.push({ path, message: `${message}; quarantine failed: ${quarantineError instanceof Error ? quarantineError.message : String(quarantineError)}` })
    }
  }
  private allRuns(): RoutineRun[] { return this.listAllRuns() }
  private routineLockPath(id: RoutineId | string): string { return join(this.rootPath, 'routines', `.${assertId(id, 'routineId')}.lock`) }
  private occurrenceLockPath(id: TriggerOccurrenceId): string { return join(this.rootPath, 'claims', `.${assertId(id, 'occurrenceId')}.lock`) }
  private transitionLockPath(id: RoutineRunId): string { return join(this.rootPath, 'transitions', `.${assertId(id, 'runId')}.lock`) }
  private runLockPath(id: RoutineRunId): string { return join(this.rootPath, 'runs', `.${assertId(id, 'runId')}.lock`) }
  private cursorLockPath(id: RoutineId, revision: number): string { return join(this.rootPath, 'cursors', `.${assertId(id, 'routineId')}-${assertRevision(revision)}.lock`) }
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

function transitionRequiresClaim(current: RoutineRunState, next: RoutineRunState): boolean {
  return (current.kind === 'queued' && next.kind === 'claimed')
    || (current.kind === 'claimed' && next.kind === 'running')
    || (current.kind === 'awaiting-approval' && next.kind === 'running')
}

function assertClaimMatchesState(next: RoutineRunState, claim: RoutineClaim): void {
  if (next.kind !== 'claimed') return
  if (next.workerId !== claim.workerId || next.claimToken !== claim.claimToken || next.leaseUntil !== claim.leaseUntil) {
    throw new Error('Routine run claim does not match claimed state')
  }
}

function assertTransition(current: RoutineRunState, next: RoutineRunState): void {
  const allowed: Record<RoutineRunState['kind'], readonly RoutineRunState['kind'][]> = {
    queued: ['claimed', 'uncertain', 'cancelled'], claimed: ['running', 'queued', 'uncertain', 'cancelled'], running: ['queued', 'awaiting-approval', 'succeeded', 'failed', 'uncertain', 'cancelled'], 'awaiting-approval': ['running', 'failed', 'cancelled', 'uncertain'], succeeded: [], failed: [], cancelled: [], uncertain: ['reconciled'], reconciled: [],
  }
  if (!allowed[current.kind].includes(next.kind)) throw new Error(`Invalid routine run transition: ${current.kind} -> ${next.kind}`)
}
