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
  type CreateRoutineInput,
  type RecordOccurrenceInput,
  type UpdateRoutineInput,
  toRoutineRunPublicDto,
  nextScheduledInstant,
  scheduledInstantsBetween,
} from '@kata-sh/shared/routines'
import { readJsonFile, removePointer, writeJsonRecord } from '@kata-sh/shared/conversations'

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

export function routineEventMatches(payload: unknown, matcher: RoutineEventMatcher): boolean {
  const value = getField(payload, matcher.field)
  if (matcher.equals !== undefined) {
    return typeof value === 'string' && value === matcher.equals
  }
  if (matcher.matches !== undefined) {
    return typeof value === 'string' && new RegExp(matcher.matches).test(value)
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
  private legacyTickPromise: Promise<void> | null = null
  private tickPromise: Promise<void> | null = null
  private started = false
  private startPromise: Promise<void> | null = null
  private readonly resolvedApprovals = new Map<string, boolean>()
  private readonly approvalRequestIds = new Map<RoutineRunId, { approvalId: string; requestId: string }>()
  private readonly approvalResolutions = new Map<RoutineRunId, Promise<RoutineRunPublicDto | null>>()
  private readonly inFlight = new Map<string, Promise<RoutineRun>>()
  private readonly approvalRecovery = new Set<Promise<unknown>>()
  private stopping = false
  private shutdownTimedOut = false

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
    this.onChanged = options.onChanged
  }

  isRunning(): boolean {
    return this.started && !this.stopping
  }

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise
    if (this.started) return
    this.stopping = false
    this.shutdownTimedOut = false
    this.startPromise = this.startOwned().catch(error => {
      this.started = false
      this.startPromise = null
      throw error
    })
    return this.startPromise
  }

  private async startOwned(): Promise<void> {
    this.started = true
    this.store.recover()
    await this.recoverRuns()
    await this.tick()
    this.timer = setInterval(() => {
      const now = timestamp(this.clock)
      const promise = this.emitLegacyScheduleTick(now)
        .then(() => this.tick(now))
        .catch(() => undefined)
      this.legacyTickPromise = promise
      void promise.then(() => {
        if (this.legacyTickPromise === promise) this.legacyTickPromise = null
      })
    }, this.tickIntervalMs)
    if (typeof this.timer === 'object' && 'unref' in this.timer) this.timer.unref()
  }

  async stop(): Promise<void> {
    this.stopping = true
    await this.startPromise?.catch(() => undefined)
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.started = false
    this.startPromise = null
    // ponytail: cap shutdown drain at 5s; restart recovery marks unfinished runs uncertain.
    const deadline = Date.now() + SHUTDOWN_DRAIN_TIMEOUT_MS
    while (this.tickPromise || this.legacyTickPromise || this.inFlight.size > 0 || this.approvalRecovery.size > 0) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      const pending = [
        ...(this.tickPromise ? [this.tickPromise] : []),
        ...(this.legacyTickPromise ? [this.legacyTickPromise] : []),
        ...this.inFlight.values(),
        ...this.approvalRecovery,
      ]
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>(resolve => setTimeout(resolve, remaining)),
      ])
    }
    this.shutdownTimedOut = this.tickPromise !== null
      || this.legacyTickPromise !== null
      || this.inFlight.size > 0
      || this.approvalRecovery.size > 0
  }

  create(input: CreateRoutineInput): RoutinePublicDto {
    const record = this.store.create(input)
    this.notify(record.routineId)
    return this.publicRoutine(record.routineId)
  }

  update(routineId: RoutineId, input: UpdateRoutineInput): RoutinePublicDto {
    const record = this.store.update(routineId, input)
    this.notify(record.routineId)
    return this.publicRoutine(record.routineId)
  }

  enable(routineId: RoutineId): RoutinePublicDto {
    const record = this.store.enable(routineId)
    this.notify(record.routineId)
    void this.tick()
    return this.publicRoutine(record.routineId)
  }

  pause(routineId: RoutineId): RoutinePublicDto {
    const record = this.store.pause(routineId)
    this.cancelNonRunningRuns(record.routineId)
    this.notify(record.routineId)
    return this.publicRoutine(record.routineId)
  }

  delete(routineId: RoutineId): RoutinePublicDto {
    const record = this.store.delete(routineId)
    this.cancelNonRunningRuns(record.routineId, 'routine-deleted')
    this.notify(record.routineId)
    return this.publicRoutine(record.routineId)
  }

  get(routineId: RoutineId): RoutinePublicDto {
    return this.publicRoutine(routineId)
  }

  list(ownerBotId?: string): RoutinePublicDto[] {
    return this.store.list({ ownerBotId }).filter(record => record.lifecycle !== 'deleted').map(record => this.publicRoutine(record.routineId))
  }

  listRuns(routineId: RoutineId, limit = 50): RoutineRunPublicDto[] {
    if (!this.store.get(routineId)) throw new Error(`Routine not found: ${routineId}`)
    if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError('limit must be a non-negative safe integer')
    const runs = limit === 0 ? [] : this.store.listRuns(routineId).slice(-limit)
    return runs.reverse().map(toRoutineRunPublicDto)
  }

  async tick(now = timestamp(this.clock)): Promise<void> {
    if (this.tickPromise) return this.tickPromise
    const promise = this.tickOwned(now)
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

  private async tickOwned(now: string): Promise<void> {
    const due: Promise<unknown>[] = []
    for (const run of this.allRuns()) {
      if (run.state.kind === 'queued' || (run.state.kind === 'claimed' && run.state.leaseUntil <= now)) {
        due.push(this.dispatch(run))
      } else if (run.state.kind === 'awaiting-approval') {
        due.push(this.reconcileApproval(run))
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
        const occurrence = this.store.recordOccurrence({
          routineId: record.routineId,
          routineRevision: revision.revision,
          source: 'schedule',
          scheduledInstant,
        })
        const run = this.ensureRunForOccurrence(occurrence)
        if (run) scheduledRuns.push(run)
        else allRunsCreated = false
      }
      if (allRunsCreated && instants.length > 0) {
        this.store.advanceScheduleCursor(record.routineId, revision.revision, instants.at(-1)!)
      }
      for (const run of scheduledRuns) due.push(this.dispatch(run))
    }
    await Promise.allSettled(due)
  }

  async ingestEvent(event: RoutineEventInput): Promise<RoutineRunPublicDto[]> {
    if (typeof event.source !== 'string' || !event.source.trim()) throw new TypeError('source is required for routine events')
    if (typeof event.externalEventId !== 'string' || !event.externalEventId.trim()) {
      throw new TypeError('externalEventId is required for routine events')
    }
    const occurredAt = event.occurredAt === undefined ? timestamp(this.clock) : (() => {
      const parsed = Date.parse(event.occurredAt)
      if (!Number.isFinite(parsed)) throw new TypeError('occurredAt must be an ISO timestamp')
      return new Date(parsed).toISOString()
    })()
    const runs: RoutineRunPublicDto[] = []
    for (const record of this.store.list({ lifecycle: 'enabled' })) {
      const revision = this.store.getActiveRevision(record.routineId)
      if (
        revision.trigger.kind !== 'event'
        || revision.trigger.source !== event.source
        || !routineEventMatches(event.payload, revision.trigger.matcher)
      ) continue
      const run = await this.triggerOccurrence({
        routineId: record.routineId,
        routineRevision: revision.revision,
        source: event.source,
        externalEventId: event.externalEventId,
        occurredAt,
      })
      if (run) runs.push(toRoutineRunPublicDto(run))
    }
    return runs
  }

  async testRoutine(routineId: RoutineId): Promise<RoutineRunPublicDto> {
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
    const original = this.store.getRun(runId)
    if (!original) throw new Error(`Routine run not found: ${runId}`)
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
    const current = this.store.getRun(runId)
    if (this.stopping && current) return toRoutineRunPublicDto(current)
    if (!current) return this.resumeAfterApprovalOwned(runId, expectedVersion, false)
    const resumed = await this.trackApprovalRecovery(this.resumeApprovalOnce(current, expectedVersion))
    if (!resumed) throw new Error('Routine approval could not be resumed')
    return resumed
  }

  private trackApprovalRecovery<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() => this.approvalRecovery.delete(tracked))
    this.approvalRecovery.add(tracked)
    return tracked
  }

  private resumeAfterApprovalOwned(runId: RoutineRunId, expectedVersion: number, approvalClaimed: boolean): Promise<RoutineRunPublicDto> {
    return this.trackApprovalRecovery(this.resumeAfterApprovalWork(runId, expectedVersion, approvalClaimed))
  }

  private async resumeAfterApprovalWork(runId: RoutineRunId, expectedVersion: number, approvalClaimed: boolean): Promise<RoutineRunPublicDto> {
    const current = this.store.getRun(runId)
    if (!current) throw new Error(`Routine run not found: ${runId}`)
    if (current.version !== expectedVersion) throw new Error(`Routine run version conflict: expected ${expectedVersion}, current ${current.version}`)
    if (current.state.kind !== 'awaiting-approval') throw new Error('Routine run is not awaiting approval')
    const routine = this.store.get(current.routineId)
    if (!routine || routine.lifecycle !== 'enabled') return toRoutineRunPublicDto(current)
    const attempt = this.readApprovalAttempt(current.runId)
    if (!approvalClaimed) {
      if (!attempt || !this.executeAdapter.claimApproval) throw new Error('Routine approval execution record is unavailable')
      await this.executeAdapter.claimApproval(attempt)
    }
    if (attempt) await this.executeAdapter.resolveApproval?.(attempt, true)
    const running = this.store.transitionRun(current.runId, current.version, { kind: 'running', at: timestamp(this.clock) })
    await this.dispatchOwned(running)
    const latest = this.store.getRun(running.runId)
    if (!latest) throw new Error(`Routine run disappeared: ${running.runId}`)
    return toRoutineRunPublicDto(latest)
  }

  onApprovalRequest(runId: RoutineRunId, approvalId: string, requestId: string): boolean {
    if (this.stopping || typeof requestId !== 'string' || !requestId.trim()) return false
    const run = this.store.getRun(runId)
    const routine = run ? this.store.get(run.routineId) : null
    if (!run || !routine || routine.lifecycle !== 'enabled') return false
    if (run?.state.kind === 'awaiting-approval') {
      if (run.state.approvalId !== approvalId) return false
      const attempt = this.readApprovalAttempt(runId)
      if (attempt?.approvalId === approvalId) this.writeApprovalAttempt({ ...attempt, requestId })
      return true
    }
    if (run.state.kind === 'running') {
      this.approvalRequestIds.set(runId, { approvalId, requestId })
      return true
    }
    return false
  }

  async onApprovalResolved(approvalId: string, allowed: boolean): Promise<RoutineRunPublicDto | null> {
    if (this.stopping) return null
    return this.trackApprovalRecovery(this.onApprovalResolvedWork(approvalId, allowed))
  }

  private async onApprovalResolvedWork(approvalId: string, allowed: boolean): Promise<RoutineRunPublicDto | null> {
    const run = this.findRunByApproval(approvalId)
    if (!run) {
      if (this.inFlight.size === 0) return null
      this.resolvedApprovals.set(approvalId, allowed)
      setTimeout(() => this.resolvedApprovals.delete(approvalId), 60_000).unref?.()
      return null
    }
    return this.resolveApprovalOnce(run, allowed)
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

  private resolveApprovalOnce(run: RoutineRun, allowed: boolean): Promise<RoutineRunPublicDto | null> {
    return this.trackApprovalResolution(run.runId, () => this.applyApprovalResolution(run, allowed))
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

  private resumeApprovalOnce(run: RoutineRun, expectedVersion: number): Promise<RoutineRunPublicDto | null> {
    return this.trackApprovalResolution(run.runId, () => this.resumeAfterApprovalWork(run.runId, expectedVersion, false))
  }

  private async recoverRuns(): Promise<void> {
    for (const run of this.allRuns()) {
      const routine = this.store.get(run.routineId)
      const cancelReason = !routine || routine.lifecycle === 'deleted'
        ? 'routine-deleted'
        : routine.lifecycle === 'paused'
          ? 'routine-paused'
          : null
      if (cancelReason && (run.state.kind === 'queued' || run.state.kind === 'claimed' || run.state.kind === 'awaiting-approval')) {
        const approvalId = run.state.kind === 'awaiting-approval' ? run.state.approvalId : undefined
        const cancelled = this.store.transitionRun(run.runId, run.version, {
          kind: 'cancelled',
          at: timestamp(this.clock),
          reason: cancelReason,
        })
        await this.publish(cancelled)
        await this.cleanupApproval(cancelled, approvalId)
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
            if (approvalStatus === 'allowed' || approvalStatus === 'consumed') {
              await this.executeAdapter.claimApproval?.(attempt)
              await this.executeAdapter.resolveApproval?.(attempt, true)
              const running = this.store.transitionRun(run.runId, run.version, { kind: 'running', at: timestamp(this.clock) })
              await this.dispatch(running)
              continue
            }
            if (approvalStatus === 'denied' || approvalStatus === 'expired' || approvalStatus === 'stale') {
              const cancelled = this.store.transitionRun(run.runId, run.version, {
                kind: 'cancelled',
                at: timestamp(this.clock),
                reason: `approval-${approvalStatus}`,
              })
              await this.publish(cancelled)
              await this.cleanupApproval(cancelled, run.state.approvalId)
              this.notify(cancelled.routineId)
              continue
            }
            await this.publish(run)
            continue
          } catch {
            // Fall through to the durable uncertain state below.
          }
        }
        await this.markApprovalUncertain(run, 'approval execution record is missing or invalid after restart')
        continue
      }
      if (run.state.kind === 'running') {
        const uncertain = this.store.transitionRun(run.runId, run.version, {
          kind: 'uncertain',
          at: timestamp(this.clock),
          reason: 'server-restarted-during-execution',
        })
        await this.publish(uncertain)
        await this.cleanupApproval(uncertain)
        this.notify(uncertain.routineId)
        continue
      }
      if (run.state.kind === 'claimed' && run.state.leaseUntil <= timestamp(this.clock)) {
        const queued = this.store.transitionRun(run.runId, run.version, { kind: 'queued', at: timestamp(this.clock) })
        await this.dispatch(queued)
        continue
      }
      if (run.state.kind === 'queued') await this.dispatch(run)
      if (run.state.kind === 'succeeded' || run.state.kind === 'failed' || run.state.kind === 'cancelled' || run.state.kind === 'uncertain' || run.state.kind === 'reconciled') {
        await this.cleanupApproval(run)
        await this.publish(run)
      }
    }
  }

  private async reconcileApproval(run: RoutineRun): Promise<void> {
    if (!this.executeAdapter.validateApproval) return
    const current = this.store.getRun(run.runId)
    if (!current || current.state.kind !== 'awaiting-approval') return
    const attempt = this.readApprovalAttempt(current.runId)
    if (!attempt || attempt.approvalId !== current.state.approvalId || attempt.operationHash !== current.state.operationHash || attempt.version !== current.state.version) {
      await this.markApprovalUncertain(current, 'approval execution record is missing or invalid')
      return
    }
    let status: Awaited<ReturnType<NonNullable<RoutineExecutor['validateApproval']>>>
    try {
      status = await this.executeAdapter.validateApproval(attempt)
    } catch {
      await this.markApprovalUncertain(current, 'approval execution record could not be validated')
      return
    }
    if (status === 'pending') return
    if (status === 'allowed' || status === 'consumed') {
      await this.resolveApprovalOnce(current, true)
      return
    }
    await this.resolveApprovalOnce(current, false)
  }

  private async cleanupApproval(run: RoutineRun, approvalId?: string): Promise<boolean> {
    try {
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
      removePointer(this.approvalAttemptPath(run.runId))
      return true
    } catch {
      return false
    }
  }

  private async markApprovalUncertain(run: RoutineRun, reason: string): Promise<void> {
    const current = this.store.getRun(run.runId)
    if (!current || current.state.kind !== 'awaiting-approval') return
    await this.cleanupApproval(current, current.state.approvalId)
    const uncertain = this.store.transitionRun(current.runId, current.version, {
      kind: 'uncertain',
      at: timestamp(this.clock),
      reason,
    })
    await this.publish(uncertain)
    this.notify(uncertain.routineId)
  }

  private async triggerOccurrence(input: RecordOccurrenceInput & { readonly occurredAt?: string; readonly origin?: RoutineRun['origin'] }): Promise<RoutineRun | null> {
    const occurrence = this.store.recordOccurrence(input)
    const origin = input.origin && input.origin.kind === 'replay'
      ? { ...input.origin, occurrenceId: occurrence.occurrenceId }
      : { kind: 'triggered' as const, occurrenceId: occurrence.occurrenceId }
    const run = this.ensureRunForOccurrence(occurrence, origin)
    if (!run) return null
    await this.dispatch(run)
    return this.store.getRun(run.runId)
  }

  private ensureRunForOccurrence(occurrence: ReturnType<RoutineStore['recordOccurrence']>, origin?: RoutineRun['origin']): RoutineRun | null {
    const deterministicRunId = deriveRoutineRunId(occurrence.occurrenceId)
    const existing = this.store.getRun(deterministicRunId)
    if (existing) return existing
    const claimed = this.store.claimOccurrence({ occurrenceId: occurrence.occurrenceId, workerId: this.workerId, leaseMs: DEFAULT_CLAIM_LEASE_MS })
    if (!claimed) return this.store.getRun(deterministicRunId)
    return this.store.createRun({
      occurrenceId: occurrence.occurrenceId,
      ownerBotId: this.store.get(occurrence.routineId)!.ownerBotId,
      ...(origin ? { origin } : {}),
    })
  }

  private async dispatch(run: RoutineRun): Promise<RoutineRun> {
    const existing = this.inFlight.get(run.runId)
    if (existing) return existing
    const promise = this.dispatchOwned(run)
    this.inFlight.set(run.runId, promise)
    try {
      return await promise
    } finally {
      if (this.inFlight.get(run.runId) === promise) this.inFlight.delete(run.runId)
    }
  }

  private async dispatchOwned(initial: RoutineRun): Promise<RoutineRun> {
    let current = this.store.getRun(initial.runId) ?? initial
    const routine = this.store.get(current.routineId)
    if (!routine || routine.lifecycle !== 'enabled') {
      if (current.state.kind === 'running') {
        const cancelled = this.store.transitionRun(current.runId, current.version, {
          kind: 'cancelled',
          at: timestamp(this.clock),
          reason: routine?.lifecycle === 'deleted' ? 'routine-deleted' : 'routine-paused',
        })
        await this.publish(cancelled)
        await this.cleanupApproval(cancelled)
        this.notify(cancelled.routineId)
        return cancelled
      }
      return current
    }
    const revision = this.store.getRevision(current.routineId, current.routineRevision)

    if (current.state.kind === 'queued') {
      const claim = this.store.claimOccurrence({ occurrenceId: current.origin.occurrenceId, workerId: this.workerId, leaseMs: DEFAULT_CLAIM_LEASE_MS })
      if (!claim) return current
      current = this.store.transitionRun(current.runId, current.version, {
        kind: 'claimed',
        at: timestamp(this.clock),
        workerId: this.workerId,
        leaseUntil: claim.leaseUntil!,
      })
    }
    if (current.state.kind === 'claimed') {
      const now = timestamp(this.clock)
      if (current.state.workerId !== this.workerId || current.state.leaseUntil <= now) {
        if (current.state.workerId !== this.workerId && current.state.leaseUntil > now) return current
        const claim = this.store.claimOccurrence({ occurrenceId: current.origin.occurrenceId, workerId: this.workerId, leaseMs: DEFAULT_CLAIM_LEASE_MS })
        if (!claim) return current
        current = this.store.transitionRun(current.runId, current.version, {
          kind: 'claimed',
          at: now,
          workerId: this.workerId,
          leaseUntil: claim.leaseUntil!,
        })
      }
      current = this.store.transitionRun(current.runId, current.version, { kind: 'running', at: timestamp(this.clock) })
    }
    if (current.state.kind !== 'running') return current

    let result: RoutineExecutionResult
    try {
      result = await this.executeAdapter.execute(current, revision)
    } catch {
      result = { kind: 'failed', error: 'Routine executor failed' }
    }
    const bufferedResolution = result.kind === 'awaiting-approval'
      ? undefined
      : this.takeBufferedApprovalResolution(current.runId)

    const liveRoutine = this.store.get(current.routineId)
    if (this.shutdownTimedOut) {
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
      current = this.store.transitionRun(current.runId, current.version, {
        kind: 'uncertain',
        at: timestamp(this.clock),
        reason: 'server-shutdown-during-execution',
      })
      await this.publish(current)
      await this.cleanupApproval(current, shutdownAttempt?.approvalId)
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
      current = this.store.transitionRun(current.runId, current.version, {
        kind: 'cancelled',
        at: timestamp(this.clock),
        reason: liveRoutine?.lifecycle === 'deleted' ? 'routine-deleted' : 'routine-paused',
      })
      await this.publish(current)
      await this.cleanupApproval(current, cancellationApprovalId)
      this.notify(current.routineId)
      return current
    }

    if (bufferedResolution?.allowed === false) {
      current = this.store.transitionRun(current.runId, current.version, {
        kind: 'cancelled',
        at: timestamp(this.clock),
        reason: 'approval-denied',
      })
      await this.publish(current)
      await this.cleanupApproval(current, bufferedResolution.approvalId)
      this.notify(current.routineId)
      return current
    }

    if (result.kind === 'awaiting-approval') {
      if (!result.invocation) {
        current = this.store.transitionRun(current.runId, current.version, {
          kind: 'uncertain',
          at: timestamp(this.clock),
          reason: 'approval execution record is missing before persistence',
        })
        await this.publish(current)
        await this.cleanupApproval(current)
      } else {
        const requestId = result.requestId ?? this.approvalRequestIds.get(current.runId)?.requestId
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
        current = this.store.transitionRun(current.runId, current.version, {
          kind: 'awaiting-approval',
          at: timestamp(this.clock),
          approvalId: result.approvalId,
          operationHash: result.operationHash,
          version: result.version,
        })
        await this.publish(current)
        const resolved = this.resolvedApprovals.get(result.approvalId)
        if (resolved !== undefined) {
          this.resolvedApprovals.delete(result.approvalId)
          const settled = await this.resolveApprovalOnce(current, resolved)
          if (settled) current = this.store.getRun(settled.runId) ?? current
        }
      }
    } else if (result.kind === 'completed') {
      current = this.store.transitionRun(current.runId, current.version, { kind: 'succeeded', at: timestamp(this.clock), result: result.reply })
      await this.publish(current)
    } else if (result.kind === 'failed' && revision.failurePolicy === 'retry' && current.attempt < 2) {
      // ponytail: one automatic retry; raise the persisted attempt ceiling with
      // an explicit policy and idempotent provider operation when needed.
      current = this.store.retryRun(current.runId, current.version)
      current = await this.dispatchOwned(current)
    } else if (result.kind === 'uncertain' || revision.failurePolicy === 'uncertain') {
      const reason = result.kind === 'uncertain' ? result.reason : result.error
      current = this.store.transitionRun(current.runId, current.version, { kind: 'uncertain', at: timestamp(this.clock), reason })
      await this.publish(current)
    } else {
      current = this.store.transitionRun(current.runId, current.version, { kind: 'failed', at: timestamp(this.clock), error: result.error })
      await this.publish(current)
    }
    if (current.state.kind === 'succeeded' || current.state.kind === 'failed' || current.state.kind === 'cancelled' || current.state.kind === 'uncertain' || current.state.kind === 'reconciled') {
      await this.cleanupApproval(current)
    }
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
      const cancelled = this.store.transitionRun(run.runId, run.version, {
        kind: 'cancelled',
        at: timestamp(this.clock),
        reason,
      })
      void this.publish(cancelled)
      void this.trackApprovalRecovery(this.cleanupApproval(cancelled, run.state.kind === 'awaiting-approval' ? run.state.approvalId : undefined))
    }
  }

  private async publish(run: RoutineRun): Promise<void> {
    const routine = this.store.get(run.routineId)
    if (!routine) return
    const revision = this.store.getRevision(run.routineId, run.routineRevision)
    await this.executeAdapter.publish?.(run, revision)
  }

  private async applyApprovalResolution(run: RoutineRun, allowed: boolean): Promise<RoutineRun | null> {
    if (run.state.kind !== 'awaiting-approval') return null
    const routine = this.store.get(run.routineId)
    if (!routine || routine.lifecycle !== 'enabled') {
      const attempt = this.readApprovalAttempt(run.runId)
      const cancelled = this.store.transitionRun(run.runId, run.version, {
        kind: 'cancelled',
        at: timestamp(this.clock),
        reason: routine?.lifecycle === 'deleted' ? 'routine-deleted' : 'routine-paused',
      })
      await this.publish(cancelled)
      await this.cleanupApproval(cancelled, attempt?.approvalId)
      this.notify(cancelled.routineId)
      return cancelled
    }
    if (!allowed) {
      const attempt = this.readApprovalAttempt(run.runId)
      const cancelled = this.store.transitionRun(run.runId, run.version, {
        kind: 'cancelled',
        at: timestamp(this.clock),
        reason: 'approval-denied',
      })
      await this.publish(cancelled)
      await this.cleanupApproval(cancelled, attempt?.approvalId)
      this.notify(cancelled.routineId)
      return cancelled
    }
    const attempt = this.readApprovalAttempt(run.runId)
    try {
      if (!attempt) throw new Error('Routine approval execution record is missing')
      await this.executeAdapter.claimApproval?.(attempt)
    } catch {
      const uncertain = this.store.transitionRun(run.runId, run.version, {
        kind: 'uncertain',
        at: timestamp(this.clock),
        reason: 'approval execution record could not be claimed',
      })
      await this.publish(uncertain)
      await this.cleanupApproval(uncertain, attempt?.approvalId)
      this.notify(uncertain.routineId)
      return uncertain
    }
    await this.resumeAfterApprovalOwned(run.runId, run.version, true)
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

  private approvalAttemptPath(runId: RoutineRunId): string {
    return join(this.store.rootPath, 'approval-attempts', `${runId}.json`)
  }

  private writeApprovalAttempt(attempt: RoutineApprovalAttempt): void {
    writeJsonRecord(this.approvalAttemptPath(attempt.runId), attempt)
  }

  private readApprovalAttempt(runId: RoutineRunId): RoutineApprovalAttempt | null {
    const value = readJsonFile(this.approvalAttemptPath(runId))
    if (!value || typeof value !== 'object') return null
    const candidate = value as Partial<RoutineApprovalAttempt> & { invocation?: unknown }
    if (
      candidate.schemaVersion !== 1
      || candidate.runId !== runId
      || typeof candidate.approvalId !== 'string'
      || typeof candidate.operationHash !== 'string'
      || !Number.isSafeInteger(candidate.version)
      || !candidate.invocation
      || typeof candidate.invocation !== 'object'
      || typeof candidate.sessionId !== 'string'
      || (candidate.requestId !== undefined && typeof candidate.requestId !== 'string')
    ) return null
    return candidate as RoutineApprovalAttempt
  }

  private notify(routineId?: RoutineId): void {
    try { this.onChanged?.(routineId) } catch { /* notification follows durable state */ }
  }
}
