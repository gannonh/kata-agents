import type { BotPermissionMode, BotTurnContext, KatacodeTaskCardView, KatacodeTaskRailView } from '@kata-sh/core'
import {
  KatacodeAttemptStore,
  KatacodeExecutionBridge,
  KatacodeHttpAdapter,
  mintKatacodeIdempotencyKey,
  resolveKatacodeDispatchIdentity,
  verifyKatacodeCallback,
  type KatacodeJournalSink,
  type KatacodeWorktreeAllocator,
} from '@kata-sh/shared/katacode'
import { getCredentialManager } from '@kata-sh/shared/credentials'
import type { ConversationJournal } from '@kata-sh/shared/conversations'
import type { DispatchKatacodeRequest, DispatchKatacodeResult } from '@kata-sh/shared/agent'
import { SpawnTaskStore } from '@kata-sh/shared/spawn-tasks'
import type { BotDirectory } from '@kata-sh/shared/bots'
import type { ChannelDirectory } from '@kata-sh/shared/channels'

export class KatacodeAccessError extends Error {
  constructor() {
    super('Katacode task is not available in this conversation')
  }
}

export interface KatacodeServiceEvent {
  readonly type: 'katacode-updated'
  readonly conversationId: string
  readonly taskId: string
}

export interface KatacodeCaller {
  readonly parentSessionId: string
  readonly permissionMode: BotPermissionMode
  readonly context: BotTurnContext
}

export interface KatacodeServiceOptions {
  readonly workspaceId: string
  readonly workspaceRoot: string
  readonly taskStore: SpawnTaskStore
  readonly attempts: KatacodeAttemptStore
  readonly worktrees: KatacodeWorktreeAllocator
  readonly resolveJournal: (conversationId: string) => ConversationJournal
  readonly botDirectory: Pick<BotDirectory, 'getBot' | 'listBots'>
  readonly channelDirectory: Pick<ChannelDirectory, 'getChannel'>
  readonly resolveCaller: (sessionId: string) => KatacodeCaller | null
  readonly onEvent?: (event: KatacodeServiceEvent) => void
  readonly getEndpoint?: () => string | null
  readonly getCredential?: () => Promise<string | null>
}

function configuredEndpoint(): string | null {
  const value = process.env.KATA_KATACODE_URL ?? process.env.KATA_E2E_KATACODE_URL
  return value && value.trim() ? value.trim() : null
}

export class KatacodeService {
  private readonly workspaceId: string
  private readonly taskStore: SpawnTaskStore
  private readonly resolveJournal: KatacodeServiceOptions['resolveJournal']
  private readonly botDirectory: KatacodeServiceOptions['botDirectory']
  private readonly channelDirectory: KatacodeServiceOptions['channelDirectory']
  private readonly resolveCaller: KatacodeServiceOptions['resolveCaller']
  private readonly onEvent?: KatacodeServiceOptions['onEvent']
  private readonly getEndpoint: () => string | null
  private readonly bridge: KatacodeExecutionBridge

  constructor(options: KatacodeServiceOptions) {
    this.workspaceId = options.workspaceId
    this.taskStore = options.taskStore
    this.resolveJournal = options.resolveJournal
    this.botDirectory = options.botDirectory
    this.channelDirectory = options.channelDirectory
    this.resolveCaller = options.resolveCaller
    this.onEvent = options.onEvent
    this.getEndpoint = options.getEndpoint ?? configuredEndpoint
    const journal: KatacodeJournalSink = {
      appendTask: (input) => this.resolveJournal(input.conversationId).append({
        conversationId: input.conversationId,
        authorBotId: input.authorBotId,
        taskId: input.taskId,
        kind: 'task',
        idempotencyKey: input.idempotencyKey,
        body: input.body,
      }),
    }
    this.bridge = new KatacodeExecutionBridge({
      workspaceId: options.workspaceId,
      taskStore: options.taskStore,
      attempts: options.attempts,
      adapter: new KatacodeHttpAdapter({
        endpoint: this.getEndpoint() ?? 'https://katacode.invalid',
        getCredential: options.getCredential ?? (() => getCredentialManager().getKatacodeCredential(options.workspaceId)),
      }),
      worktrees: options.worktrees,
      journal,
      resolveBotName: (botId) => this.botDirectory.getBot(botId)?.name ?? botId,
    })
  }

  async dispatchFromSession(callerSessionId: string, request: DispatchKatacodeRequest): Promise<DispatchKatacodeResult> {
    if (!this.getEndpoint()) throw new Error('Katacode endpoint is not configured')
    const caller = this.requireCaller(callerSessionId)
    const identity = resolveKatacodeDispatchIdentity({
      context: { ...caller.context, text: request.prompt },
      parentSessionId: caller.parentSessionId,
      botPermissionMode: request.permissionMode ?? caller.permissionMode,
      fields: {
        repository: request.repository,
        prompt: request.prompt,
        acceptanceCriteria: request.acceptanceCriteria,
        permissionMode: request.permissionMode,
        worktreePolicy: request.worktreePolicy,
        sharedWorktreeId: request.sharedWorktreeId,
      },
    })
    const result = await this.bridge.dispatch({
      identity,
      clientIdempotencyKey: mintKatacodeIdempotencyKey(),
      // dispatchFromSession runs only after the session-tool approval boundary
      // (safe blocks; ask pauses; allow-all proceeds). That is the explicit
      // shared-checkout warning/approval.
      sharedApproved: identity.worktreePolicy === 'shared',
    })
    this.emit(identity.conversationId, result.taskId)
    return result
  }

  listConversationRails(conversationId: string): KatacodeTaskRailView[] {
    this.assertConversation(conversationId)
    return this.taskStore.listByConversation(conversationId).flatMap((task) => {
      try {
        return [this.rail(conversationId, task.taskId)]
      } catch {
        return []
      }
    })
  }

  listConversationCards(conversationId: string): KatacodeTaskCardView[] {
    this.assertConversation(conversationId)
    return this.bridge.listConversationCards(conversationId)
  }

  getRail(conversationId: string, taskId: string): KatacodeTaskRailView {
    this.assertConversation(conversationId)
    return this.rail(conversationId, taskId)
  }

  async cancel(conversationId: string, taskId: string, reason: string): Promise<KatacodeTaskRailView> {
    this.assertOwned(conversationId, taskId)
    await this.bridge.cancel(taskId, reason)
    this.emit(conversationId, taskId)
    return this.rail(conversationId, taskId)
  }

  async retry(conversationId: string, taskId: string): Promise<KatacodeTaskRailView> {
    this.assertOwned(conversationId, taskId)
    const task = this.taskStore.get(taskId)
    if (!task || task.origin?.kind !== 'katacode') throw new KatacodeAccessError()
    const current = this.rail(conversationId, taskId)
    const permissionMode = typeof task.childConfig.permissionMode === 'string'
      && (task.childConfig.permissionMode === 'safe' || task.childConfig.permissionMode === 'ask' || task.childConfig.permissionMode === 'allow-all')
      ? task.childConfig.permissionMode
      : 'ask'
    const identity = resolveKatacodeDispatchIdentity({
      context: {
        runId: `run_${task.parentSessionId}`,
        operationId: `op_retry_${task.taskId}`,
        workspaceId: this.workspaceId,
        botId: task.origin.ownerBotId,
        conversationId,
        journalCursor: 0,
        conversationCursor: 0,
        memoryRevision: 1,
        checkpointRevision: 1,
        text: task.delegatedPrompt,
        memoryIds: [],
      },
      parentSessionId: task.parentSessionId,
      botPermissionMode: permissionMode,
      fields: {
        repository: current.repositoryLabel,
        prompt: task.delegatedPrompt,
        acceptanceCriteria: typeof task.childConfig.acceptanceCriteria === 'string'
          ? task.childConfig.acceptanceCriteria
          : '',
        worktreePolicy: current.worktreePolicy,
      },
    })
    const result = await this.bridge.retry(taskId, identity)
    this.emit(conversationId, result.taskId)
    return this.rail(conversationId, result.taskId)
  }

  async reconcile(conversationId: string, taskId: string): Promise<KatacodeTaskRailView> {
    this.assertOwned(conversationId, taskId)
    await this.bridge.reconcile(taskId)
    this.emit(conversationId, taskId)
    return this.rail(conversationId, taskId)
  }

  async refresh(conversationId: string, taskId: string): Promise<KatacodeTaskRailView> {
    this.assertOwned(conversationId, taskId)
    await this.bridge.refresh(taskId)
    this.emit(conversationId, taskId)
    return this.rail(conversationId, taskId)
  }

  markResultRead(conversationId: string, taskId: string, expectedTaskVersion: number): KatacodeTaskRailView {
    this.assertOwned(conversationId, taskId)
    const task = this.taskStore.get(taskId)
    if (!task || task.version !== expectedTaskVersion) throw new KatacodeAccessError()
    this.taskStore.markResultRead(taskId, new Date().toISOString())
    this.emit(conversationId, taskId)
    return this.rail(conversationId, taskId)
  }

  handleAuthenticatedCallback(input: {
    readonly timestamp: string
    readonly body: string
    readonly signature: string
    readonly secret: string
  }): boolean {
    if (!verifyKatacodeCallback(input)) return false
    try {
      const payload = JSON.parse(input.body) as { taskId?: string; conversationId?: string }
      if (typeof payload.taskId === 'string' && typeof payload.conversationId === 'string') {
        void this.refresh(payload.conversationId, payload.taskId)
      }
    } catch {
      return false
    }
    return true
  }

  private requireCaller(sessionId: string): KatacodeCaller {
    const caller = this.resolveCaller(sessionId)
    if (!caller) throw new Error('dispatch_katacode is only available on Bot conversations')
    return caller
  }

  private rail(conversationId: string, taskId: string): KatacodeTaskRailView {
    const entries = this.resolveJournal(conversationId).list(conversationId)
    const journalSequence = entries.at(-1)?.seq ?? 0
    const rail = this.bridge.rail(taskId, journalSequence)
    if (rail.conversationId !== conversationId) throw new KatacodeAccessError()
    return rail
  }

  private assertConversation(conversationId: string): void {
    if (conversationId.startsWith('channel_')) {
      const channel = this.channelDirectory.getChannel(conversationId)
      if (!channel || channel.workspaceId !== this.workspaceId) throw new KatacodeAccessError()
      return
    }
    const bot = this.botDirectory.listBots({ lifecycle: 'all' }).find((candidate) => candidate.directChatId === conversationId)
    if (!bot || bot.workspaceId !== this.workspaceId) throw new KatacodeAccessError()
  }

  private assertOwned(conversationId: string, taskId: string): void {
    this.assertConversation(conversationId)
    const task = this.taskStore.get(taskId)
    if (!task || task.origin?.kind !== 'katacode' || task.origin.conversationId !== conversationId) {
      throw new KatacodeAccessError()
    }
  }

  private emit(conversationId: string, taskId: string): void {
    this.onEvent?.({ type: 'katacode-updated', conversationId, taskId })
  }
}
