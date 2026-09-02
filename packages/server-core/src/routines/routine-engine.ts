import { existsSync, renameSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  RoutineEventMatcher,
  RoutineId,
  RoutinePublicDto,
  RoutineRevision,
  RoutineRun,
  RoutineRunId,
  RoutineRunPublicDto,
  ToolInvocation,
} from '@kata-sh/core'
import {
  RoutineStore,
  deriveRoutineRunId,
  routinesRootPath,
  type CreateRoutineInput,
  type RecordOccurrenceInput,
  type UpdateRoutineInput,
  toRoutineRunPublicDto,
  latestScheduledInstant,
  nextScheduledInstant,
  scheduledInstantsBetween,
} from '@kata-sh/shared/routines'
import { readJsonFile, removePointer, writeJsonRecord } from '@kata-sh/shared/conversations'
import { computeOperationHash } from '@kata-sh/shared/tools'
import { isPotentiallyCatastrophicRegex, regexTestBounded } from '@kata-sh/shared/automations'
import { assertDurableLock, assertRegularFile, withDurableLock } from '@kata-sh/shared/spawn-tasks/durable-fs'

export interface RoutineEventInput {
  readonly source: string
  readonly externalEventId: string
  readonly payload: unknown
  readonly occurredAt?: string
}

export type RoutineExecutionResult =
  | { readonly kind: 'completed'; readonly reply: string }
  | {
      readonly kind: 'awaiting-approval'
      readonly approvalId: string
      readonly operationHash: string
      readonly version: number
      readonly invocation: ToolInvocation
      readonly requestId?: string
    }
  | { readonly kind: 'failed'; readonly error: string }
  | { readonly kind: 'uncertain'; readonly reason: string }

export interface RoutineExecutor {
  execute(run: RoutineRun, revision: RoutineRevision): Promise<RoutineExecutionResult>
  publish?(run: RoutineRun, revision: RoutineRevision): Promise<void>
  validateApproval?(attempt: RoutineApprovalAttempt): Promise<'pending' | 'allowed' | 'consumed' | 'denied' | 'expired' | 'stale'>
  claimApproval?(attempt: RoutineApprovalAttempt): Promise<void>
  resolveApproval?(attempt: RoutineApprovalAttempt, allowed: boolean): Promise<void>
  denyApproval?(approvalId: string): Promise<void>
}

export interface RoutineEngineOptions {
  readonly workspaceRoot: string
  readonly workspaceId: string
  readonly execute: RoutineExecutor
  readonly store?: RoutineStore
  readonly clock?: () => string
  readonly workerId?: string
  readonly tickIntervalMs?: number
  readonly onChanged?: (routineId?: RoutineId) => void
  readonly onLegacyScheduleTick?: (timestamp: string) => void | Promise<void>
}

export interface RoutineApprovalAttempt {
  readonly schemaVersion: 1
  readonly runId: RoutineRunId
  readonly approvalId: string
  readonly operationHash: string
  readonly version: number
  readonly invocation: ToolInvocation
  readonly sessionId: string
  readonly requestId?: string
  readonly createdAt: string
}

const DEFAULT_TICK_INTERVAL_MS = 60_000
const DEFAULT_CLAIM_LEASE_MS = 120_000

function isRoutineTransitionRace(error: unknown): boolean {
  return error instanceof Error && (error.message.startsWith('Routine run version conflict:') || error.message.startsWith('Routine is not enabled:') || error.message.startsWith('Routine not found:') || error.message.startsWith('Durable lock is busy:') || error.message.startsWith('Durable lock lost:'))
}
const SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000

function timestamp(clock: () => string): string {
  const value = clock()
  if (!Number.isFinite(Date.parse(value))) throw new Error('Routine clock must return an ISO timestamp')
  return value
}

function getField(payload: unknown, field: string): unknown {
  let current = payload
  for (const part of field.split('.')) {
    if (!current || typeof current !== 'object' || !(part in current)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

export function msUntilNextMinute(now: Date): number {
  const elapsed = now.getSeconds() * 1000 + now.getMilliseconds()
  return elapsed === 0 ? 60_000 : 60_000 - elapsed
}

export function routineEventMatches(payload: unknown, matcher: RoutineEventMatcher): boolean {
  const value = getField(payload, matcher.field)
  if (matcher.equals !== undefined) {
    return typeof value === 'string' && value === matcher.equals
  }
  if (matcher.matches !== undefined) {
    if (typeof value !== 'string' || isPotentiallyCatastrophicRegex(matcher.matches)) return false
    return regexTestBounded(matcher.matches, value)
  }
  return false
}

export class RoutineEngine {
  readonly store: RoutineStore
  readonly workspaceId: string

  private readonly executeAdapter: RoutineExecutor
  private readonly clock: () => string
  private readonly workerId: string
  private readonly tickIntervalMs: number
  private readonly onChanged?: (routineId?: RoutineId) => void
  private readonly onLegacyScheduleTick?: (timestamp: string) => void | Promise<void>
  private legacyScheduleMinute: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private alignmentTimer: ReturnType<typeof setTimeout> | null = null
  private legacyTickPromise: Promise<void> | null = null
  private tickPromise: Promise<void> | null = null
  private started = false
  private startPromise: Promise<void> | null = null
  private readonly resolvedApprovals = new Map<string, boolean>()
  private readonly approvalRequestIds = new Map<RoutineRunId, { approvalId: string; requestId: string }>()
  private readonly approvalResolutions = new Map<RoutineRunId, Promise<RoutineRunPublicDto | null>>()
  private readonly inFlight = new Map<string, Promise<RoutineRun>>()
  private readonly approvalRecovery = new Set<Promise<unknown>>()
  private readonly startupRecovery = new Set<Promise<unknown>>()
  private stopping = false
  private closed = false
  private lifecycleGeneration = 0
  private stopPromise: Promise<void> | null = null
  private readonly timedOutGenerations = new Set<number>()

  constructor(options: RoutineEngineOptions) {
    this.workspaceId = options.workspaceId
    this.clock = options.clock ?? (() => new Date().toISOString())
    this.workerId = options.workerId ?? `routine-worker:${process.pid}:${randomUUID()}`
    this.tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS
    if (!Number.isSafeInteger(this.tickIntervalMs) || this.tickIntervalMs < 1) {
      throw new TypeError('tickIntervalMs must be a positive safe integer')
    }
    this.executeAdapter = options.execute
    this.onLegacyScheduleTick = options.onLegacyScheduleTick
    this.store = options.store ?? new RoutineStore({
      workspaceRoot: options.workspaceRoot,
      workspaceId: options.workspaceId,
      clock: this.clock,
    })
    if (this.store.workspaceId !== options.workspaceId) throw new Error('Routine store workspace mismatch')
    if (this.store.rootPath !== routinesRootPath(options.workspaceRoot)) throw new Error('Routine store root mismatch')
    this.onChanged = options.onChanged
  }

  isRunning(): boolean {
    return this.started && !this.stopping
  }

  async start(): Promise<void> {
    if (this.closed) return
    if (this.stopPromise) await this.stopPromise
    if (this.closed) return
    if (this.startPromise) return this.startPromise
    if (this.started) return
    this.stopping = false
    const generation = ++this.lifecycleGeneration
    let promise!: Promise<void>
    promise = this.startOwned(generation).catch(error => {
      if (this.startPromise === promise) {
        this.started = false
        this.startPromise = null
      }
      throw error
    })
    this.startPromise = promise
    return promise
  }

  private async startOwned(generation: number): Promise<void> {
    this.started = true
    this.store.recover()
    const recovery = this.trackStartupRecovery(this.recoverRuns(generation))
    await recovery
    if (this.stopping || generation !== this.lifecycleGeneration) return
    void this.tick(undefined, generation).catch(() => undefined)
    this.armTickTimer(generation)
  }

  private armTickTimer(generation: number): void {
    const fire = () => {
      if (this.stopping || generation !== this.lifecycleGeneration) return
      const now = timestamp(this.clock)
      const promise = this.emitLegacyScheduleTick(now)
        .then(() => this.tick(now, generation))
        .catch(() => undefined)
      this.legacyTickPromise = promise
      void promise.then(() => {
        if (this.legacyTickPromise === promise) this.legacyTickPromise = null
      })
    }
    const armInterval = () => {
      this.timer = setInterval(fire, this.tickIntervalMs)
      if (typeof this.timer === 'object' && 'unref' in this.timer) this.timer.unref()
    }
    if (this.tickIntervalMs === DEFAULT_TICK_INTERVAL_MS) {
      this.alignmentTimer = setTimeout(() => {
        this.alignmentTimer = null
        if (this.stopping || generation !== this.lifecycleGeneration) return
        fire()
        armInterval()
      }, msUntilNextMinute(new Date()))
      if (typeof this.alignmentTimer === 'object' && 'unref' in this.alignmentTimer) this.alignmentTimer.unref()
      return
    }
    armInterval()
  }

  async close(): Promise<void> {
    this.closed = true
    await this.stop()
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    const promise = this.stopOwned()
    this.stopPromise = promise
    try {
      await promise
    } finally {
      if (this.stopPromise === promise) this.stopPromise = null
    }
  }

  private async stopOwned(): Promise<void> {
    this.stopping = true
    const generation = this.lifecycleGeneration++
    // ponytail: cap startup and shutdown drain at 5s; restart recovery marks unfinished runs uncertain.
    const deadline = Date.now() + SHUTDOWN_DRAIN_TIMEOUT_MS
    const startup = this.startPromise
    const startupRemaining = deadline - Date.now()
    if (startup && startupRemaining > 0) {
      await Promise.race([
        startup.catch(() => undefined),
        new Promise<void>(resolve => setTimeout(resolve, startupRemaining)),
      ])
    }
    if (this.alignmentTimer) {
      clearTimeout(this.alignmentTimer)
      this.alignmentTimer = null
    }
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.started = false
    if (this.startPromise === startup) this.startPromise = null
    while (this.tickPromise || this.legacyTickPromise || this.inFlight.size > 0 || this.approvalRecovery.size > 0 || this.startupRecovery.size > 0) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      const pending = [
        ...(this.tickPromise ? [this.tickPromise] : []),
        ...(this.legacyTickPromise ? [this.legacyTickPromise] : []),
        ...this.inFlight.values(),
        ...this.approvalRecovery,
        ...this.startupRecovery,
      ]
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>(resolve => setTimeout(resolve, remaining)),
      ])
    }
    if (this.tickPromise || this.legacyTickPromise || this.inFlight.size > 0 || this.approvalRecovery.size > 0 || this.startupRecovery.size > 0) {
      this.timedOutGenerations.add(generation)
    }
  }

  create(input: CreateRoutineInput): RoutinePublicDto {
    this.assertOpen()
    const record = this.store.create(input)
    this.notify(record.routineId)
    return this.publicRoutine(record.routineId)
  }

  update(routineId: RoutineId, input: UpdateRoutineInput): RoutinePublicDto {
    this.assertOpen()
    const record = this.store.update(routineId, input)
    this.notify(record.routineId)
    return this.publicRoutine(record.routineId)
  }

  enable(routineId: RoutineId): RoutinePublicDto {
    this.assertOpen()
    const previous = this.store.get(routineId)
    const record = this.store.enable(routineId)
    if (previous?.lifecycle === 'paused') {
      const revision = this.store.getActiveRevision(record.routineId)
      if (revision.trigger.kind === 'schedule') {
        const cursor = this.store.getScheduleCursor(record.routineId, revision.revision) ?? revision.createdAt
        const latest = latestScheduledInstant(revision.trigger, timestamp(this.clock))
        if (latest && Date.parse(latest) > Date.parse(cursor)) this.store.advanceScheduleCursor(record.routineId, revision.revision, latest)
      }
    }
    this.notify(record.routineId)
    void this.tick().catch(() => undefined)
    return this.publicRoutine(record.routineId)
  }

  pause(routineId: RoutineId): RoutinePublicDto {
    this.assertOpen()
    const record = this.store.pause(routineId)
    this.cancelNonRunningRuns(record.routineId)
    this.notify(record.routineId)
    return this.publicRoutine(record.routineId)
  }

  delete(routineId: RoutineId): RoutinePublicDto {
    this.assertOpen()
    const record = this.store.delete(routineId)
    this.cancelNonRunningRuns(record.routineId, 'routine-deleted')
    this.notify(record.routineId)
    return this.publicRoutine(record.routineId)
  }

  get(routineId: RoutineId): RoutinePublicDto {
    this.assertOpen()
    return this.publicRoutine(routineId)
  }

  list(ownerBotId?: string): RoutinePublicDto[] {
    this.assertOpen()
    return this.store.list({ ownerBotId }).filter(record => record.lifecycle !== 'deleted').map(record => this.publicRoutine(record.routineId))
  }

  listRuns(routineId: RoutineId, limit = 50): RoutineRunPublicDto[] {
    this.assertOpen()
    if (!this.store.get(routineId)) throw new Error(`Routine not found: ${routineId}`)
    if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError('limit must be a non-negative safe integer')
    const runs = limit === 0 ? [] : this.store.listRuns(routineId).slice(-limit)
    return runs.reverse().map(toRoutineRunPublicDto)
  }

  async tick(now = timestamp(this.clock), generation = this.lifecycleGeneration): Promise<void> {
    if (this.closed) return
    if (this.tickPromise) return this.tickPromise
    if (this.stopping || generation !== this.lifecycleGeneration) return
    const promise = this.tickOwned(now, generation)
    this.tickPromise = promise
    try {
      await promise
    } finally {
      if (this.tickPromise === promise) this.tickPromise = null
    }
  }

  private async emitLegacyScheduleTick(now: string): Promise<void> {
    if (!this.onLegacyScheduleTick) return
    const minute = now.slice(0, 16)
    if (this.legacyScheduleMinute === minute) return
    this.legacyScheduleMinute = minute
    await this.onLegacyScheduleTick(now)
  }

  private async tickOwned(now: string, generation: number): Promise<void> {
    if (this.stopping || generation !== this.lifecycleGeneration) return
    const due: Promise<unknown>[] = []
    for (const run of this.allRuns()) {
      if (run.state.kind === 'queued' || (run.state.kind === 'claimed' && Date.parse(run.state.leaseUntil) <= Date.parse(now))) {
        due.push(this.dispatch(run, generation))
      } else if (run.state.kind === 'awaiting-approval') {
        due.push(this.reconcileApproval(run, generation))
      } else if (
        (run.state.kind === 'succeeded' || run.state.kind === 'failed' || run.state.kind === 'cancelled' || run.state.kind === 'uncertain' || run.state.kind === 'reconciled')
        && this.readApprovalAttempt(run.runId)
      ) {
        due.push(this.cleanupApproval(run))
      }
    }
    for (const record of this.store.list({ lifecycle: 'enabled' })) {
      const revision = this.store.getActiveRevision(record.routineId)
      if (revision.trigger.kind !== 'schedule') continue
      const cursor = this.store.getScheduleCursor(record.routineId, revision.revision)
        ?? revision.createdAt
      const instants = scheduledInstantsBetween(revision.trigger, cursor, now)
      const scheduledRuns: RoutineRun[] = []
      let allRunsCreated = true
      for (const scheduledInstant of instants) {
        let occurrence: ReturnType<RoutineStore['recordOccurrence']>
        try {
          occurrence = this.store.recordOccurrence({
            routineId: record.routineId,
            routineRevision: revision.revision,
            source: 'schedule',
            scheduledInstant,
          })
        } catch (error) {
          if (isRoutineTransitionRace(error)) { allRunsCreated = false; break }
          throw error
        }
        const run = this.ensureRunForOccurrence(occurrence)
        if (run) scheduledRuns.push(run)
        else allRunsCreated = false
      }
      if (allRunsCreated && instants.length > 0) {
        this.store.advanceScheduleCursor(record.routineId, revision.revision, instants.at(-1)!)
      }
      for (const run of scheduledRuns) due.push(this.dispatch(run, generation))
    }
    await Promise.allSettled(due)
    if (this.stopping || generation !== this.lifecycleGeneration) return
  }

  async ingestEvent(event: RoutineEventInput): Promise<RoutineRunPublicDto[]> {
    if (this.closed || this.stopping) return []
    if (typeof event.source !== 'string' || !event.source.trim()) throw new TypeError('source is required for routine events')
    if (typeof event.externalEventId !== 'string' || !event.externalEventId.trim()) {
      throw new TypeError('externalEventId is required for routine events')
    }
    const occurredAt = event.occurredAt === undefined ? timestamp(this.clock) : (() => {
      const parsed = Date.parse(event.occurredAt)
      if (!Number.isFinite(parsed)) throw new TypeError('occurredAt must be an ISO timestamp')
      return new Date(parsed).toISOString()
    })()
    const pendingRuns: RoutineRun[] = []
    for (const record of this.store.list({ lifecycle: 'enabled' })) {
      const revision = this.store.getActiveRevision(record.routineId)
      if (
        revision.trigger.kind !== 'event'
        || revision.trigger.source !== event.source
        || !routineEventMatches(event.payload, revision.trigger.matcher)
      ) continue
      let occurrence: ReturnType<RoutineStore['recordOccurrence']>
      try {
        occurrence = this.store.recordOccurrence({
          routineId: record.routineId,
          routineRevision: revision.revision,
          source: event.source,
          externalEventId: event.externalEventId,
          occurredAt,
        })
      } catch (error) {
        if (isRoutineTransitionRace(error)) continue
        throw error
      }
      const run = this.ensureRunForOccurrence(occurrence)
      if (run) pendingRuns.push(run)
    }
    for (const run of pendingRuns) {
      this.notify(run.routineId)
      void this.dispatch(run).catch(() => undefined)
    }
    return pendingRuns
      .map(run => this.store.getRun(run.runId))
      .filter((run): run is RoutineRun => run !== null)
      .map(toRoutineRunPublicDto)
  }

  async testRoutine(routineId: RoutineId): Promise<RoutineRunPublicDto> {
    this.assertOpen()
    const record = this.store.get(routineId)
    if (!record || record.lifecycle !== 'enabled') throw new Error(`Routine is not enabled: ${routineId}`)
    const revision = this.store.getActiveRevision(record.routineId)
    const run = await this.triggerOccurrence({
      routineId: record.routineId,
      routineRevision: revision.revision,
      source: 'on-demand',
      externalEventId: `on-demand:${randomUUID()}`,
    })
    if (!run) throw new Error('Routine occurrence was already claimed')
    return toRoutineRunPublicDto(run)
  }

  async replayRun(runId: RoutineRunId): Promise<RoutineRunPublicDto> {
    this.assertOpen()
    const original = this.store.getRun(runId)
    if (!original) throw new Error(`Routine run not found: ${runId}`)
    if (!['succeeded', 'failed', 'cancelled', 'uncertain', 'reconciled'].includes(original.state.kind)) {
      throw new Error(`Only terminal routine runs can be replayed: ${runId}`)
    }
    const routine = this.store.get(original.routineId)
    if (!routine || routine.lifecycle !== 'enabled') throw new Error(`Routine is not enabled: ${original.routineId}`)
    const run = await this.triggerOccurrence({
      routineId: original.routineId,
      routineRevision: original.routineRevision,
      source: 'replay',
      externalEventId: `replay:${original.runId}:${randomUUID()}`,
      origin: { kind: 'replay', occurrenceId: original.origin.occurrenceId, replayOfRunId: original.runId },
    })
    if (!run) throw new Error('Replay occurrence was already claimed')
    return toRoutineRunPublicDto(run)
  }

  async resumeAfterApproval(runId: RoutineRunId, expectedVersion: number): Promise<RoutineRunPublicDto> {
    this.assertOpen()
    const current = this.store.getRun(runId)
    if (this.stopping && current) return toRoutineRunPublicDto(current)
    const generation = this.lifecycleGeneration
    if (!current) return this.resumeAfterApprovalOwned(runId, expectedVersion, false, generation)
    const resumed = await this.trackApprovalRecovery(this.resumeApprovalOnce(current, expectedVersion, generation))
    if (!resumed) throw new Error('Routine approval could not be resumed')
    return resumed
  }

  private trackApprovalRecovery<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() => this.approvalRecovery.delete(tracked))
    this.approvalRecovery.add(tracked)
    return tracked
  }

  private trackStartupRecovery<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() => this.startupRecovery.delete(tracked))
    this.startupRecovery.add(tracked)
    return tracked
  }

  private resumeAfterApprovalOwned(runId: RoutineRunId, expectedVersion: number, approvalClaimed: boolean, generation = this.lifecycleGeneration): Promise<RoutineRunPublicDto> {
    return this.trackApprovalRecovery(this.resumeAfterApprovalWork(runId, expectedVersion, approvalClaimed, generation))
  }

  private async resumeAfterApprovalWork(runId: RoutineRunId, expectedVersion: number, approvalClaimed: boolean, generation: number): Promise<RoutineRunPublicDto> {
    const current = this.store.getRun(runId)
    if (!current) throw new Error(`Routine run not found: ${runId}`)
    if (!this.isGenerationCurrent(generation)) return toRoutineRunPublicDto(current)
    if (current.version !== expectedVersion) {
      if (current.version > expectedVersion && (current.state.kind === 'running' || current.state.kind === 'succeeded' || current.state.kind === 'failed' || current.state.kind === 'cancelled' || current.state.kind === 'uncertain' || current.state.kind === 'reconciled')) return toRoutineRunPublicDto(current)
      throw new Error(`Routine run version conflict: expected ${expectedVersion}, current ${current.version}`)
    }
    if (current.state.kind !== 'awaiting-approval') {
      if (current.state.kind === 'running' || current.state.kind === 'succeeded' || current.state.kind === 'failed' || current.state.kind === 'cancelled' || current.state.kind === 'uncertain' || current.state.kind === 'reconciled') return toRoutineRunPublicDto(current)
      throw new Error('Routine run is not awaiting approval')
    }
    const routine = this.store.get(current.routineId)
    if (!routine || routine.lifecycle !== 'enabled') return toRoutineRunPublicDto(current)
    const attempt = this.readApprovalAttempt(current.runId)
    if (!this.isApprovalAttemptForRun(current, attempt)) {
      await this.markApprovalUncertain(current, 'approval execution record is missing or invalid', generation)
      return toRoutineRunPublicDto(this.store.getRun(current.runId) ?? current)
    }
    if (!attempt.requestId) {
      if (!this.isGenerationCurrent(generation)) return toRoutineRunPublicDto(this.store.getRun(current.runId) ?? current)
      this.rememberApprovalResolution(current.state.approvalId, true)
      return toRoutineRunPublicDto(current)
    }
    if (!approvalClaimed) {
      if (!this.executeAdapter.claimApproval) throw new Error('Routine approval execution record is unavailable')
      await this.executeAdapter.claimApproval(attempt)
      if (!this.isGenerationCurrent(generation)) return toRoutineRunPublicDto(this.store.getRun(current.runId) ?? current)
    }
    try {
      await this.executeAdapter.resolveApproval?.(attempt, true)
    } catch {
      await this.markApprovalUncertain(current, 'approval response outcome is uncertain', generation)
      return toRoutineRunPublicDto(this.store.getRun(current.runId) ?? current)
    }
    if (this.stopping || generation !== this.lifecycleGeneration) return toRoutineRunPublicDto(this.store.getRun(current.runId) ?? current)
    let claim: ReturnType<RoutineEngine['claimForRun']>
    try {
      claim = this.claimForRun(current)
    } catch (error) {
      if (isRoutineTransitionRace(error)) return toRoutineRunPublicDto(this.store.getRun(current.runId) ?? current)
      throw error
    }
    if (!claim) return toRoutineRunPublicDto(this.store.getRun(current.runId) ?? current)
    const running = this.transitionIfCurrent(current.runId, current.version, { kind: 'running', at: timestamp(this.clock) }, { claim })
    if (running?.state.kind === 'running') await this.dispatchOwned(running, generation)
    const latest = this.store.getRun(running?.runId ?? current.runId)
    if (!latest) throw new Error(`Routine run disappeared: ${current.runId}`)
    return toRoutineRunPublicDto(latest)
  }

  onApprovalRequest(runId: RoutineRunId, approvalId: string, requestId: string): boolean {
    if (this.closed || this.stopping || typeof requestId !== 'string' || !requestId.trim()) return false
    const run = this.store.getRun(runId)
    const routine = run ? this.store.get(run.routineId) : null
    if (!run || !routine || routine.lifecycle !== 'enabled') return false
    if (run?.state.kind === 'awaiting-approval') {
      if (run.state.approvalId !== approvalId) return false
      const attempt = this.readApprovalAttempt(runId)
      if (!this.isApprovalAttemptForRun(run, attempt) || attempt.approvalId !== approvalId) return false
      if (attempt.requestId !== undefined && attempt.requestId !== requestId) return false
      try {
        this.writeApprovalAttempt({ ...attempt, requestId })
        return true
      } catch {
        return false
      }
    }
    if (run.state.kind === 'running') {
      const existing = this.approvalRequestIds.get(runId)
      if (existing && (existing.approvalId !== approvalId || existing.requestId !== requestId)) return false
      if (!existing) this.approvalRequestIds.set(runId, { approvalId, requestId })
      return true
    }
    return false
  }

  async onApprovalResolved(approvalId: string, allowed: boolean): Promise<RoutineRunPublicDto | null> {
    if (this.closed || this.stopping) return null
    const generation = this.lifecycleGeneration
    return this.trackApprovalRecovery(this.onApprovalResolvedWork(approvalId, allowed, generation))
  }

  async onApprovalResponseUncertain(approvalId: string, reason = 'approval response outcome is uncertain'): Promise<RoutineRunPublicDto | null> {
    if (this.closed || this.stopping) return null
    const generation = this.lifecycleGeneration
    return this.trackApprovalRecovery(this.markApprovalResponseUncertain(approvalId, reason, generation))
  }

  private async markApprovalResponseUncertain(approvalId: string, reason: string, generation: number): Promise<RoutineRunPublicDto | null> {
    const run = this.findRunByApproval(approvalId)
    if (!run) return null
    await this.markApprovalUncertain(run, reason, generation)
    const current = this.store.getRun(run.runId)
    return current ? toRoutineRunPublicDto(current) : null
  }

  private async onApprovalResolvedWork(approvalId: string, allowed: boolean, generation: number): Promise<RoutineRunPublicDto | null> {
    const run = this.findRunByApproval(approvalId)
    if (!run) {
      if (this.inFlight.size === 0) return null
      this.rememberApprovalResolution(approvalId, allowed)
      return null
    }
    if (allowed) {
      const attempt = this.readApprovalAttempt(run.runId)
      if (!this.isApprovalAttemptForRun(run, attempt)) return this.resolveApprovalOnce(run, allowed, generation)
      if (!attempt.requestId) {
        this.rememberApprovalResolution(approvalId, allowed)
        return toRoutineRunPublicDto(run)
      }
    }
    return this.resolveApprovalOnce(run, allowed, generation)
  }

  private rememberApprovalResolution(approvalId: string, allowed: boolean): void {
    this.resolvedApprovals.set(approvalId, allowed)
    setTimeout(() => this.resolvedApprovals.delete(approvalId), 60_000).unref?.()
  }

  private trackApprovalResolution(runId: RoutineRunId, operation: () => Promise<RoutineRunPublicDto | null>): Promise<RoutineRunPublicDto | null> {
    const existing = this.approvalResolutions.get(runId)
    if (existing) return existing
    const promise = operation()
    this.approvalResolutions.set(runId, promise)
    void promise.then(
      () => { if (this.approvalResolutions.get(runId) === promise) this.approvalResolutions.delete(runId) },
      () => { if (this.approvalResolutions.get(runId) === promise) this.approvalResolutions.delete(runId) },
    )
    return promise
  }

  private resolveApprovalOnce(run: RoutineRun, allowed: boolean, generation = this.lifecycleGeneration): Promise<RoutineRunPublicDto | null> {
    return this.trackApprovalResolution(run.runId, () => this.applyApprovalResolution(run, allowed, generation))
  }

  private takeBufferedApprovalResolution(runId: RoutineRunId): { approvalId: string; allowed: boolean } | undefined {
    const request = this.approvalRequestIds.get(runId)
    if (!request) return undefined
    const allowed = this.resolvedApprovals.get(request.approvalId)
    if (allowed === undefined) return undefined
    this.approvalRequestIds.delete(runId)
    this.resolvedApprovals.delete(request.approvalId)
    return { approvalId: request.approvalId, allowed }
  }

  private resumeApprovalOnce(run: RoutineRun, expectedVersion: number, generation = this.lifecycleGeneration): Promise<RoutineRunPublicDto | null> {
    return this.trackApprovalResolution(run.runId, () => this.resumeAfterApprovalWork(run.runId, expectedVersion, false, generation))
  }

  private transitionWithOwnership(runId: RoutineRunId, expectedVersion: number, next: RoutineRun['state'], options?: Parameters<RoutineStore['transitionRun']>[3]): { run: RoutineRun | null; committed: boolean } {
    try {
      return { run: this.store.transitionRun(runId, expectedVersion, next, options), committed: true }
    } catch (error) {
      if (isRoutineTransitionRace(error)) return { run: this.store.getRun(runId), committed: false }
      throw error
    }
  }

  private transitionIfCurrent(runId: RoutineRunId, expectedVersion: number, next: RoutineRun['state'], options?: Parameters<RoutineStore['transitionRun']>[3]): RoutineRun | null {
    const transition = this.transitionWithOwnership(runId, expectedVersion, next, options)
    return transition.committed ? transition.run : null
  }

  private transitionAfterExecution(runId: RoutineRunId, expectedVersion: number, next: RoutineRun['state'], attempt?: number): RoutineRun | null {
    try {
      return this.store.transitionRunAfterExecution(runId, expectedVersion, next, attempt)
    } catch (error) {
      if (isRoutineTransitionRace(error)) return null
      throw error
    }
  }

  private transitionWithLifecycle(runId: RoutineRunId, expectedVersion: number, next: RoutineRun['state']): RoutineRun | null {
    try {
      return this.store.transitionRunWithLifecycle(runId, expectedVersion, next)
    } catch (error) {
      if (isRoutineTransitionRace(error)) return null
      throw error
    }
  }

  private claimForRun(run: RoutineRun): { occurrenceId: RoutineRun['origin']['occurrenceId']; workerId: string; claimToken: string; leaseUntil: string } | null {
    const occurrence = this.store.getOccurrence(run.origin.occurrenceId)
    if (!occurrence) return null
    const now = timestamp(this.clock)
    if (occurrence.workerId && occurrence.claimToken && occurrence.leaseUntil && Date.parse(occurrence.leaseUntil) > Date.parse(now)) {
      const verified = this.store.claimOccurrence({ occurrenceId: occurrence.occurrenceId, workerId: occurrence.workerId, claimToken: occurrence.claimToken })
      if (verified?.workerId === occurrence.workerId && verified.claimToken === occurrence.claimToken && verified.leaseUntil === occurrence.leaseUntil) return {
        occurrenceId: occurrence.occurrenceId,
        workerId: occurrence.workerId,
        claimToken: occurrence.claimToken,
        leaseUntil: occurrence.leaseUntil,
      }
    }
    const claimed = this.store.claimOccurrence({ occurrenceId: occurrence.occurrenceId, workerId: this.workerId, leaseMs: DEFAULT_CLAIM_LEASE_MS })
    if (!claimed?.claimToken || !claimed.leaseUntil) return null
    return { occurrenceId: claimed.occurrenceId, workerId: claimed.workerId!, claimToken: claimed.claimToken, leaseUntil: claimed.leaseUntil }
  }

  private isGenerationCurrent(generation: number): boolean {
    return !this.closed && !this.stopping && generation === this.lifecycleGeneration
  }

  private shouldFenceStrictGeneration(generation: number): boolean {
    return !this.isGenerationCurrent(generation)
      && (!this.stopping || this.timedOutGenerations.has(generation))
  }

  private async recoverRuns(generation: number): Promise<void> {
    for (const run of this.allRuns()) {
      if (!this.isGenerationCurrent(generation)) return
      try {
        const routine = this.store.get(run.routineId)
      const cancelReason = !routine || routine.lifecycle === 'deleted'
        ? 'routine-deleted'
        : routine.lifecycle === 'paused'
          ? 'routine-paused'
          : null
      if (cancelReason && (run.state.kind === 'queued' || run.state.kind === 'claimed' || run.state.kind === 'awaiting-approval')) {
        const approvalId = run.state.kind === 'awaiting-approval' ? run.state.approvalId : undefined
        const transition = this.transitionWithOwnership(run.runId, run.version, {
          kind: 'cancelled',
          at: timestamp(this.clock),
          reason: cancelReason,
        })
        const cancelled = transition.run
        if (!transition.committed || !cancelled || cancelled.state.kind !== 'cancelled') continue
        await this.publish(cancelled)
        if (!this.isGenerationCurrent(generation)) return
        await this.cleanupApproval(cancelled, approvalId, generation)
        if (!this.isGenerationCurrent(generation)) return
        this.notify(cancelled.routineId)
        continue
      }
      if (run.state.kind === 'awaiting-approval') {
        const attempt = this.readApprovalAttempt(run.runId)
        const validAttempt = attempt
          && attempt.approvalId === run.state.approvalId
          && attempt.operationHash === run.state.operationHash
          && attempt.version === run.state.version
        if (validAttempt) {
          try {
            const approvalStatus = await this.executeAdapter.validateApproval?.(attempt)
            if (!this.isGenerationCurrent(generation)) return
            if (approvalStatus === 'allowed' || approvalStatus === 'consumed') {
              if (!attempt.requestId) {
                await this.publish(run)
                if (!this.isGenerationCurrent(generation)) return
                continue
              }
              await this.executeAdapter.claimApproval?.(attempt)
              if (!this.isGenerationCurrent(generation)) return
              await this.executeAdapter.resolveApproval?.(attempt, true)
              if (!this.isGenerationCurrent(generation)) return
              const claim = this.claimForRun(run)
              if (!this.isGenerationCurrent(generation)) return
              if (!claim) continue
              const transition = this.transitionWithOwnership(run.runId, run.version, { kind: 'running', at: timestamp(this.clock) }, { claim })
              if (!this.isGenerationCurrent(generation)) return
              if (transition.committed && transition.run?.state.kind === 'running') {
                await this.dispatchOwned(transition.run, generation, true)
                if (!this.isGenerationCurrent(generation)) return
              }
              continue
            }
            if (approvalStatus === 'denied' || approvalStatus === 'expired' || approvalStatus === 'stale') {
              const transition = this.transitionWithOwnership(run.runId, run.version, {
                kind: 'cancelled',
                at: timestamp(this.clock),
                reason: `approval-${approvalStatus}`,
              })
              const cancelled = transition.run
              if (!transition.committed || !cancelled || cancelled.state.kind !== 'cancelled') continue
              await this.publish(cancelled)
              if (!this.isGenerationCurrent(generation)) return
              await this.cleanupApproval(cancelled, run.state.approvalId, generation)
              if (!this.isGenerationCurrent(generation)) return
              this.notify(cancelled.routineId)
              continue
            }
            await this.publish(run)
            if (!this.isGenerationCurrent(generation)) return
            continue
          } catch {
            // Fall through to the durable uncertain state below.
          }
        }
        await this.markApprovalUncertain(run, 'approval execution record is missing or invalid after restart', generation)
        if (!this.isGenerationCurrent(generation)) return
        continue
      }
      if (run.state.kind === 'running') {
        const transition = this.transitionWithOwnership(run.runId, run.version, {
          kind: 'uncertain',
          at: timestamp(this.clock),
          reason: 'server-restarted-during-execution',
        })
        const uncertain = transition.run
        if (!transition.committed || !uncertain || uncertain.state.kind !== 'uncertain') continue
        await this.publish(uncertain)
        if (!this.isGenerationCurrent(generation)) return
        await this.cleanupApproval(uncertain, undefined, generation)
        if (!this.isGenerationCurrent(generation)) return
        this.notify(uncertain.routineId)
        continue
      }
      if (run.state.kind === 'claimed' && Date.parse(run.state.leaseUntil) <= Date.parse(timestamp(this.clock))) {
        const transition = this.transitionWithOwnership(run.runId, run.version, { kind: 'queued', at: timestamp(this.clock) })
        if (!this.isGenerationCurrent(generation)) return
        if (transition.committed && transition.run?.state.kind === 'queued') {
          await this.dispatch(transition.run, generation, true)
          if (!this.isGenerationCurrent(generation)) return
        }
        continue
      }
      if (run.state.kind === 'queued') {
        void this.trackStartupRecovery(this.dispatch(run, generation, true)).catch(() => undefined)
        continue
      }
        if (run.state.kind === 'succeeded' || run.state.kind === 'failed' || run.state.kind === 'cancelled' || run.state.kind === 'uncertain' || run.state.kind === 'reconciled') {
          await this.cleanupApproval(run, undefined, generation)
          if (!this.isGenerationCurrent(generation)) return
          await this.publish(run)
          if (!this.isGenerationCurrent(generation)) return
        }
      } catch (error) {
        await this.markRecoveryFailure(run, error, generation)
        if (!this.isGenerationCurrent(generation)) return
      }
    }
  }

  private async markRecoveryFailure(run: RoutineRun, error: unknown, generation = this.lifecycleGeneration): Promise<void> {
    if (!this.isGenerationCurrent(generation)) return
    const current = this.store.getRun(run.runId)
    if (!current || current.state.kind === 'succeeded' || current.state.kind === 'failed' || current.state.kind === 'cancelled' || current.state.kind === 'uncertain' || current.state.kind === 'reconciled') return
    const reason = error instanceof Error ? `routine-recovery-failed: ${error.message}` : 'routine-recovery-failed'
    const transitioned = current.state.kind === 'running'
      ? this.transitionAfterExecution(current.runId, current.version, { kind: 'uncertain', at: timestamp(this.clock), reason })
      : this.transitionWithLifecycle(current.runId, current.version, { kind: 'uncertain', at: timestamp(this.clock), reason })
    if (!transitioned) return
    try { await this.publish(transitioned) } catch { /* retain durable uncertain state */ }
    if (!this.isGenerationCurrent(generation)) return
    await this.cleanupApproval(transitioned, undefined, generation)
    if (!this.isGenerationCurrent(generation)) return
    this.notify(transitioned.routineId)
  }

  private async reconcileApproval(run: RoutineRun, generation: number): Promise<void> {
    if (!this.executeAdapter.validateApproval) return
    const current = this.store.getRun(run.runId)
    if (!current || current.state.kind !== 'awaiting-approval') return
    const attempt = this.readApprovalAttempt(current.runId)
    if (!attempt || attempt.approvalId !== current.state.approvalId || attempt.operationHash !== current.state.operationHash || attempt.version !== current.state.version) {
      await this.markApprovalUncertain(current, 'approval execution record is missing or invalid', generation)
      return
    }
    let status: Awaited<ReturnType<NonNullable<RoutineExecutor['validateApproval']>>>
    try {
      status = await this.executeAdapter.validateApproval(attempt)
    } catch {
      await this.markApprovalUncertain(current, 'approval execution record could not be validated', generation)
      return
    }
    if (status === 'pending') return
    if (status === 'allowed' || status === 'consumed') {
      if (!attempt.requestId) {
        if (!this.isGenerationCurrent(generation)) return
        this.rememberApprovalResolution(current.state.approvalId, true)
        return
      }
      await this.resolveApprovalOnce(current, true, generation)
      return
    }
    await this.resolveApprovalOnce(current, false, generation)
  }

  private async cleanupApproval(run: RoutineRun, approvalId?: string, generation?: number): Promise<boolean> {
    try {
      if (generation !== undefined && !this.isGenerationCurrent(generation)) return false
      const attempt = this.readApprovalAttempt(run.runId)
      const matchingAttempt = attempt && (!approvalId || attempt.approvalId === approvalId) ? attempt : null
      if (matchingAttempt) {
        if (this.executeAdapter.resolveApproval) await this.executeAdapter.resolveApproval(matchingAttempt, false)
        else if (this.executeAdapter.denyApproval) await this.executeAdapter.denyApproval(matchingAttempt.approvalId)
        else return false
      } else if (approvalId && this.executeAdapter.denyApproval) {
        await this.executeAdapter.denyApproval(approvalId)
      } else {
        return false
      }
      if (generation !== undefined && !this.isGenerationCurrent(generation)) return false
      const cleanupApprovalId = matchingAttempt?.approvalId ?? approvalId
      if (!cleanupApprovalId) return false
      this.removeApprovalAttempt(run.runId, cleanupApprovalId)
      return true
    } catch {
      return false
    }
  }

  private async markApprovalUncertain(run: RoutineRun, reason: string, generation = this.lifecycleGeneration): Promise<void> {
    if (!this.isGenerationCurrent(generation)) return
    const current = this.store.getRun(run.runId)
    if (!current || current.state.kind !== 'awaiting-approval') return
    if (!this.isGenerationCurrent(generation)) return
    await this.cleanupApproval(current, current.state.approvalId, generation)
    if (!this.isGenerationCurrent(generation)) return
    const uncertain = this.transitionWithLifecycle(current.runId, current.version, {
      kind: 'uncertain',
      at: timestamp(this.clock),
      reason,
    })
    if (!uncertain) return
    if (uncertain.state.kind === 'cancelled') {
      await this.publish(uncertain)
      if (!this.isGenerationCurrent(generation)) return
      this.notify(uncertain.routineId)
      return
    }
    await this.publish(uncertain)
    if (!this.isGenerationCurrent(generation)) return
    this.notify(uncertain.routineId)
  }

  private async triggerOccurrence(input: RecordOccurrenceInput & { readonly occurredAt?: string; readonly origin?: RoutineRun['origin'] }): Promise<RoutineRun | null> {
    const occurrence = this.store.recordOccurrence(input)
    const origin = input.origin && input.origin.kind === 'replay'
      ? { ...input.origin, occurrenceId: occurrence.occurrenceId }
      : { kind: 'triggered' as const, occurrenceId: occurrence.occurrenceId }
    const run = this.ensureRunForOccurrence(occurrence, origin)
    if (!run) return null
    this.notify(run.routineId)
    await this.dispatch(run)
    return this.store.getRun(run.runId)
  }

  private ensureRunForOccurrence(occurrence: ReturnType<RoutineStore['recordOccurrence']>, origin?: RoutineRun['origin']): RoutineRun | null {
    const deterministicRunId = deriveRoutineRunId(occurrence.occurrenceId)
    const existing = this.store.getRun(deterministicRunId)
    if (existing) {
      this.store.repairOccurrenceRunPointer(occurrence.occurrenceId, deterministicRunId)
      return existing
    }
    const claimed = this.store.claimOccurrence({ occurrenceId: occurrence.occurrenceId, workerId: this.workerId, leaseMs: DEFAULT_CLAIM_LEASE_MS })
    if (!claimed) return this.store.getRun(deterministicRunId)
    try {
      const routine = this.store.get(occurrence.routineId)
      if (!routine) return null
      return this.store.createRun({
        occurrenceId: occurrence.occurrenceId,
        ownerBotId: routine.ownerBotId,
        ...(origin ? { origin } : {}),
      })
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Routine is not enabled:')) return null
      throw error
    }
  }

  private async dispatch(run: RoutineRun, generation = this.lifecycleGeneration, strictGeneration = false): Promise<RoutineRun> {
    const existing = this.inFlight.get(run.runId)
    if (existing) return existing
    const current = this.store.getRun(run.runId)
    if (!current) return run
    if (current.state.kind === 'running') return current
    const promise = this.dispatchOwned(current, generation, strictGeneration)
    this.inFlight.set(run.runId, promise)
    try {
      return await promise
    } catch (error) {
      if (isRoutineTransitionRace(error)) return this.store.getRun(run.runId) ?? current
      await this.markRecoveryFailure(current, error, generation)
      return this.store.getRun(run.runId) ?? current
    } finally {
      if (this.inFlight.get(run.runId) === promise) this.inFlight.delete(run.runId)
    }
  }

  private async dispatchOwned(initial: RoutineRun, generation: number, strictGeneration = false): Promise<RoutineRun> {
    let current = this.store.getRun(initial.runId)
    if (!current) return initial
    if (this.stopping || generation !== this.lifecycleGeneration) return current
    const cleanupGeneration = strictGeneration ? generation : undefined
    const routine = this.store.get(current.routineId)
    if (!routine || routine.lifecycle !== 'enabled') {
      if (current.state.kind === 'running') {
        const cancelled = this.transitionIfCurrent(current.runId, current.version, {
          kind: 'cancelled',
          at: timestamp(this.clock),
          reason: routine?.lifecycle === 'deleted' ? 'routine-deleted' : 'routine-paused',
        })
        if (!cancelled || cancelled.state.kind !== 'cancelled') return cancelled ?? current
        await this.publish(cancelled)
        if (strictGeneration && this.shouldFenceStrictGeneration(generation)) return this.store.getRun(current.runId) ?? current
        await this.cleanupApproval(cancelled, undefined, cleanupGeneration)
        this.notify(cancelled.routineId)
        return cancelled
      }
      return current
    }
    const revision = this.store.getRevision(current.routineId, current.routineRevision)

    if (current.state.kind === 'queued') {
      const claim = this.store.claimOccurrence({ occurrenceId: current.origin.occurrenceId, workerId: this.workerId, leaseMs: DEFAULT_CLAIM_LEASE_MS })
      if (!claim) {
        if (!this.store.getOccurrence(current.origin.occurrenceId)) await this.markRecoveryFailure(current, new Error('Routine occurrence is unavailable'))
        return this.store.getRun(current.runId) ?? current
      }
      if (!claim.claimToken || !claim.leaseUntil) return current
      const claimed = this.transitionIfCurrent(current.runId, current.version, {
        kind: 'claimed',
        at: timestamp(this.clock),
        workerId: this.workerId,
        claimToken: claim.claimToken,
        leaseUntil: claim.leaseUntil,
      }, { claim: { occurrenceId: current.origin.occurrenceId, workerId: this.workerId, claimToken: claim.claimToken, leaseUntil: claim.leaseUntil } })
      if (!claimed) return current
      current = claimed
    }
    if (current.state.kind === 'claimed') {
      const now = timestamp(this.clock)
      if (current.state.workerId !== this.workerId || Date.parse(current.state.leaseUntil) <= Date.parse(now)) {
        if (current.state.workerId !== this.workerId && Date.parse(current.state.leaseUntil) > Date.parse(now)) return current
        const claim = this.store.claimOccurrence({ occurrenceId: current.origin.occurrenceId, workerId: this.workerId, leaseMs: DEFAULT_CLAIM_LEASE_MS })
        if (!claim) {
          if (!this.store.getOccurrence(current.origin.occurrenceId)) await this.markRecoveryFailure(current, new Error('Routine occurrence is unavailable'))
          return this.store.getRun(current.runId) ?? current
        }
        if (!claim.claimToken || !claim.leaseUntil) return current
        const running = this.transitionIfCurrent(current.runId, current.version, { kind: 'running', at: timestamp(this.clock) }, {
          claim: { occurrenceId: current.origin.occurrenceId, workerId: this.workerId, claimToken: claim.claimToken, leaseUntil: claim.leaseUntil },
        })
        if (!running) return current
        current = running
      } else {
        if (!current.state.claimToken || !current.state.leaseUntil) return current
        const running = this.transitionIfCurrent(current.runId, current.version, { kind: 'running', at: timestamp(this.clock) }, {
          claim: { occurrenceId: current.origin.occurrenceId, workerId: current.state.workerId, claimToken: current.state.claimToken, leaseUntil: current.state.leaseUntil },
        })
        if (!running) return current
        current = running
      }
    }
    if (current.state.kind !== 'running') return current

    let result: RoutineExecutionResult
    try {
      result = await this.executeAdapter.execute(current, revision)
    } catch {
      result = { kind: 'failed', error: 'Routine executor failed' }
    }
    if (result.kind === 'completed' && !result.reply.trim()) {
      result = { kind: 'uncertain', reason: 'Routine completed without a result' }
    }
    const bufferedResolution = result.kind === 'awaiting-approval'
      ? undefined
      : this.takeBufferedApprovalResolution(current.runId)

    const liveRoutine = this.store.get(current.routineId)
    if (strictGeneration && this.shouldFenceStrictGeneration(generation)) return this.store.getRun(current.runId) ?? current
    if (this.timedOutGenerations.has(generation)) {
      const shutdownAttempt = result.kind === 'awaiting-approval'
        ? {
            schemaVersion: 1 as const,
            runId: current.runId,
            approvalId: result.approvalId,
            operationHash: result.operationHash,
            version: result.version,
            invocation: result.invocation,
            sessionId: result.invocation.runtimeId,
            ...(result.requestId ? { requestId: result.requestId } : {}),
            createdAt: timestamp(this.clock),
          }
        : null
      if (shutdownAttempt) this.writeApprovalAttempt(shutdownAttempt)
      const uncertain = this.transitionIfCurrent(current.runId, current.version, {
        kind: 'uncertain',
        at: timestamp(this.clock),
        reason: 'server-shutdown-during-execution',
      })
      if (!uncertain) return current
      current = uncertain
      await this.publish(current)
      if (strictGeneration && this.shouldFenceStrictGeneration(generation)) return this.store.getRun(current.runId) ?? current
      await this.cleanupApproval(current, shutdownAttempt?.approvalId, cleanupGeneration)
      this.notify(current.routineId)
      return current
    }
    if (!liveRoutine || liveRoutine.lifecycle !== 'enabled') {
      const cancellationAttempt = result.kind === 'awaiting-approval'
        ? {
            schemaVersion: 1 as const,
            runId: current.runId,
            approvalId: result.approvalId,
            operationHash: result.operationHash,
            version: result.version,
            invocation: result.invocation,
            sessionId: result.invocation.runtimeId,
            ...(result.requestId ? { requestId: result.requestId } : {}),
            createdAt: timestamp(this.clock),
          }
        : null
      const cancellationApprovalId = cancellationAttempt?.approvalId ?? bufferedResolution?.approvalId
      if (cancellationAttempt) this.writeApprovalAttempt(cancellationAttempt)
      const cancelled = this.transitionIfCurrent(current.runId, current.version, {
        kind: 'cancelled',
        at: timestamp(this.clock),
        reason: liveRoutine?.lifecycle === 'deleted' ? 'routine-deleted' : 'routine-paused',
      })
      if (!cancelled) return current
      current = cancelled
      await this.publish(current)
      if (strictGeneration && this.shouldFenceStrictGeneration(generation)) return this.store.getRun(current.runId) ?? current
      await this.cleanupApproval(current, cancellationApprovalId, cleanupGeneration)
      this.notify(current.routineId)
      return current
    }

    if (bufferedResolution?.allowed === false) {
      const cancelled = this.transitionIfCurrent(current.runId, current.version, {
        kind: 'cancelled',
        at: timestamp(this.clock),
        reason: 'approval-denied',
      })
      if (!cancelled) return current
      current = cancelled
      await this.publish(current)
      if (strictGeneration && this.shouldFenceStrictGeneration(generation)) return this.store.getRun(current.runId) ?? current
      await this.cleanupApproval(current, bufferedResolution.approvalId, cleanupGeneration)
      this.notify(current.routineId)
      return current
    }

    if (result.kind === 'awaiting-approval') {
      const bufferedRequest = this.approvalRequestIds.get(current.runId)
      if (bufferedRequest && (
        bufferedRequest.approvalId !== result.approvalId
        || (result.requestId !== undefined && bufferedRequest.requestId !== result.requestId)
      )) {
        this.approvalRequestIds.delete(current.runId)
        const uncertain = this.transitionAfterExecution(current.runId, current.version, {
          kind: 'uncertain',
          at: timestamp(this.clock),
          reason: 'approval request identity is inconsistent with the execution result',
        })
        if (!uncertain) return current
        current = uncertain
        await this.publish(current)
        if (strictGeneration && this.shouldFenceStrictGeneration(generation)) return this.store.getRun(current.runId) ?? current
        await this.cleanupApproval(current, result.approvalId, cleanupGeneration)
        this.notify(current.routineId)
        return current
      }
      if (!result.invocation) {
        const uncertain = this.transitionAfterExecution(current.runId, current.version, {
          kind: 'uncertain',
          at: timestamp(this.clock),
          reason: 'approval execution record is missing before persistence',
        })
        if (!uncertain) return current
        current = uncertain
        await this.publish(current)
        if (strictGeneration && this.shouldFenceStrictGeneration(generation)) return this.store.getRun(current.runId) ?? current
        await this.cleanupApproval(current, undefined, cleanupGeneration)
      } else {
        const requestId = result.requestId ?? bufferedRequest?.requestId
        this.writeApprovalAttempt({
          schemaVersion: 1,
          runId: current.runId,
          approvalId: result.approvalId,
          operationHash: result.operationHash,
          version: result.version,
          invocation: result.invocation,
          sessionId: result.invocation.runtimeId,
          ...(requestId ? { requestId } : {}),
          createdAt: timestamp(this.clock),
        })
        this.approvalRequestIds.delete(current.runId)
        const awaiting = this.transitionAfterExecution(current.runId, current.version, {
          kind: 'awaiting-approval',
          at: timestamp(this.clock),
          approvalId: result.approvalId,
          operationHash: result.operationHash,
          version: result.version,
        })
        if (!awaiting) return current
        current = awaiting
        await this.publish(current)
        if (strictGeneration && this.shouldFenceStrictGeneration(generation)) return this.store.getRun(current.runId) ?? current
        if (current.state.kind !== 'awaiting-approval') {
          await this.cleanupApproval(current, result.approvalId, cleanupGeneration)
          this.notify(current.routineId)
          return current
        }
        const resolved = this.resolvedApprovals.get(result.approvalId)
        const attempt = resolved === true ? this.readApprovalAttempt(current.runId) : null
        if (resolved !== undefined && (
          !resolved
          || !this.isApprovalAttemptForRun(current, attempt)
          || !!attempt?.requestId
        )) {
          this.resolvedApprovals.delete(result.approvalId)
          const settled = await this.resolveApprovalOnce(current, resolved, generation)
          if (settled) current = this.store.getRun(settled.runId) ?? current
        }
      }
    } else if (result.kind === 'completed') {
      const succeeded = this.transitionAfterExecution(current.runId, current.version, { kind: 'succeeded', at: timestamp(this.clock), result: result.reply })
      if (!succeeded) return current
      current = succeeded
      await this.publish(current)
      if (strictGeneration && this.shouldFenceStrictGeneration(generation)) return this.store.getRun(current.runId) ?? current
    } else if (result.kind === 'failed' && revision.failurePolicy === 'retry' && current.attempt < 2) {
      // ponytail: one automatic retry; raise the persisted attempt ceiling with
      // an explicit policy and idempotent provider operation when needed.
      const retried = this.transitionAfterExecution(current.runId, current.version, { kind: 'queued', at: timestamp(this.clock) }, current.attempt + 1)
      if (!retried) return current
      current = await this.dispatchOwned(retried, generation, strictGeneration)
    } else if (result.kind === 'uncertain' || revision.failurePolicy === 'uncertain') {
      const reason = result.kind === 'uncertain' ? result.reason : result.error
      const uncertain = this.transitionAfterExecution(current.runId, current.version, { kind: 'uncertain', at: timestamp(this.clock), reason })
      if (!uncertain) return current
      current = uncertain
      await this.publish(current)
      if (strictGeneration && this.shouldFenceStrictGeneration(generation)) return this.store.getRun(current.runId) ?? current
    } else {
      const failed = this.transitionAfterExecution(current.runId, current.version, { kind: 'failed', at: timestamp(this.clock), error: result.error })
      if (!failed) return current
      current = failed
      await this.publish(current)
      if (strictGeneration && this.shouldFenceStrictGeneration(generation)) return this.store.getRun(current.runId) ?? current
    }
    if (current.state.kind === 'succeeded' || current.state.kind === 'failed' || current.state.kind === 'cancelled' || current.state.kind === 'uncertain' || current.state.kind === 'reconciled') {
      await this.cleanupApproval(current, undefined, cleanupGeneration)
    }
    if (strictGeneration && this.shouldFenceStrictGeneration(generation)) return this.store.getRun(current.runId) ?? current
    this.notify(current.routineId)
    return current
  }

  private publicRoutine(routineId: RoutineId): RoutinePublicDto {
    const dto = this.store.getPublic(routineId)
    if (dto.lifecycle !== 'enabled' || dto.revision.trigger.kind !== 'schedule') return dto
    const cursor = this.store.getScheduleCursor(dto.routineId, dto.activeRevision) ?? dto.revision.createdAt
    const nextRunAt = nextScheduledInstant(dto.revision.trigger, cursor)
    return nextRunAt ? { ...dto, nextRunAt } : dto
  }

  private cancelNonRunningRuns(routineId: RoutineId, reason = 'routine-paused'): void {
    for (const run of this.store.listRuns(routineId)) {
      if (run.state.kind !== 'queued' && run.state.kind !== 'claimed' && run.state.kind !== 'awaiting-approval') continue
      const cancelled = this.transitionIfCurrent(run.runId, run.version, {
        kind: 'cancelled',
        at: timestamp(this.clock),
        reason,
      })
      if (!cancelled || cancelled.state.kind !== 'cancelled') continue
      void this.publish(cancelled).catch(() => undefined)
      void this.trackApprovalRecovery(this.cleanupApproval(cancelled, run.state.kind === 'awaiting-approval' ? run.state.approvalId : undefined))
    }
  }

  private async publish(run: RoutineRun): Promise<void> {
    const routine = this.store.get(run.routineId)
    if (!routine) return
    const revision = this.store.getRevision(run.routineId, run.routineRevision)
    await this.executeAdapter.publish?.(run, revision)
  }

  private async applyApprovalResolution(run: RoutineRun, allowed: boolean, generation = this.lifecycleGeneration): Promise<RoutineRun | null> {
    if (run.state.kind !== 'awaiting-approval') return null
    if (this.stopping || generation !== this.lifecycleGeneration) return this.store.getRun(run.runId)
    const routine = this.store.get(run.routineId)
    if (!routine || routine.lifecycle !== 'enabled') {
      const cancelled = this.transitionIfCurrent(run.runId, run.version, {
        kind: 'cancelled',
        at: timestamp(this.clock),
        reason: routine?.lifecycle === 'deleted' ? 'routine-deleted' : 'routine-paused',
      })
      if (!cancelled || cancelled.state.kind !== 'cancelled') return cancelled
      await this.publish(cancelled)
      if (!this.isGenerationCurrent(generation)) return this.store.getRun(run.runId)
      await this.cleanupApproval(cancelled, run.state.approvalId, generation)
      if (!this.isGenerationCurrent(generation)) return this.store.getRun(run.runId)
      this.notify(cancelled.routineId)
      return cancelled
    }
    if (!allowed) {
      const cancelled = this.transitionIfCurrent(run.runId, run.version, {
        kind: 'cancelled',
        at: timestamp(this.clock),
        reason: 'approval-denied',
      })
      if (!cancelled || cancelled.state.kind !== 'cancelled') return cancelled
      await this.publish(cancelled)
      if (!this.isGenerationCurrent(generation)) return this.store.getRun(run.runId)
      await this.cleanupApproval(cancelled, run.state.approvalId, generation)
      if (!this.isGenerationCurrent(generation)) return this.store.getRun(run.runId)
      this.notify(cancelled.routineId)
      return cancelled
    }
    const attempt = this.readApprovalAttempt(run.runId)
    if (!this.isApprovalAttemptForRun(run, attempt)) {
      await this.markApprovalUncertain(run, 'approval execution record is missing or invalid', generation)
      return this.store.getRun(run.runId)
    }
    if (!attempt.requestId) {
      this.rememberApprovalResolution(run.state.approvalId, true)
      return run
    }
    try {
      await this.executeAdapter.claimApproval?.(attempt)
    } catch {
      if (this.stopping || generation !== this.lifecycleGeneration) return this.store.getRun(run.runId)
      const uncertain = this.transitionIfCurrent(run.runId, run.version, {
        kind: 'uncertain',
        at: timestamp(this.clock),
        reason: 'approval execution record could not be claimed',
      })
      if (!uncertain || uncertain.state.kind !== 'uncertain') return uncertain
      await this.publish(uncertain)
      if (!this.isGenerationCurrent(generation)) return this.store.getRun(run.runId)
      await this.cleanupApproval(uncertain, run.state.approvalId, generation)
      if (!this.isGenerationCurrent(generation)) return this.store.getRun(run.runId)
      this.notify(uncertain.routineId)
      return uncertain
    }
    await this.resumeAfterApprovalOwned(run.runId, run.version, true, generation)
    return this.store.getRun(run.runId)
  }

  private findRunByApproval(approvalId: string): RoutineRun | null {
    for (const run of this.allRuns()) {
      if (run.state.kind === 'awaiting-approval' && run.state.approvalId === approvalId) return run
    }
    return null
  }

  private allRuns(): RoutineRun[] {
    return this.store.listAllRuns()
  }

  private isApprovalAttemptForRun(run: RoutineRun, attempt: RoutineApprovalAttempt | null): attempt is RoutineApprovalAttempt {
    return run.state.kind === 'awaiting-approval'
      && attempt !== null
      && attempt.approvalId === run.state.approvalId
      && attempt.operationHash === run.state.operationHash
      && attempt.version === run.state.version
  }

  private approvalAttemptPath(runId: RoutineRunId): string {
    return join(this.store.rootPath, 'approval-attempts', `${runId}.json`)
  }

  private writeApprovalAttempt(attempt: RoutineApprovalAttempt): void {
    const path = this.approvalAttemptPath(attempt.runId)
    withDurableLock(`${path}.lock`, (lockToken) => {
      const run = this.store.getRun(attempt.runId)
      if (!run || (run.state.kind !== 'running' && run.state.kind !== 'awaiting-approval')) throw new Error('Routine approval execution record is no longer owned')
      const existing = this.readApprovalAttempt(attempt.runId, lockToken)
      if (existing && (existing.approvalId !== attempt.approvalId || existing.operationHash !== attempt.operationHash || existing.version !== attempt.version)) throw new Error('Routine approval execution record changed')
      if (existing?.requestId !== undefined && attempt.requestId !== undefined && existing.requestId !== attempt.requestId) throw new Error('Routine approval request identity changed')
      const next = attempt.requestId === undefined && existing?.requestId !== undefined ? { ...attempt, requestId: existing.requestId } : attempt
      assertDurableLock(`${path}.lock`, lockToken)
      writeJsonRecord(path, next)
      assertDurableLock(`${path}.lock`, lockToken)
    })
  }

  private removeApprovalAttempt(runId: RoutineRunId, approvalId: string): void {
    const path = this.approvalAttemptPath(runId)
    withDurableLock(`${path}.lock`, (lockToken) => {
      const current = this.readApprovalAttempt(runId, lockToken)
      if (current && current.approvalId === approvalId) {
        assertDurableLock(`${path}.lock`, lockToken)
        removePointer(path)
      }
    })
  }

  private readApprovalAttempt(runId: RoutineRunId, existingLockToken?: string): RoutineApprovalAttempt | null {
    const path = this.approvalAttemptPath(runId)
    const lockPath = `${path}.lock`
    const read = (lockToken: string): RoutineApprovalAttempt | null => {
      if (!existsSync(path)) return null
      let value: unknown
      try {
        assertRegularFile(path, 'Routine approval execution record')
        value = readJsonFile(path)
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Routine approval execution record is corrupt')
        const candidate = value as Partial<RoutineApprovalAttempt> & { invocation?: unknown }
        if (
          candidate.schemaVersion !== 1
          || candidate.runId !== runId
          || typeof candidate.approvalId !== 'string'
          || !/^approval_[A-Za-z0-9_-]{1,254}$/.test(candidate.approvalId)
          || typeof candidate.operationHash !== 'string'
          || !candidate.operationHash
          || !Number.isSafeInteger(candidate.version)
          || (candidate.version as number) < 1
          || !candidate.invocation
          || typeof candidate.invocation !== 'object'
          || Array.isArray(candidate.invocation)
          || typeof candidate.sessionId !== 'string'
          || !candidate.sessionId
          || (candidate.requestId !== undefined && (typeof candidate.requestId !== 'string' || !candidate.requestId))
          || typeof candidate.createdAt !== 'string'
          || !Number.isFinite(Date.parse(candidate.createdAt))
        ) throw new Error('Routine approval execution record is corrupt')
        const invocation = candidate.invocation as Partial<ToolInvocation> & { target?: unknown }
        if (
          invocation.workspaceId !== this.workspaceId
          || typeof invocation.botId !== 'string' || !invocation.botId
          || typeof invocation.conversationId !== 'string' || !invocation.conversationId
          || typeof invocation.runtimeId !== 'string' || !invocation.runtimeId
          || typeof invocation.toolName !== 'string' || !invocation.toolName
          || typeof invocation.toolSchemaVersion !== 'string' || !invocation.toolSchemaVersion
          || !invocation.normalizedInput || typeof invocation.normalizedInput !== 'object' || Array.isArray(invocation.normalizedInput)
          || !Number.isSafeInteger(invocation.attempt) || (invocation.attempt as number) < 1
          || !invocation.target || typeof invocation.target !== 'object' || Array.isArray(invocation.target)
          || typeof invocation.policyRevision !== 'string' || !invocation.policyRevision
          || candidate.sessionId !== invocation.runtimeId
        ) throw new Error('Routine approval execution record is corrupt')
        const target = invocation.target as unknown as Record<string, unknown>
        if (typeof target.kind !== 'string' || !target.kind || typeof target.value !== 'string' || !target.value || typeof target.fingerprint !== 'string' || !target.fingerprint) throw new Error('Routine approval execution record is corrupt')
        if (computeOperationHash(invocation as ToolInvocation) !== candidate.operationHash) throw new Error('Routine approval execution record is corrupt')
        return { ...candidate, invocation: invocation as ToolInvocation } as RoutineApprovalAttempt
      } catch (error) {
        if (!existsSync(path)) return null
        try {
          assertDurableLock(lockPath, lockToken)
          if (value !== undefined) {
            assertRegularFile(path, 'Routine approval execution record')
            if (!isDeepStrictEqual(readJsonFile(path), value)) return null
          }
          renameSync(path, `${path}.corrupt-${randomUUID()}`)
        } catch {
          // Preserve a changed or concurrently removed artifact.
        }
        return null
      }
    }
    return existingLockToken ? read(existingLockToken) : withDurableLock(lockPath, read)
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Routine engine is closed')
  }

  private notify(routineId?: RoutineId): void {
    try { this.onChanged?.(routineId) } catch { /* notification follows durable state */ }
  }
}
