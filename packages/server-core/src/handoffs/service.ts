import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  BOT_LIMITS,
  HANDOFF_LIMITS,
  SPAWN_TASK_LIMITS,
  type BotRecord,
  type HandoffDeliveryClaim,
  type HandoffDeliveryRecord,
  type HandoffTaskView,
  type SpawnTask,
  type SpawnTaskJsonValue,
} from '@kata-sh/core'
import { isSpawnTaskTerminal } from '@kata-sh/shared/spawn-tasks'
import { HandoffDeliveryStore } from '@kata-sh/shared/handoffs'
import {
  BotContextLedger,
  BotDirectory,
  ContextAssembler,
  botProviderSessionPath,
} from '@kata-sh/shared/bots'
import { ChannelDirectory, channelProviderSessionPath } from '@kata-sh/shared/channels'
import type { ConversationJournal } from '@kata-sh/shared/conversations'
import type { SendHandoffResult, SpawnSessionResult } from '@kata-sh/shared/agent'
import type { SpawnTaskCancellationResult } from '../sessions/spawn-task-coordinator.ts'

export interface HandoffReserveInput {
  readonly parentSessionId: string
  readonly delegatedPrompt: string
  readonly childConfig: Readonly<Record<string, SpawnTaskJsonValue>>
}

/** The workspace SpawnTaskStore owned by SessionManager's spawn coordinator. */
export interface HandoffTaskStore {
  readonly reserve: (input: HandoffReserveInput) => SpawnTask
  readonly get: (taskId: string) => SpawnTask | null
}

export interface HandoffSpawnCoordinator {
  readonly dispatchReserved: (task: SpawnTask) => Promise<SpawnSessionResult>
  readonly cancelTask: (taskId: string, reason: string) => Promise<SpawnTaskCancellationResult>
}

export interface HandoffSessionLookup {
  getSession(sessionId: string): Promise<{ id: string; workspaceId?: string } | null>
}

export interface HandoffServiceOptions {
  readonly workspaceId: string
  readonly workspaceRoot: string
  readonly deliveryStore: HandoffDeliveryStore
  readonly resolveJournal: (conversationId: string) => ConversationJournal
  readonly botDirectory: BotDirectory
  readonly channelDirectory: ChannelDirectory
  readonly sessionManager: HandoffSessionLookup
  readonly taskStore: HandoffTaskStore
  readonly coordinator: HandoffSpawnCoordinator
  readonly clock?: () => string
  readonly randomId?: () => string
  readonly onHandoffEvent?: (event: HandoffServiceEvent) => void
}

export type HandoffServiceEvent =
  | { readonly type: 'handoff-created'; readonly handoffId: string; readonly deliveryId: string; readonly taskId: string }
  | { readonly type: 'handoff-delivery-failed'; readonly handoffId: string; readonly deliveryId: string }
  | { readonly type: 'handoff-result-unread'; readonly handoffId: string; readonly deliveryId: string }
  | { readonly type: 'handoff-terminal'; readonly handoffId: string; readonly deliveryId: string }

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
}

/** Server-side seam consumed by SessionManager; HandoffService implements it. */
export interface HandoffDelegate {
  createHandoff(input: CreateHandoffInput): Promise<SendHandoffResult>
  onTaskUpdated(taskId: string): void | Promise<void>
  reconcileStartup(): Promise<HandoffReconcileReport> | HandoffReconcileReport | void
}

const REQUESTED_KEY_SUFFIX = '.requested'
const TERMINAL_KEY_SUFFIX = '.terminal'

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

export class HandoffService {
  readonly workspaceId: string
  readonly workspaceRoot: string

  private readonly deliveryStore: HandoffDeliveryStore
  private readonly resolveJournal: HandoffServiceOptions['resolveJournal']
  private readonly botDirectory: BotDirectory
  private readonly channelDirectory: ChannelDirectory
  private readonly sessionManager: HandoffSessionLookup
  private readonly taskStore: HandoffTaskStore
  private readonly coordinator: HandoffSpawnCoordinator
  private readonly clock: () => string
  private readonly randomId: () => string
  private readonly onHandoffEvent?: HandoffServiceOptions['onHandoffEvent']
  /** taskId -> deliveryId; the delivery mail references the task, never copies it. */
  private readonly byTaskId = new Map<string, string>()

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

    let task: SpawnTask
    try {
      task = this.taskStore.reserve({
        parentSessionId: input.callerSessionId,
        delegatedPrompt: input.request,
        childConfig: this.buildChildConfig(identity, target, handoffId, deliveryId),
      })
    } catch {
      throw new HandoffRejectedError(
        'handoff_reserve_failed',
        'Handoff could not reserve the delegated task.',
        this.clock(),
      )
    }
    this.byTaskId.set(task.taskId, deliveryId)

    const delivery = this.deliveryStore.create({
      deliveryId,
      handoffId,
      workspaceId: this.workspaceId,
      conversationId: identity.conversationId,
      sourceBotId: identity.sourceBotId,
      targetBotId: target.botId,
      request: input.request,
    })
    this.deliveryStore.attachSpawnTask(delivery.deliveryId, task.taskId)

    const journal = this.resolveJournal(delivery.conversationId)
    journal.append({
      conversationId: delivery.conversationId,
      kind: 'handoff',
      authorBotId: delivery.sourceBotId,
      handoffId: delivery.handoffId,
      idempotencyKey: requestedKey(delivery.handoffId),
      body: JSON.stringify({
        type: 'handoff-requested',
        handoffId: delivery.handoffId,
        deliveryId: delivery.deliveryId,
        targetBotId: delivery.targetBotId,
        sourceBotId: delivery.sourceBotId,
        request: delivery.request,
        taskId: task.taskId,
        at: this.clock(),
      }),
    })
    this.emit({ type: 'handoff-created', handoffId, deliveryId, taskId: task.taskId })

    const claim = this.deliveryStore.claimDelivery(deliveryId, {
      claimId: `claim_${this.randomId()}`,
      recipientBotId: target.botId,
      expectedOwnerEpoch: 0,
    })

    const settled = requireClaim(deliveryId, claim.claim)
    try {
      const dispatched = await this.coordinator.dispatchReserved(task)
      this.deliveryStore.acknowledgeDelivery(deliveryId, {
        claimId: settled.claimId,
        ownerEpoch: settled.ownerEpoch,
      })
      return {
        handoffId,
        deliveryId,
        taskId: dispatched.taskId,
        runtimeState: dispatched.runtimeState,
        version: dispatched.version,
        targetBotId: target.botId,
      }
    } catch (error) {
      const terminalTask = this.taskStore.get(task.taskId)
      const failed = this.deliveryStore.failDelivery(deliveryId, {
        code: 'handoff_dispatch_failed',
        message: truncateUtf8(errorMessage(error), HANDOFF_LIMITS.deliveryFailureMessageBytes),
        claim: { claimId: settled.claimId, ownerEpoch: settled.ownerEpoch },
      })
      this.emit({ type: 'handoff-delivery-failed', handoffId, deliveryId })
      this.appendTerminalEntry(failed, terminalTask)
      if (error instanceof HandoffRejectedError) throw error
      throw new HandoffRejectedError(
        'handoff_dispatch_failed',
        'Handoff delivery failed before the receiving Bot could run the request.',
        this.clock(),
      )
    }
  }

  async onTaskUpdated(taskId: string): Promise<void> {
    const deliveryId = this.byTaskId.get(taskId)
    if (!deliveryId) return
    const delivery = this.deliveryStore.get(deliveryId)
    if (!delivery || delivery.mailState !== 'acknowledged') return
    const task = this.taskStore.get(taskId)
    if (!task || !isSpawnTaskTerminal(task.runtimeState)) return

    this.deliveryStore.markResultUnread(deliveryId, { taskVersion: task.version, at: this.clock() })
    this.emit({ type: 'handoff-result-unread', handoffId: delivery.handoffId, deliveryId })
    this.appendTerminalEntry(delivery, task)
  }

  async reconcileStartup(): Promise<HandoffReconcileReport> {
    const report: { repairedPointers: number; acknowledged: number; failed: number; terminalAppended: number } = {
      repairedPointers: 0,
      acknowledged: 0,
      failed: 0,
      terminalAppended: 0,
    }

    for (const delivery of this.deliveryStore.listAll()) {
      if (this.deliveryStore.repairByHandoffPointer(delivery.deliveryId) === 'repaired') {
        report.repairedPointers += 1
      }
    }
    this.rebuildTaskIndex()

    for (const snapshot of this.deliveryStore.listAll()) {
      try {
        if (snapshot.mailState === 'delivery-failed') {
          if (this.appendTerminalEntry(snapshot, null)) report.terminalAppended += 1
          continue
        }
        if (snapshot.mailState === 'acknowledged') {
          const task = snapshot.spawnTaskId ? this.taskStore.get(snapshot.spawnTaskId) : null
          if (!task || !isSpawnTaskTerminal(task.runtimeState)) continue
          this.deliveryStore.markResultUnread(snapshot.deliveryId, { taskVersion: task.version, at: this.clock() })
          this.emit({ type: 'handoff-result-unread', handoffId: snapshot.handoffId, deliveryId: snapshot.deliveryId })
          if (this.appendTerminalEntry(snapshot, task)) report.terminalAppended += 1
          continue
        }

        const task = snapshot.spawnTaskId ? this.taskStore.get(snapshot.spawnTaskId) : null
        if (!snapshot.spawnTaskId || !task) {
          const claim = snapshot.mailState === 'claimed' && snapshot.claim
            ? { claimId: snapshot.claim.claimId, ownerEpoch: snapshot.claim.ownerEpoch }
            : undefined
          const failed = this.deliveryStore.failDelivery(snapshot.deliveryId, {
            code: 'handoff_task_missing',
            message: 'Handoff delivery has no delegated task.',
            ...(claim ? { claim } : {}),
          })
          report.failed += 1
          this.emit({ type: 'handoff-delivery-failed', handoffId: failed.handoffId, deliveryId: failed.deliveryId })
          if (this.appendTerminalEntry(failed, null)) report.terminalAppended += 1
          continue
        }

        const acknowledged = this.ensureAcknowledged(snapshot)
        report.acknowledged += 1
        if (!isSpawnTaskTerminal(task.runtimeState)) continue
        this.deliveryStore.markResultUnread(acknowledged.deliveryId, { taskVersion: task.version, at: this.clock() })
        this.emit({ type: 'handoff-result-unread', handoffId: acknowledged.handoffId, deliveryId: acknowledged.deliveryId })
        if (this.appendTerminalEntry(acknowledged, task)) report.terminalAppended += 1
      } catch {
        // Startup repair is idempotent and re-runs on the next startup; a fault
        // on one delivery must not block the remaining deliveries.
      }
    }

    return report
  }

  listConversationHandoffs(conversationId: string): HandoffProjection[] {
    return this.deliveryStore.listByConversation(conversationId).map((delivery) => this.project(delivery))
  }

  /** Reloads deliveries from disk and rebuilds the task index after external changes. */
  reloadDeliveries(): void {
    this.deliveryStore.reload()
    this.rebuildTaskIndex()
  }

  getHandoff(handoffId: string): HandoffProjection | null {
    const delivery = this.deliveryStore.getByHandoff(handoffId)
    return delivery ? this.project(delivery) : null
  }

  markResultRead(handoffId: string, expectedTaskVersion: number): HandoffDeliveryRecord {
    const delivery = this.deliveryStore.getByHandoff(handoffId)
    if (!delivery) throw new TaskAccessError()
    return this.deliveryStore.markResultRead(delivery.deliveryId, { expectedTaskVersion })
  }

  async cancelHandoff(handoffId: string, reason: string): Promise<SpawnTaskCancellationResult> {
    const delivery = this.deliveryStore.getByHandoff(handoffId)
    if (!delivery || !delivery.spawnTaskId) throw new TaskAccessError()
    return this.coordinator.cancelTask(delivery.spawnTaskId, reason)
  }

  resolveAuthorizedTask(workspaceId: string, taskId: string, botId?: string): {
    delivery: HandoffDeliveryRecord
    task: HandoffTaskView | null
  } {
    if (workspaceId !== this.workspaceId) throw new TaskAccessError()
    const deliveryId = this.byTaskId.get(taskId)
    const delivery = deliveryId ? this.deliveryStore.get(deliveryId) : null
    if (!delivery) throw new TaskAccessError()
    if (botId !== undefined && delivery.sourceBotId !== botId && delivery.targetBotId !== botId) {
      throw new TaskAccessError()
    }
    const task = delivery.spawnTaskId ? this.taskStore.get(delivery.spawnTaskId) : null
    return { delivery, task: task ? toHandoffTaskView(task) : null }
  }

  private project(delivery: HandoffDeliveryRecord): HandoffProjection {
    const task = delivery.spawnTaskId ? this.taskStore.get(delivery.spawnTaskId) : null
    return {
      delivery,
      task: task ? toHandoffTaskView(task) : null,
      unread: delivery.resultUnread !== undefined,
    }
  }

  private ensureAcknowledged(delivery: HandoffDeliveryRecord): HandoffDeliveryRecord {
    if (delivery.mailState === 'acknowledged') return delivery
    if (delivery.mailState === 'claimed' && delivery.claim) {
      return this.deliveryStore.acknowledgeDelivery(delivery.deliveryId, {
        claimId: delivery.claim.claimId,
        ownerEpoch: delivery.claim.ownerEpoch,
      })
    }
    const claim = this.deliveryStore.claimDelivery(delivery.deliveryId, {
      claimId: `claim_${this.randomId()}`,
      recipientBotId: delivery.targetBotId,
      expectedOwnerEpoch: 0,
    })
    const settled = requireClaim(delivery.deliveryId, claim.claim)
    return this.deliveryStore.acknowledgeDelivery(delivery.deliveryId, {
      claimId: settled.claimId,
      ownerEpoch: settled.ownerEpoch,
    })
  }

  /**
   * Appends the terminal journal entry unless the idempotency key already
   * exists. The journal dedupes by key, so a lost explicit check still cannot
   * append twice.
   */
  private appendTerminalEntry(delivery: HandoffDeliveryRecord, task: SpawnTask | null): boolean {
    const key = terminalKey(delivery.handoffId)
    if (this.hasJournalEntry(delivery.conversationId, key)) return false
    const failure = task?.failure ?? delivery.failure
    const body: Record<string, unknown> = {
      type: 'handoff-terminal',
      handoffId: delivery.handoffId,
      deliveryId: delivery.deliveryId,
      at: this.clock(),
    }
    if (task) {
      body.taskId = task.taskId
      body.runtimeState = task.runtimeState
      body.taskVersion = task.version
    }
    if (task?.result) body.resultPreview = task.result.preview
    if (failure) {
      body.failureCode = failure.code
      body.failureMessage = truncateUtf8(failure.message, HANDOFF_LIMITS.deliveryFailureMessageBytes)
    }
    try {
      this.resolveJournal(delivery.conversationId).append({
        conversationId: delivery.conversationId,
        kind: 'handoff',
        authorBotId: delivery.sourceBotId,
        handoffId: delivery.handoffId,
        idempotencyKey: key,
        body: JSON.stringify(body),
      })
      this.emit({ type: 'handoff-terminal', handoffId: delivery.handoffId, deliveryId: delivery.deliveryId })
      return true
    } catch {
      return false
    }
  }

  private hasJournalEntry(conversationId: string, idempotencyKey: string): boolean {
    try {
      return this.resolveJournal(conversationId)
        .list(conversationId)
        .some((entry) => entry.idempotencyKey === idempotencyKey)
    } catch {
      return false
    }
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

  private buildChildConfig(
    identity: SourceIdentity,
    target: BotRecord,
    handoffId: string,
    deliveryId: string,
  ): Record<string, SpawnTaskJsonValue> {
    const botContext = this.assembleBotContext(target)
    const config: Record<string, SpawnTaskJsonValue> = {
      name: target.name,
      llmConnection: target.providerConfig.providerId,
      model: target.providerConfig.modelId,
      permissionMode: target.permissionMode,
      handoff: {
        handoffId,
        deliveryId,
        sourceBotId: identity.sourceBotId,
        conversationId: identity.conversationId,
        ...(target.profile !== undefined
          ? { profile: truncateUtf8(target.profile, BOT_LIMITS.profileBytes) }
          : {}),
        ...(botContext ? { context: botContext } : {}),
      },
    }
    if (Buffer.byteLength(JSON.stringify(config), 'utf8') > SPAWN_TASK_LIMITS.childConfigBytes) {
      delete (config.handoff as Record<string, SpawnTaskJsonValue>).context
    }
    return config
  }

  /** Bounded profile+memory context for the receiving Bot, from its own ledger. */
  private assembleBotContext(target: BotRecord): string | undefined {
    try {
      const journal = this.resolveJournal(target.directChatId)
      const ledger = new BotContextLedger({
        workspaceRoot: this.workspaceRoot,
        workspaceId: this.workspaceId,
        botId: target.botId,
        journal,
      })
      const assembler = new ContextAssembler({ ledger, journal })
      return truncateUtf8(
        assembler.assemble({
          conversationId: target.directChatId,
          operationId: `handoff.${this.randomId()}`,
          conversationKind: 'direct',
        }).context.text,
        SPAWN_TASK_LIMITS.childConfigBytes / 2,
      )
    } catch {
      return undefined
    }
  }

  private rebuildTaskIndex(): void {
    this.byTaskId.clear()
    for (const delivery of this.deliveryStore.listAll()) {
      if (delivery.spawnTaskId) this.byTaskId.set(delivery.spawnTaskId, delivery.deliveryId)
    }
  }

  private emit(event: HandoffServiceEvent): void {
    if (!this.onHandoffEvent) return
    try {
      this.onHandoffEvent(event)
    } catch {
      // Handoff durability is authoritative; event listeners are best effort.
    }
  }
}

/** Public task view for handoff consumers: internal provider Session IDs omitted. */
export function toHandoffTaskView(task: SpawnTask): HandoffTaskView {
  const { parentSessionId: _parentSessionId, childSessionId: _childSessionId, ...view } = task
  return view
}
