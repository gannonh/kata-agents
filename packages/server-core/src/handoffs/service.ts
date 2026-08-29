import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  HANDOFF_LIMITS,
  SPAWN_TASK_LIMITS,
  type BotRecord,
  type BotTurnContext,
  type HandoffDeliveryClaim,
  type HandoffDeliveryRecord,
  type HandoffTaskView,
  type SpawnTask,
  type SpawnTaskDispatchFence,
  type SpawnTaskIntegrityView,
  type SpawnTaskJsonValue,
  type SpawnTaskResultChunkView,
} from '@kata-sh/core'
import { isSpawnTaskTerminal, matchesSpawnTaskDispatchFence } from '@kata-sh/shared/spawn-tasks'
import { HandoffDeliveryClaimConflictError, HandoffDeliveryStore } from '@kata-sh/shared/handoffs'
import {
  BotContextLedger,
  BotDirectory,
  ContextAssembler,
  botProviderSessionPath,
  type BotContextJournal,
} from '@kata-sh/shared/bots'
import { ChannelDirectory, channelProviderSessionPath } from '@kata-sh/shared/channels'
import type { ConversationJournal } from '@kata-sh/shared/conversations'
import type {
  InspectHandoffRequest,
  InspectHandoffResult,
  SendHandoffResult,
  SpawnSessionResult,
} from '@kata-sh/shared/agent'
import type { FileAttachment } from '@kata-sh/shared/utils/files'
import type { HandoffAction, HandoffDeliveryView, HandoffExchangeEntry, HandoffRailView } from '@kata-sh/shared/protocol'
import type { SpawnTaskCancellationResult } from '../sessions/spawn-task-coordinator.ts'

export interface HandoffReserveInput {
  readonly parentSessionId: string
  readonly delegatedPrompt: string
  readonly childConfig: Readonly<Record<string, SpawnTaskJsonValue>>
}

/** The workspace SpawnTaskStore owned by SessionManager's spawn coordinator. */
export interface HandoffTaskStore {
  readonly reserveForHandoff: (handoffId: string, input: HandoffReserveInput) => SpawnTask
  readonly getByHandoff: (handoffId: string) => SpawnTask | null
  readonly get: (taskId: string) => SpawnTask | null
  readonly setHandoffDispatchFence: (taskId: string, fence: SpawnTaskDispatchFence, at: string) => SpawnTask
  readonly readResultChunk: (
    taskId: string,
    offset: number,
    limit: number,
  ) => SpawnTaskResultChunkView | SpawnTaskIntegrityView
}

export interface HandoffSpawnCoordinator {
  readonly dispatchReserved: (
    task: SpawnTask,
    attachments?: readonly FileAttachment[],
    fence?: SpawnTaskDispatchFence,
    botTurnContext?: BotTurnContext,
  ) => Promise<SpawnSessionResult>
}

export interface HandoffSessionLookup {
  getSession(sessionId: string): Promise<{ id: string; workspaceId?: string } | null>
  cancelSpawnTask(taskId: string, reason?: string): Promise<SpawnTaskCancellationResult>
}

export interface HandoffServiceOptions {
  readonly workspaceId: string
  readonly workspaceRoot: string
  readonly deliveryStore: HandoffDeliveryStore
  readonly resolveJournal: (conversationId: string) => BotContextJournal & Pick<ConversationJournal, 'append'>
  readonly botDirectory: Pick<BotDirectory, 'getBotByLegacySession' | 'getBot' | 'listBots'>
  readonly channelDirectory: Pick<ChannelDirectory, 'getChannel' | 'listChannels' | 'isMember'>
  readonly sessionManager: HandoffSessionLookup
  readonly taskStore: HandoffTaskStore
  readonly coordinator: HandoffSpawnCoordinator
  readonly clock?: () => string
  readonly randomId?: () => string
  readonly onHandoffEvent?: (event: HandoffServiceEvent) => void
}

export type HandoffServiceEvent =
  | { readonly type: 'handoff-created'; readonly handoffId: string; readonly deliveryId: string; readonly taskId: string; readonly conversationId: string }
  | { readonly type: 'handoff-delivery-failed'; readonly handoffId: string; readonly deliveryId: string; readonly conversationId: string }
  | { readonly type: 'handoff-result-unread'; readonly handoffId: string; readonly deliveryId: string; readonly conversationId: string }
  | { readonly type: 'handoff-updated'; readonly handoffId: string; readonly deliveryId: string; readonly conversationId: string }
  | { readonly type: 'handoff-terminal'; readonly handoffId: string; readonly deliveryId: string; readonly conversationId: string }

export interface CreateHandoffInput {
  /** Managed session ID of the caller; source Bot identity is derived from it. */
  readonly callerSessionId: string
  /** Target Bot name or ID; resolved server-side. */
  readonly targetBot: string
  readonly request: string
}

export interface HandoffProjection {
  readonly delivery: HandoffDeliveryRecord
  readonly task: HandoffTaskView | null
  readonly unread: boolean
}

export interface HandoffReconcileReport {
  readonly repairedPointers: number
  readonly acknowledged: number
  readonly failed: number
  readonly terminalAppended: number
  readonly terminalAppendFailures: number
  readonly recoveryFailures: readonly {
    readonly deliveryId: string
    readonly message: string
  }[]
}

export interface HandoffDelegate {
  createHandoff(input: CreateHandoffInput): Promise<SendHandoffResult>
  inspectHandoff(callerSessionId: string, input: InspectHandoffRequest, signal?: AbortSignal): Promise<InspectHandoffResult>
  onTaskUpdated(taskId: string): void | Promise<void>
  reconcileStartup(): Promise<HandoffReconcileReport> | HandoffReconcileReport
  resolveBotTurnContext(handoffId: string): Promise<BotTurnContext>
}

const REQUESTED_KEY_SUFFIX = '.requested'
const TERMINAL_KEY_SUFFIX = '.terminal'
const MAX_INSPECT_WAIT_MS = 25_000
const INSPECT_WAIT_POLL_MS = 50

function requestedKey(handoffId: string): string {
  return `handoff.${handoffId}${REQUESTED_KEY_SUFFIX}`
}

function terminalKey(handoffId: string): string {
  return `handoff.${handoffId}${TERMINAL_KEY_SUFFIX}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function truncateUtf8(value: string, limit: number): string {
  if (Buffer.byteLength(value, 'utf8') <= limit) return value
  let result = ''
  for (const character of value) {
    if (Buffer.byteLength(`${result}${character}`, 'utf8') > limit) break
    result += character
  }
  return result
}

function escapeUntrustedText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * One error type for every "this task is not yours to see" outcome. Unknown
 * taskId and cross-workspace/cross-bot ownership produce the identical error
 * so callers cannot probe for existence.
 */
export class TaskAccessError extends Error {
  readonly code = 'handoff_task_unavailable'

  constructor() {
    super('Requested task is not available.')
    this.name = 'TaskAccessError'
  }
}

type HandoffFailure = {
  readonly code: string
  readonly message: string
  readonly retryable: false
  readonly committedAt: string
}

/**
 * Validation and dispatch rejections carry a bounded code and a canonical
 * failure payload so session tools return the same structured shape as
 * spawn_session failures.
 */
export class HandoffRejectedError extends Error {
  readonly code: string
  readonly failure: HandoffFailure

  constructor(code: string, message: string, committedAt: string) {
    super(message)
    this.name = 'HandoffRejectedError'
    this.code = code
    this.failure = { code, message, retryable: false, committedAt }
  }
}

class HandoffTerminalAppendError extends Error {
  constructor(handoffId: string, cause: unknown) {
    super(`Handoff ${handoffId} terminal journal entry could not be persisted: ${errorMessage(cause)}`)
    this.name = 'HandoffTerminalAppendError'
  }
}

class HandoffDispatchError extends Error {
  readonly claim?: {
    readonly claimId: string
    readonly recipientBotId: string
    readonly ownerEpoch: number
  }

  constructor(cause: unknown, claim?: HandoffDeliveryClaim, recipientBotId?: string) {
    super(errorMessage(cause))
    this.name = 'HandoffDispatchError'
    this.claim = claim && recipientBotId
      ? { claimId: claim.claimId, recipientBotId, ownerEpoch: claim.ownerEpoch }
      : undefined
  }
}

interface SourceIdentity {
  readonly sourceBotId: string
  readonly conversationId: string
}

function requireClaim(deliveryId: string, claim: HandoffDeliveryClaim | undefined): HandoffDeliveryClaim {
  if (!claim) throw new Error(`Handoff delivery ${deliveryId} has no claim after claimDelivery`)
  return claim
}

function readPointerSessionId(path: string): string | null {
  if (!existsSync(path)) return null
  const value = readFileSync(path, 'utf8').trim()
  return value || null
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function parseExchangePhase(
  body: string,
  delivery: HandoffDeliveryRecord,
): HandoffExchangeEntry['phase'] | null {
  try {
    const value = JSON.parse(body) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    if (record.handoffId !== delivery.handoffId || record.deliveryId !== delivery.deliveryId) return null
    if (record.type === 'handoff-requested') return 'requested'
    if (record.type === 'handoff-terminal') return 'terminal'
    return null
  } catch {
    return null
  }
}

export class HandoffService {
  readonly workspaceId: string
  readonly workspaceRoot: string

  private readonly deliveryStore: HandoffDeliveryStore
  private readonly resolveJournal: HandoffServiceOptions['resolveJournal']
  private readonly botDirectory: HandoffServiceOptions['botDirectory']
  private readonly channelDirectory: HandoffServiceOptions['channelDirectory']
  private readonly sessionManager: HandoffSessionLookup
  private readonly taskStore: HandoffTaskStore
  private readonly coordinator: HandoffSpawnCoordinator
  private readonly clock: () => string
  private readonly randomId: () => string
  private readonly onHandoffEvent?: HandoffServiceOptions['onHandoffEvent']
  private readonly deliveryIdByTaskId = new Map<string, string>()

  constructor(options: HandoffServiceOptions) {
    this.workspaceId = options.workspaceId
    this.workspaceRoot = options.workspaceRoot
    this.deliveryStore = options.deliveryStore
    this.resolveJournal = options.resolveJournal
    this.botDirectory = options.botDirectory
    this.channelDirectory = options.channelDirectory
    this.sessionManager = options.sessionManager
    this.taskStore = options.taskStore
    this.coordinator = options.coordinator
    this.clock = options.clock ?? (() => new Date().toISOString())
    this.randomId = options.randomId ?? randomUUID
    this.onHandoffEvent = options.onHandoffEvent
    this.rebuildTaskIndex()
  }

  async createHandoff(input: CreateHandoffInput): Promise<SendHandoffResult> {
    const identity = await this.resolveSourceIdentity(input.callerSessionId)
    const target = this.resolveTargetBot(input.targetBot)
    this.validate(identity, target, input.request)

    const handoffId = `handoff_${this.randomId()}`
    const deliveryId = `delivery_${this.randomId()}`

    const delivery = this.deliveryStore.create({
      deliveryId,
      handoffId,
      workspaceId: this.workspaceId,
      conversationId: identity.conversationId,
      sourceBotId: identity.sourceBotId,
      targetBotId: target.botId,
      request: input.request,
    })

    let task: SpawnTask
    try {
      task = this.taskStore.reserveForHandoff(handoffId, {
        parentSessionId: input.callerSessionId,
        delegatedPrompt: input.request,
        childConfig: this.buildChildConfig(target),
      })
    } catch {
      const failed = this.deliveryStore.failDelivery(delivery.deliveryId, {
        code: 'task_reservation_failed',
        message: 'Handoff could not reserve the delegated task.',
      })
      this.appendTerminalEntry(failed, null)
      this.emit({
        type: 'handoff-delivery-failed',
        handoffId: failed.handoffId,
        deliveryId: failed.deliveryId,
        conversationId: failed.conversationId,
      })
      throw new HandoffRejectedError(
        'handoff_reserve_failed',
        'Handoff could not reserve the delegated task.',
        this.clock(),
      )
    }
    this.deliveryIdByTaskId.set(task.taskId, deliveryId)
    this.deliveryStore.attachSpawnTask(delivery.deliveryId, task.taskId)

    try {
      this.appendRequestedEntry(delivery)
    } catch (error) {
      console.warn(`[Handoffs] Requested journal publication deferred for ${handoffId}`, error)
    }
    this.emit({ type: 'handoff-created', handoffId, deliveryId, taskId: task.taskId, conversationId: delivery.conversationId })

    try {
      const acknowledged = await this.dispatchAndTryAcknowledge(delivery, task)
      const latest = this.taskStore.get(task.taskId)
      if (latest) await this.publishTerminalIfNeeded(acknowledged, latest)
      return {
        handoffId,
        deliveryId,
        taskId: task.taskId,
        runtimeState: latest?.runtimeState ?? task.runtimeState,
        version: latest?.version ?? task.version,
        targetBotId: target.botId,
      }
    } catch (error) {
      const terminalTask = this.taskStore.get(task.taskId)
      const current = this.deliveryStore.get(deliveryId)
      const failedClaim = error instanceof HandoffDispatchError ? error.claim : undefined
      const ownsCurrentClaim = failedClaim !== undefined
        && current?.mailState === 'claimed'
        && current.targetBotId === failedClaim.recipientBotId
        && current.claim?.claimId === failedClaim.claimId
        && current.claim.ownerEpoch === failedClaim.ownerEpoch
      if (current && (current.mailState === 'pending' || ownsCurrentClaim)) {
        let failed: HandoffDeliveryRecord | null = null
        try {
          failed = this.deliveryStore.failDelivery(deliveryId, {
            code: 'handoff_dispatch_failed',
            message: truncateUtf8(errorMessage(error), HANDOFF_LIMITS.deliveryFailureMessageBytes),
            ...(failedClaim ? { claim: failedClaim } : {}),
          })
        } catch (failureError) {
          if (!(failureError instanceof HandoffDeliveryClaimConflictError)) throw failureError
        }
        if (failed) {
          this.emit({ type: 'handoff-delivery-failed', handoffId, deliveryId, conversationId: delivery.conversationId })
          this.appendTerminalEntry(failed, terminalTask)
        }
      }
      if (error instanceof HandoffRejectedError) throw error
      if (error instanceof HandoffTerminalAppendError) throw error
      throw new HandoffRejectedError(
        'handoff_dispatch_failed',
        'Handoff delivery failed before the receiving Bot could run the request.',
        this.clock(),
      )
    }
  }

  async onTaskUpdated(taskId: string): Promise<void> {
    const deliveryId = this.deliveryIdByTaskId.get(taskId)
    if (!deliveryId) return
    const delivery = this.deliveryStore.get(deliveryId)
    const task = this.taskStore.get(taskId)
    if (!delivery || !task) return
    if (delivery.mailState !== 'delivery-failed') {
      this.emit({
        type: 'handoff-updated',
        handoffId: delivery.handoffId,
        deliveryId: delivery.deliveryId,
        conversationId: delivery.conversationId,
      })
    }
    if (delivery.mailState !== 'acknowledged' || !isSpawnTaskTerminal(task.runtimeState)) return

    await this.publishTerminalIfNeeded(delivery, task)
  }

  async reconcileStartup(): Promise<HandoffReconcileReport> {
    const report: {
      repairedPointers: number
      acknowledged: number
      failed: number
      terminalAppended: number
      terminalAppendFailures: number
      recoveryFailures: Array<{ deliveryId: string; message: string }>
    } = {
      repairedPointers: 0,
      acknowledged: 0,
      failed: 0,
      terminalAppended: 0,
      terminalAppendFailures: 0,
      recoveryFailures: [],
    }

    for (const delivery of this.deliveryStore.listAll()) {
      if (this.deliveryStore.repairHandoffPointerIfMissing(delivery.deliveryId) === 'repaired') {
        report.repairedPointers += 1
      }
    }
    this.rebuildTaskIndex()

    for (const snapshot of this.deliveryStore.listAll()) {
      try {
        if (snapshot.mailState === 'delivery-failed') {
          try {
            if (this.appendTerminalEntry(snapshot, null)) report.terminalAppended += 1
          } catch (error) {
            if (error instanceof HandoffTerminalAppendError) report.terminalAppendFailures += 1
            else throw error
          }
          continue
        }
        this.appendRequestedEntry(snapshot)
        if (snapshot.mailState === 'acknowledged') {
          const task = snapshot.spawnTaskId ? this.taskStore.get(snapshot.spawnTaskId) : null
          if (!task || !isSpawnTaskTerminal(task.runtimeState)) continue
          try {
            await this.publishTerminalIfNeeded(snapshot, task)
          } catch (error) {
            if (error instanceof HandoffTerminalAppendError) {
              report.terminalAppendFailures += 1
              continue
            }
            throw error
          }
          if (this.hasJournalEntry(snapshot.conversationId, terminalKey(snapshot.handoffId))) {
            report.terminalAppended += 1
          }
          continue
        }

        let task = snapshot.spawnTaskId ? this.taskStore.get(snapshot.spawnTaskId) : null
        if (!task) {
          task = this.taskStore.getByHandoff(snapshot.handoffId)
          if (task) this.deliveryStore.attachSpawnTask(snapshot.deliveryId, task.taskId)
        }
        if (!snapshot.spawnTaskId || !task) {
          task = task ?? this.reserveMissingTask(snapshot)
          if (task) {
            this.deliveryIdByTaskId.set(task.taskId, snapshot.deliveryId)
            this.deliveryStore.attachSpawnTask(snapshot.deliveryId, task.taskId)
          }
        }
        if (!task) {
          const claim = snapshot.mailState === 'claimed' && snapshot.claim
            ? {
                claimId: snapshot.claim.claimId,
                recipientBotId: snapshot.targetBotId,
                ownerEpoch: snapshot.claim.ownerEpoch,
              }
            : undefined
          const failed = this.deliveryStore.failDelivery(snapshot.deliveryId, {
            code: 'handoff_task_missing',
            message: 'Handoff delivery has no delegated task.',
            ...(claim ? { claim } : {}),
          })
          report.failed += 1
          this.emit({
            type: 'handoff-delivery-failed',
            handoffId: failed.handoffId,
            deliveryId: failed.deliveryId,
            conversationId: failed.conversationId,
          })
          try {
            if (this.appendTerminalEntry(failed, null)) report.terminalAppended += 1
          } catch (error) {
            if (error instanceof HandoffTerminalAppendError) report.terminalAppendFailures += 1
            else throw error
          }
          continue
        }

        const acknowledged = await this.dispatchAndTryAcknowledge(snapshot, task)
        if (acknowledged.mailState === 'acknowledged') report.acknowledged += 1
        const latest = this.taskStore.get(task.taskId)
        if (!latest || !isSpawnTaskTerminal(latest.runtimeState)) continue
        try {
          await this.publishTerminalIfNeeded(acknowledged, latest)
        } catch (error) {
          if (error instanceof HandoffTerminalAppendError) {
            report.terminalAppendFailures += 1
            continue
          }
          throw error
        }
        if (this.hasJournalEntry(acknowledged.conversationId, terminalKey(acknowledged.handoffId))) {
          report.terminalAppended += 1
        }
      } catch (error) {
        report.recoveryFailures.push({
          deliveryId: snapshot.deliveryId,
          message: truncateUtf8(errorMessage(error), HANDOFF_LIMITS.deliveryFailureMessageBytes),
        })
      }
    }

    return report
  }

  listConversationHandoffs(conversationId: string): HandoffProjection[] {
    return this.deliveryStore.listByConversation(conversationId).map((delivery) => this.project(delivery))
  }

  listConversationHandoffRails(conversationId: string): HandoffRailView[] {
    return this.deliveryStore.listByConversation(conversationId)
      .map((delivery) => this.getHandoffRail(conversationId, delivery.handoffId))
  }

  reloadDeliveries(): void {
    this.deliveryStore.reload()
    this.rebuildTaskIndex()
  }

  getHandoff(handoffId: string): HandoffProjection | null {
    const delivery = this.deliveryStore.getByHandoff(handoffId)
    return delivery ? this.project(delivery) : null
  }

  getHandoffRail(conversationId: string, handoffId: string): HandoffRailView {
    const delivery = this.deliveryStore.getByHandoff(handoffId)
    if (!delivery || delivery.conversationId !== conversationId) throw new TaskAccessError()
    const task = delivery.spawnTaskId ? this.taskStore.get(delivery.spawnTaskId) : null
    const exchange = this.resolveJournal(conversationId)
      .list(conversationId)
      .filter((entry) => entry.handoffId === handoffId)
      .flatMap((entry): HandoffExchangeEntry[] => {
        const phase = parseExchangePhase(entry.body, delivery)
        return phase ? [{
          seq: entry.seq,
          entryId: entry.entryId,
          phase,
          ...(entry.authorBotId ? { authorBotId: entry.authorBotId } : {}),
          createdAt: entry.createdAt,
        }] : []
      })
    const unread = delivery.resultUnread !== undefined
    const actions: HandoffAction[] = []
    if (task && !isSpawnTaskTerminal(task.runtimeState)) {
      actions.push('cancel')
    }
    if (unread) actions.push('read')
    const journalSequence = exchange.reduce((latest, entry) => Math.max(latest, entry.seq), 0)
    const deliveryView: HandoffDeliveryView = {
      deliveryId: delivery.deliveryId,
      handoffId: delivery.handoffId,
      workspaceId: delivery.workspaceId,
      conversationId: delivery.conversationId,
      sourceBotId: delivery.sourceBotId,
      targetBotId: delivery.targetBotId,
      request: delivery.request,
      mailState: delivery.mailState,
      ...(delivery.spawnTaskId ? { spawnTaskId: delivery.spawnTaskId } : {}),
      ...(delivery.claim ? { claim: delivery.claim } : {}),
      ...(delivery.failure ? { failure: delivery.failure } : {}),
      ...(delivery.resultUnread ? { resultUnread: delivery.resultUnread } : {}),
      ...(delivery.resultReadTaskVersion !== undefined ? { resultReadTaskVersion: delivery.resultReadTaskVersion } : {}),
      createdAt: delivery.createdAt,
      updatedAt: delivery.updatedAt,
      version: delivery.version,
    }
    return {
      handoffId,
      conversationId,
      sourceBotName: this.tryGetBotById(delivery.sourceBotId)?.name ?? delivery.sourceBotId,
      targetBotName: this.tryGetBotById(delivery.targetBotId)?.name ?? delivery.targetBotId,
      delivery: deliveryView,
      exchange,
      task: task ? toHandoffTaskView(task) : null,
      unread,
      freshness: {
        deliveryVersion: delivery.version,
        taskVersion: task?.version ?? 0,
        journalSequence,
      },
      actions,
    }
  }

  readResultChunk(conversationId: string, handoffId: string, offset: number, limit: number): unknown {
    const delivery = this.deliveryStore.getByHandoff(handoffId)
    if (!delivery || delivery.conversationId !== conversationId || !delivery.spawnTaskId) {
      throw new TaskAccessError()
    }
    return this.taskStore.readResultChunk(delivery.spawnTaskId, offset, limit)
  }

  markResultRead(conversationId: string, handoffId: string, expectedTaskVersion: number): HandoffDeliveryRecord {
    const delivery = this.deliveryStore.getByHandoff(handoffId)
    if (!delivery || delivery.conversationId !== conversationId) throw new TaskAccessError()
    const marked = this.deliveryStore.markResultRead(delivery.deliveryId, { expectedTaskVersion })
    this.emit({
      type: 'handoff-updated',
      handoffId: marked.handoffId,
      deliveryId: marked.deliveryId,
      conversationId: marked.conversationId,
    })
    return marked
  }

  async cancelHandoff(conversationId: string, handoffId: string, reason: string): Promise<SpawnTaskCancellationResult> {
    const delivery = this.deliveryStore.getByHandoff(handoffId)
    if (!delivery || delivery.conversationId !== conversationId || !delivery.spawnTaskId) throw new TaskAccessError()
    const result = await this.sessionManager.cancelSpawnTask(delivery.spawnTaskId, reason)
    this.emit({
      type: 'handoff-updated',
      handoffId: delivery.handoffId,
      deliveryId: delivery.deliveryId,
      conversationId: delivery.conversationId,
    })
    return result
  }

  async inspectHandoff(
    callerSessionId: string,
    input: InspectHandoffRequest,
    signal?: AbortSignal,
  ): Promise<InspectHandoffResult> {
    const identity = await this.resolveSourceIdentity(callerSessionId)
    if (input.action === 'read-result') {
      this.resolveTaskForIdentity(identity, input.taskId)
      return this.taskStore.readResultChunk(input.taskId, input.offset, input.limit)
    }
    if (input.action === 'get') return this.resolveTaskForIdentity(identity, input.taskId).task

    const timeoutMs = Math.max(0, Math.min(Math.trunc(input.timeoutMs ?? MAX_INSPECT_WAIT_MS), MAX_INSPECT_WAIT_MS))
    const deadline = Date.now() + timeoutMs
    while (true) {
      const { task } = this.resolveTaskForIdentity(identity, input.taskId)
      if (task.version > input.afterVersion || signal?.aborted || Date.now() >= deadline) return task
      await delay(Math.min(INSPECT_WAIT_POLL_MS, Math.max(1, deadline - Date.now())), signal)
    }
  }

  private resolveTaskForIdentity(identity: SourceIdentity, taskId: string): {
    delivery: HandoffDeliveryRecord
    task: HandoffTaskView
  } {
    const deliveryId = this.deliveryIdByTaskId.get(taskId)
    const delivery = deliveryId ? this.deliveryStore.get(deliveryId) : null
    if (
      delivery?.spawnTaskId !== taskId
      || delivery.sourceBotId !== identity.sourceBotId
      || delivery.conversationId !== identity.conversationId
    ) {
      throw new TaskAccessError()
    }
    const task = this.taskStore.get(delivery.spawnTaskId)
    if (!task) throw new TaskAccessError()
    return { delivery, task: toHandoffTaskView(task) }
  }

  private project(delivery: HandoffDeliveryRecord): HandoffProjection {
    const task = delivery.spawnTaskId ? this.taskStore.get(delivery.spawnTaskId) : null
    return {
      delivery,
      task: task ? toHandoffTaskView(task) : null,
      unread: delivery.resultUnread !== undefined,
    }
  }

  private appendRequestedEntry(delivery: HandoffDeliveryRecord): void {
    const key = requestedKey(delivery.handoffId)
    if (this.hasJournalEntry(delivery.conversationId, key)) return
    this.resolveJournal(delivery.conversationId).append({
      conversationId: delivery.conversationId,
      kind: 'handoff',
      authorBotId: delivery.sourceBotId,
      handoffId: delivery.handoffId,
      idempotencyKey: key,
      body: JSON.stringify({
        type: 'handoff-requested',
        handoffId: delivery.handoffId,
        deliveryId: delivery.deliveryId,
      }),
    })
  }

  private reserveMissingTask(delivery: HandoffDeliveryRecord): SpawnTask | null {
    const target = this.tryGetBotById(delivery.targetBotId)
    if (!target || target.lifecycle !== 'active') return null
    const parentSessionId = delivery.conversationId.startsWith('channel_')
      ? this.findChannelProviderSession(delivery)
      : readPointerSessionId(botProviderSessionPath(this.workspaceRoot, delivery.sourceBotId))
    if (!parentSessionId) return null
    return this.taskStore.reserveForHandoff(delivery.handoffId, {
      parentSessionId,
      delegatedPrompt: delivery.request,
      childConfig: this.buildChildConfig(target),
    })
  }

  private findChannelProviderSession(delivery: HandoffDeliveryRecord): string | null {
    if (!delivery.conversationId.startsWith('channel_')) return null
    const channel = this.channelDirectory.getChannel(delivery.conversationId)
    if (!channel) return null
    for (const member of channel.members) {
      if (member.botId !== delivery.sourceBotId) continue
      const sessionId = readPointerSessionId(
        channelProviderSessionPath(this.workspaceRoot, channel.channelId, member.botId),
      )
      if (sessionId) return sessionId
    }
    return null
  }

  private async dispatchAndTryAcknowledge(
    delivery: HandoffDeliveryRecord,
    task: SpawnTask,
  ): Promise<HandoffDeliveryRecord> {
    const current = this.deliveryStore.get(delivery.deliveryId)
    if (!current || (current.mailState !== 'pending' && current.mailState !== 'claimed')) {
      if (current?.mailState === 'acknowledged') return current
      throw new Error(`Handoff delivery ${delivery.deliveryId} is unavailable for dispatch`)
    }

    let ownedClaim: HandoffDeliveryClaim | undefined
    try {
      const claimed = this.deliveryStore.claimDelivery(current.deliveryId, {
        claimId: `claim_${this.randomId()}`,
        recipientBotId: current.targetBotId,
        expectedOwnerEpoch: current.claim?.ownerEpoch ?? 0,
      })
      ownedClaim = claimed.claim
      const claim = requireClaim(current.deliveryId, ownedClaim)
      const fence: SpawnTaskDispatchFence = {
        deliveryId: current.deliveryId,
        claimId: claim.claimId,
        recipientBotId: current.targetBotId,
        ownerEpoch: claim.ownerEpoch,
      }
      let currentTask = this.taskStore.get(task.taskId) ?? task
      if (!isSpawnTaskTerminal(currentTask.runtimeState)) {
        currentTask = this.taskStore.setHandoffDispatchFence(currentTask.taskId, fence, this.clock())
        if (currentTask.dispatch.state !== 'sent' && currentTask.runtimeState !== 'processing') {
          const target = this.tryGetBotById(current.targetBotId)
          const botTurnContext = target ? await this.assembleBotContext(target) : undefined
          await this.coordinator.dispatchReserved(currentTask, undefined, fence, botTurnContext)
        } else if (!matchesSpawnTaskDispatchFence(currentTask.dispatch.handoffFence, fence)) {
          throw new Error(`Spawned task ${currentTask.taskId} has a stale handoff dispatch fence`)
        }
      }

      const afterDispatch = this.deliveryStore.get(current.deliveryId)
      if (!afterDispatch || afterDispatch.mailState !== 'claimed' || !afterDispatch.claim
        || afterDispatch.claim.claimId !== claim.claimId || afterDispatch.claim.ownerEpoch !== claim.ownerEpoch) {
        throw new Error('Handoff delivery claim changed before acknowledgement')
      }
      const afterTask = this.taskStore.get(currentTask.taskId) ?? currentTask
      if (!isSpawnTaskTerminal(afterTask.runtimeState)
        && !matchesSpawnTaskDispatchFence(afterTask.dispatch.handoffFence, fence)) {
        throw new Error(`Spawned task ${afterTask.taskId} has a stale handoff dispatch fence`)
      }
      try {
        return this.deliveryStore.acknowledgeDelivery(current.deliveryId, {
          claimId: claim.claimId,
          recipientBotId: current.targetBotId,
          ownerEpoch: claim.ownerEpoch,
        })
      } catch (error) {
        const recoverable = this.deliveryStore.get(current.deliveryId)
        if (recoverable?.mailState === 'acknowledged') return recoverable
        if (recoverable?.mailState === 'claimed'
          && recoverable.claim.claimId === claim.claimId
          && recoverable.claim.ownerEpoch === claim.ownerEpoch) {
          return recoverable
        }
        throw error
      }
    } catch (error) {
      throw new HandoffDispatchError(error, ownedClaim, current.targetBotId)
    }
  }

  private async publishTerminalIfNeeded(delivery: HandoffDeliveryRecord, task: SpawnTask): Promise<void> {
    const current = this.deliveryStore.get(delivery.deliveryId)
    if (!current || current.mailState !== 'acknowledged') return
    const latest = this.taskStore.get(task.taskId) ?? task
    if (!isSpawnTaskTerminal(latest.runtimeState)) return

    if ((!current.resultUnread || latest.version > current.resultUnread.taskVersion)
      && (current.resultReadTaskVersion === undefined || latest.version > current.resultReadTaskVersion)) {
      this.deliveryStore.markResultUnread(current.deliveryId, { taskVersion: latest.version, at: this.clock() })
      this.emit({
        type: 'handoff-result-unread',
        handoffId: current.handoffId,
        deliveryId: current.deliveryId,
        conversationId: current.conversationId,
      })
    }
    this.appendTerminalEntry(current, latest)
  }

  private appendTerminalEntry(delivery: HandoffDeliveryRecord, task: SpawnTask | null): boolean {
    const key = terminalKey(delivery.handoffId)
    try {
      if (this.hasJournalEntry(delivery.conversationId, key)) return false
      const body: Record<string, unknown> = {
        type: 'handoff-terminal',
        handoffId: delivery.handoffId,
        deliveryId: delivery.deliveryId,
      }
      if (task) {
        body.taskId = task.taskId
        body.taskVersion = task.version
      }
      this.resolveJournal(delivery.conversationId).append({
        conversationId: delivery.conversationId,
        kind: 'handoff',
        authorBotId: delivery.sourceBotId,
        handoffId: delivery.handoffId,
        idempotencyKey: key,
        body: JSON.stringify(body),
      })
      this.emit({
        type: 'handoff-terminal',
        handoffId: delivery.handoffId,
        deliveryId: delivery.deliveryId,
        conversationId: delivery.conversationId,
      })
      return true
    } catch (error) {
      throw new HandoffTerminalAppendError(delivery.handoffId, error)
    }
  }

  private hasJournalEntry(conversationId: string, idempotencyKey: string): boolean {
    return this.resolveJournal(conversationId)
      .list(conversationId)
      .some((entry) => entry.idempotencyKey === idempotencyKey)
  }

  private async resolveSourceIdentity(callerSessionId: string): Promise<SourceIdentity> {
    const session = await this.sessionManager.getSession(callerSessionId)
    if (!session || (session.workspaceId !== undefined && session.workspaceId !== this.workspaceId)) {
      throw new HandoffRejectedError(
        'handoff_caller_unresolved',
        'Handoff is unavailable for this session.',
        this.clock(),
      )
    }

    const legacy = this.botDirectory.getBotByLegacySession(callerSessionId)
    if (legacy) return { sourceBotId: legacy.botId, conversationId: legacy.directChatId }

    for (const bot of this.botDirectory.listBots({ lifecycle: 'all' })) {
      if (readPointerSessionId(botProviderSessionPath(this.workspaceRoot, bot.botId)) === callerSessionId) {
        return { sourceBotId: bot.botId, conversationId: bot.directChatId }
      }
    }

    for (const channel of this.channelDirectory.listChannels({ lifecycle: 'all' })) {
      for (const member of channel.members) {
        const pointer = channelProviderSessionPath(this.workspaceRoot, channel.channelId, member.botId)
        if (readPointerSessionId(pointer) === callerSessionId) {
          return { sourceBotId: member.botId, conversationId: channel.channelId }
        }
      }
    }

    throw new HandoffRejectedError(
      'handoff_caller_unresolved',
      'Handoff is unavailable for this session.',
      this.clock(),
    )
  }

  private resolveTargetBot(targetBot: string): BotRecord {
    const byId = this.tryGetBotById(targetBot)
    if (byId) return byId
    const byName = this.botDirectory
      .listBots({ lifecycle: 'all' })
      .find((bot) => bot.name === targetBot)
    if (byName) return byName
    throw new HandoffRejectedError(
      'handoff_target_unresolved',
      'Handoff target is not a known Bot in this workspace.',
      this.clock(),
    )
  }

  private tryGetBotById(botId: string): BotRecord | null {
    try {
      return this.botDirectory.getBot(botId)
    } catch {
      return null
    }
  }

  private validate(identity: SourceIdentity, target: BotRecord, request: string): void {
    if (target.botId === identity.sourceBotId) {
      throw new HandoffRejectedError('handoff_target_self', 'A Bot cannot hand off to itself.', this.clock())
    }
    if (target.lifecycle !== 'active') {
      throw new HandoffRejectedError(
        'handoff_target_inactive',
        'Handoff target is not active.',
        this.clock(),
      )
    }
    if (!request.trim()) {
      throw new HandoffRejectedError('handoff_request_required', 'Handoff request must not be empty.', this.clock())
    }
    if (Buffer.byteLength(request, 'utf8') > HANDOFF_LIMITS.requestBytes) {
      throw new HandoffRejectedError(
        'handoff_request_too_large',
        `Handoff request exceeds the ${HANDOFF_LIMITS.requestBytes} byte limit.`,
        this.clock(),
      )
    }
    if (identity.conversationId.startsWith('channel_')
      && !this.channelDirectory.isMember(identity.conversationId, target.botId)) {
      throw new HandoffRejectedError(
        'handoff_target_not_member',
        'Handoff target is not a member of this conversation.',
        this.clock(),
      )
    }
  }

  private buildChildConfig(target: BotRecord): Record<string, SpawnTaskJsonValue> {
    const config: Record<string, SpawnTaskJsonValue> = {
      name: target.name,
      llmConnection: target.providerConfig.providerId,
      model: target.providerConfig.modelId,
      permissionMode: target.permissionMode,
    }
    return config
  }

  private async assembleBotContext(target: BotRecord): Promise<BotTurnContext> {
    const journal = this.resolveJournal(target.directChatId)
    const ledger = new BotContextLedger({
      workspaceRoot: this.workspaceRoot,
      workspaceId: this.workspaceId,
      botId: target.botId,
      journal,
    })
    await ledger.reconcile(target.directChatId)
    const assembler = new ContextAssembler({ ledger, journal })
    const context = assembler.assemble({
      conversationId: target.directChatId,
      operationId: `handoff.${this.randomId()}`,
      conversationKind: 'direct',
    }).context
    const preparedContext = target.profile === undefined
      ? context
      : {
          ...context,
          text: truncateUtf8(
            `<bot_profile_untrusted>\n${escapeUntrustedText(target.profile)}\n</bot_profile_untrusted>\n${context.text}`,
            SPAWN_TASK_LIMITS.childConfigBytes / 2,
          ),
        }
    await ledger.recordRun(preparedContext)
    return preparedContext
  }

  async resolveBotTurnContext(handoffId: string): Promise<BotTurnContext> {
    const delivery = this.deliveryStore.getByHandoff(handoffId)
    if (!delivery) throw new Error(`Handoff ${handoffId} is unavailable for Bot context recovery`)
    const target = this.tryGetBotById(delivery.targetBotId)
    if (!target) throw new Error(`Handoff ${handoffId} target Bot is unavailable for context recovery`)
    return this.assembleBotContext(target)
  }

  private rebuildTaskIndex(): void {
    this.deliveryIdByTaskId.clear()
    for (const delivery of this.deliveryStore.listAll()) {
      if (delivery.spawnTaskId) this.deliveryIdByTaskId.set(delivery.spawnTaskId, delivery.deliveryId)
    }
  }

  private emit(event: HandoffServiceEvent): void {
    if (!this.onHandoffEvent) return
    try {
      this.onHandoffEvent(event)
    } catch (error) {
      console.error('[Handoffs] Event notification failed after durable commit', error)
    }
  }
}

/** Public task view for handoff consumers: internal provider Session IDs omitted. */
export function toHandoffTaskView(task: SpawnTask): HandoffTaskView {
  return {
    taskId: task.taskId,
    version: task.version,
    runtimeState: task.runtimeState,
    stateTimestamps: task.stateTimestamps,
    ...(task.awaitingInput ? { awaitingInput: task.awaitingInput } : {}),
    ...(task.cancellation ? { cancellation: task.cancellation } : {}),
    ...(task.result ? { result: task.result } : {}),
    ...(task.failure ? { failure: task.failure } : {}),
    ...(task.integrityError ? { integrityError: task.integrityError } : {}),
  }
}
