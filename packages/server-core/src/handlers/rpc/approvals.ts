import { RPC_CHANNELS, toApprovalCardView } from '@kata-sh/shared/protocol'
import { getWorkspaceByNameOrId } from '@kata-sh/shared/config'
import { pushTyped, type RpcServer } from '@kata-sh/server-core/transport'
import { ApprovalConflictError } from '@kata-sh/shared/tools'
import type { HandlerDeps } from '../handler-deps'
import {
  getApprovalRuntime,
  journalFor,
  listApprovalCards,
  notifyApproval,
  subscribeApprovalEvents,
  type ApprovalRuntime,
} from '../../approvals/runtime'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.approvals.LIST,
  RPC_CHANNELS.approvals.RESOLVE,
  RPC_CHANNELS.approvals.LIST_STANDING_RULES,
  RPC_CHANNELS.approvals.DISABLE_STANDING_RULE,
  RPC_CHANNELS.approvals.DELETE_STANDING_RULE,
] as const

function runtimeFor(ctx: { workspaceId: string | null }, workspaceId?: string): ApprovalRuntime {
  const id = workspaceId ?? ctx.workspaceId
  if (!id) throw new Error('Workspace not found')
  const workspace = getWorkspaceByNameOrId(id)
  if (!workspace || (ctx.workspaceId && ctx.workspaceId !== workspace.id)) throw new Error('Workspace access denied')
  return getApprovalRuntime(workspace.id)
}

function assertConversation(runtime: ApprovalRuntime, conversationId: string): void {
  if (conversationId.startsWith('channel_')) {
    journalFor(runtime, conversationId)
    return
  }
  const bot = runtime.bots.listBots({ lifecycle: 'all' }).find((candidate) => candidate.directChatId === conversationId)
  if (!bot || bot.workspaceId !== runtime.workspaceId) throw new Error('Conversation not found')
}

export function registerApprovalsHandlers(server: RpcServer, deps: HandlerDeps): void {
  const { sessionManager } = deps

  subscribeApprovalEvents((event) => {
    try {
      pushTyped(server, RPC_CHANNELS.approvals.EVENT, { to: 'workspace', workspaceId: event.workspaceId }, event)
      if (event.conversationId.startsWith('channel_')) {
        const runtime = getApprovalRuntime(event.workspaceId)
        pushTyped(server, RPC_CHANNELS.channels.EVENT, { to: 'workspace', workspaceId: event.workspaceId }, {
          type: 'journal-updated',
          channelId: event.conversationId,
          throughSeq: journalFor(runtime, event.conversationId).getHeadSequence(event.conversationId),
        })
      } else {
        pushTyped(server, RPC_CHANNELS.bots.EVENT, { to: 'workspace', workspaceId: event.workspaceId }, {
          type: 'journal-updated',
          botId: event.botId,
          chatId: event.conversationId,
        })
      }
    } catch (error) {
      console.error('[Approvals] Failed to push invalidation after durable commit', error)
    }
  })

  server.handle(RPC_CHANNELS.approvals.LIST, async (ctx, conversationId: string) => {
    const runtime = runtimeFor(ctx)
    assertConversation(runtime, conversationId)
    return listApprovalCards(runtime, conversationId)
  })

  server.handle(
    RPC_CHANNELS.approvals.RESOLVE,
    async (ctx, input: { approvalId: string; expectedVersion: number; choice: 'deny' | 'allow-once'; createStandingAllow?: boolean }) => {
      const runtime = runtimeFor(ctx)
      const before = runtime.store.get(input.approvalId)
      if (!before || before.workspaceId !== runtime.workspaceId) throw new ApprovalConflictError('unauthorized')
      assertConversation(runtime, before.conversationId)
      const record = runtime.broker.resolve(input.approvalId, input.expectedVersion, input.choice)
      if (input.choice === 'allow-once' && input.createStandingAllow) {
        runtime.broker.createStandingAllow(record, 'allow')
      }
      const link = runtime.links.get(record.approvalId)
      if (link?.requestId) {
        if (input.choice === 'allow-once') {
          try {
            runtime.broker.claimExecution(record.approvalId, link.invocation)
          } catch (error) {
            sessionManager.respondToPermission(link.sessionId, link.requestId, false, false)
            throw error
          }
        }
        sessionManager.respondToPermission(link.sessionId, link.requestId, input.choice === 'allow-once', false)
      }
      notifyApproval(runtime, runtime.store.get(record.approvalId) ?? record)
      return toApprovalCardView(runtime.store.get(record.approvalId) ?? record)
    },
  )

  server.handle(RPC_CHANNELS.approvals.LIST_STANDING_RULES, async (ctx, botId?: string) => {
    const runtime = runtimeFor(ctx)
    if (botId) {
      const bot = runtime.bots.getBot(botId)
      if (!bot || bot.workspaceId !== runtime.workspaceId) throw new Error('Bot not found')
    }
    return runtime.rules.list(botId)
  })

  server.handle(
    RPC_CHANNELS.approvals.DISABLE_STANDING_RULE,
    async (ctx, input: { ruleId: string; expectedVersion: number }) => {
      const runtime = runtimeFor(ctx)
      const current = runtime.rules.get(input.ruleId)
      if (!current || current.workspaceId !== runtime.workspaceId) throw new ApprovalConflictError('unauthorized')
      return runtime.rules.disable(input.ruleId, input.expectedVersion)
    },
  )

  server.handle(RPC_CHANNELS.approvals.DELETE_STANDING_RULE, async (ctx, input: { ruleId: string }) => {
    const runtime = runtimeFor(ctx)
    const current = runtime.rules.get(input.ruleId)
    if (!current || current.workspaceId !== runtime.workspaceId) throw new ApprovalConflictError('unauthorized')
    runtime.rules.delete(input.ruleId)
    return { deleted: true as const }
  })
}
