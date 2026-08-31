import type {
  BotTurnContext,
  RoutineDestination,
  RoutineRevision,
  RoutineRun,
  ToolInvocation,
} from '@kata-sh/core'
import {
  BotDirectory,
  BotContextLedger,
  ContextAssembler,
  botProviderSessionPath,
  createDirectChatJournal,
} from '@kata-sh/shared/bots'
import { ChannelDirectory, channelProviderSessionPath, createChannelJournal, RetryableStageDispatchError } from '@kata-sh/shared/channels'
import type { ConversationJournal } from '@kata-sh/shared/conversations'
import { computeOperationHash } from '@kata-sh/shared/tools'
import { getApprovalRuntime, notifyApproval } from '../approvals/runtime'
import type { ISessionManager } from '../handlers/session-manager-interface'
import {
  BotApprovalPendingError,
  BotDispatchUncertainError,
  sendToBotSession,
} from '../handlers/rpc/bot-runtime'
import type { RoutineApprovalAttempt, RoutineExecutionResult, RoutineExecutor } from './routine-engine'

const REQUESTLESS_LINK_CLEANUP_MS = 120_000

function destinationId(destination: RoutineDestination): string {
  return destination.kind === 'direct' ? destination.chatId : destination.channelId
}

function retainApprovalLink(runtime: ReturnType<typeof getApprovalRuntime>, approvalId: string, sessionId: string, requestId?: string): void {
  const cleanup = setTimeout(() => {
    const current = runtime.links.get(approvalId)
    if (current?.sessionId === sessionId && current.requestId === requestId) runtime.links.delete(approvalId)
  }, REQUESTLESS_LINK_CLEANUP_MS)
  cleanup.unref?.()
}

export interface BotRoutineExecutorOptions {
  readonly sessionManager: ISessionManager
  readonly workspaceRoot: string
  readonly workspaceId: string
  readonly clock?: () => string
}

export class BotRoutineExecutor implements RoutineExecutor {
  private readonly sessionManager: ISessionManager
  private readonly workspaceRoot: string
  private readonly workspaceId: string
  private readonly clock: () => string
  private readonly approvalInvocations = new Map<string, ToolInvocation>()

  constructor(options: BotRoutineExecutorOptions) {
    this.sessionManager = options.sessionManager
    this.workspaceRoot = options.workspaceRoot
    this.workspaceId = options.workspaceId
    this.clock = options.clock ?? (() => new Date().toISOString())
  }

  async execute(run: RoutineRun, revision: RoutineRevision): Promise<RoutineExecutionResult> {
    const bots = new BotDirectory({ workspaceRoot: this.workspaceRoot, workspaceId: this.workspaceId })
    bots.recover()
    const bot = bots.getBot(run.ownerBotId)
    if (!bot || bot.lifecycle !== 'active') return { kind: 'failed', error: 'Routine owner Bot is unavailable' }
    const destinationOwner = revision.destination.kind === 'direct'
      ? bots.getBotByChat(revision.destination.chatId)
      : null
    if (revision.destination.kind === 'direct' && destinationOwner?.botId !== bot.botId) {
      return { kind: 'failed', error: 'Routine direct destination must belong to its owner Bot' }
    }

    const journal = this.journalFor(bots, revision.destination, bot.botId)
    const conversationId = destinationId(revision.destination)
    const ledger = new BotContextLedger({
      workspaceRoot: this.workspaceRoot,
      workspaceId: this.workspaceId,
      botId: bot.botId,
      journal,
      clock: this.clock,
    })
    await ledger.reconcile(conversationId)
    const userEntry = journal.append({
      conversationId,
      kind: 'user',
      body: run.input,
      idempotencyKey: `routine.${run.runId}.input`,
    })
    const assembler = new ContextAssembler({ ledger, journal })
    const operationId = `routine.${run.runId}`
    const prepared = assembler.assemble({
      conversationId,
      operationId,
      currentEntryId: userEntry.entryId,
      conversationKind: revision.destination.kind === 'channel' ? 'channel' : 'direct',
    })
    const context: BotTurnContext = {
      ...prepared.context,
      runId: run.runId,
      operationId,
    }
    await ledger.recordRun(context)
    journal.append({
      conversationId,
      authorBotId: bot.botId,
      kind: 'lifecycle',
      body: `Routine ${run.runId} started.`,
      idempotencyKey: `routine.${run.runId}.started`,
    })

    const approvalInvocation = this.approvalInvocations.get(run.runId)
    const target = {
      workspaceId: this.workspaceId,
      botId: bot.botId,
      name: bot.name,
      permissionMode: revision.approvalBoundary,
      providerConfig: bot.providerConfig,
      sessionPointerPath: revision.destination.kind === 'channel'
        ? channelProviderSessionPath(this.workspaceRoot, revision.destination.channelId, bot.botId)
        : botProviderSessionPath(this.workspaceRoot, bot.botId),
      conversationId,
      ...(approvalInvocation ? { approvalInvocation } : {}),
    }

    try {
      const result = await sendToBotSession(
        this.sessionManager,
        target,
        run.input,
        {
          waitForReply: true,
          dispatchIdempotencyKey: `routine:${run.runId}`,
          botTurnContext: context,
          botRoutineRunId: run.runId,
          botAttempt: run.attempt,
          stopOnPendingApproval: true,
        },
      )
      this.approvalInvocations.delete(run.runId)
      if (!result.reply) return { kind: 'uncertain', reason: 'Bot provider completed without a reply' }
      return { kind: 'completed', reply: result.reply }
    } catch (error) {
      if (error instanceof BotApprovalPendingError) {
        const runtime = getApprovalRuntime(this.workspaceId)
        const link = runtime.links.get(error.record.approvalId)
        this.approvalInvocations.delete(run.runId)
        if (!link?.invocation) {
          try { await this.denyApproval(error.record.approvalId) } catch { /* uncertain state remains durable */ }
          return { kind: 'uncertain', reason: 'approval execution record is unavailable' }
        }
        return {
          kind: 'awaiting-approval',
          approvalId: error.record.approvalId,
          operationHash: error.record.operationHash,
          version: error.record.version,
          invocation: link.invocation,
          ...(link.requestId ? { requestId: link.requestId } : {}),
        }
      }
      if (error instanceof RetryableStageDispatchError || error instanceof BotDispatchUncertainError) {
        this.approvalInvocations.delete(run.runId)
        return { kind: 'uncertain', reason: 'Bot provider dispatch outcome is uncertain' }
      }
      this.approvalInvocations.delete(run.runId)
      return { kind: 'failed', error: 'Bot routine execution failed' }
    }
  }

  async validateApproval(attempt: RoutineApprovalAttempt): Promise<'pending' | 'allowed' | 'consumed' | 'denied' | 'expired' | 'stale'> {
    if (!attempt.invocation) throw new Error('Routine approval invocation is missing')
    if (attempt.invocation.workspaceId !== this.workspaceId) throw new Error('Routine approval workspace mismatch')
    const runtime = getApprovalRuntime(this.workspaceId)
    const record = runtime.store.get(attempt.approvalId)
    if (!record) throw new Error('Routine approval record is missing')
    const current = runtime.store.expireIfDue(record.approvalId)
    if (
      current.operationHash !== attempt.operationHash
      || computeOperationHash(attempt.invocation) !== attempt.operationHash
      || current.version < attempt.version
      || attempt.sessionId !== attempt.invocation.runtimeId
    ) {
      throw new Error('Routine approval record changed')
    }
    if (current.status === 'expired' || current.status === 'denied' || current.status === 'stale') return current.status
    if (current.status === 'consumed') return 'consumed'
    return current.status === 'allowed-once' ? 'allowed' : 'pending'
  }

  async claimApproval(attempt: RoutineApprovalAttempt): Promise<void> {
    if (!attempt.invocation) throw new Error('Routine approval invocation is missing')
    if (attempt.invocation.workspaceId !== this.workspaceId) throw new Error('Routine approval workspace mismatch')
    this.approvalInvocations.set(attempt.runId, attempt.invocation)
    const runtime = getApprovalRuntime(attempt.invocation.workspaceId)
    const record = runtime.store.get(attempt.approvalId)
    if (!record) throw new Error('Routine approval record is missing')
    if (record.status === 'consumed') return
    if (record.status !== 'allowed-once') throw new Error(`Routine approval is ${record.status}`)
    runtime.broker.claimExecution(attempt.approvalId, attempt.invocation)
  }

  async resolveApproval(attempt: RoutineApprovalAttempt, allowed: boolean): Promise<void> {
    if (!attempt.invocation) throw new Error('Routine approval invocation is missing')
    if (attempt.invocation.workspaceId !== this.workspaceId) throw new Error('Routine approval workspace mismatch')
    if (!allowed) {
      try {
        await this.denyApproval(attempt.approvalId, attempt.sessionId, attempt.requestId)
      } finally {
        this.approvalInvocations.delete(attempt.runId)
      }
      return
    }
    const runtime = getApprovalRuntime(attempt.invocation.workspaceId)
    const record = runtime.store.get(attempt.approvalId)
    if (!record) return
    const link = runtime.links.get(attempt.approvalId)
    const requestId = attempt.requestId ?? link?.requestId
    if (!requestId) {
      if (link) retainApprovalLink(runtime, attempt.approvalId, link.sessionId)
      return
    }
    if (link?.requestId && link.requestId !== requestId) return
    const delivered = this.sessionManager.respondToPermission(attempt.sessionId, requestId, true, false)
    if (delivered) runtime.links.delete(attempt.approvalId)
    else if (link) retainApprovalLink(runtime, attempt.approvalId, link.sessionId, link.requestId)
  }

  async denyApproval(approvalId: string, sessionId?: string, requestId?: string): Promise<void> {
    const runtime = getApprovalRuntime(this.workspaceId)
    let record = runtime.store.get(approvalId)
    let durableError: unknown
    if (record?.status === 'pending') {
      try {
        record = runtime.broker.resolve(record.approvalId, record.version, 'deny')
      } catch (error) {
        const latest = runtime.store.get(approvalId)
        if (latest?.status === 'pending') durableError = error
        else record = latest
      }
    } else if (record?.status === 'allowed-once') {
      try {
        record = runtime.store.markStale(record.approvalId)
      } catch (error) {
        const latest = runtime.store.get(approvalId)
        if (latest?.status === 'allowed-once') durableError = error
        else record = latest
      }
    }
    if (record) notifyApproval(runtime, record)
    const link = runtime.links.get(approvalId)
    if (link && (!sessionId || link.sessionId === sessionId)) {
      const linkedRequestId = requestId ?? link.requestId
      if (linkedRequestId && record?.status !== 'consumed') {
        const delivered = this.sessionManager.respondToPermission(link.sessionId, linkedRequestId, false, false)
        if (delivered) runtime.links.delete(approvalId)
        else retainApprovalLink(runtime, approvalId, link.sessionId, link.requestId)
      } else if (record?.status === 'consumed') {
        runtime.links.delete(approvalId)
      } else {
        retainApprovalLink(runtime, approvalId, link.sessionId)
      }
    } else if (!link && sessionId && requestId && record?.status !== 'consumed') {
      this.sessionManager.respondToPermission(sessionId, requestId, false, false)
    }
    if (durableError) throw durableError
  }

  async publish(run: RoutineRun, revision: RoutineRevision): Promise<void> {
    const bots = new BotDirectory({ workspaceRoot: this.workspaceRoot, workspaceId: this.workspaceId })
    bots.recover()
    const bot = bots.getBot(run.ownerBotId)
    if (!bot) return
    const journal = this.journalFor(bots, revision.destination, bot.botId)
    const conversationId = destinationId(revision.destination)
    const state = run.state
    if (state.kind === 'succeeded') {
      const botEntry = journal.append({
        conversationId,
        authorBotId: bot.botId,
        kind: 'bot',
        body: state.result,
        idempotencyKey: `routine.${run.runId}.result`,
      })
      const userEntry = journal.list(conversationId).find(entry => entry.idempotencyKey === `routine.${run.runId}.input`)
      if (userEntry?.kind === 'user') {
        const ledger = new BotContextLedger({
          workspaceRoot: this.workspaceRoot,
          workspaceId: this.workspaceId,
          botId: bot.botId,
          journal,
          clock: this.clock,
        })
        await ledger.completeTurn({ userEntry, replyEntry: botEntry, operationId: `routine.${run.runId}` })
      }
      return
    }
    if (state.kind === 'failed' || state.kind === 'cancelled' || state.kind === 'uncertain' || state.kind === 'reconciled') {
      const detail = 'error' in state ? state.error : 'reason' in state ? state.reason : state.result
      journal.append({
        conversationId,
        authorBotId: bot.botId,
        kind: state.kind === 'failed' ? 'error' : 'lifecycle',
        body: `Routine ${run.runId}: ${detail}`,
        idempotencyKey: `routine.${run.runId}.${state.kind}`,
      })
      return
    }
    if (state.kind === 'awaiting-approval') {
      journal.append({
        conversationId,
        authorBotId: bot.botId,
        kind: 'lifecycle',
        body: `Routine ${run.runId} is awaiting approval.`,
        idempotencyKey: `routine.${run.runId}.awaiting-approval`,
      })
    }
  }

  private journalFor(bots: BotDirectory, destination: RoutineDestination, ownerBotId: string): ConversationJournal {
    if (destination.kind === 'direct') {
      const bot = bots.getBotByChat(destination.chatId)
      if (!bot || bot.workspaceId !== this.workspaceId) throw new Error('Routine direct destination is not owned by a Bot')
      return createDirectChatJournal({ workspaceRoot: this.workspaceRoot, workspaceId: this.workspaceId, clock: this.clock })
    }
    const channels = new ChannelDirectory({
      workspaceRoot: this.workspaceRoot,
      workspaceId: this.workspaceId,
      resolveBot: botId => {
        const bot = bots.getBot(botId)
        return bot
          ? { botId: bot.botId, name: bot.name, ...(bot.profile !== undefined ? { profile: bot.profile } : {}), lifecycle: bot.lifecycle }
          : null
      },
    })
    const channel = channels.getChannel(destination.channelId)
    if (!channel || channel.lifecycle !== 'active' || !channels.isMember(destination.channelId, ownerBotId)) {
      throw new Error('Routine channel destination is unavailable to its owner Bot')
    }
    return createChannelJournal({
      workspaceRoot: this.workspaceRoot,
      workspaceId: this.workspaceId,
      directory: channels,
      clock: this.clock,
    })
  }
}
