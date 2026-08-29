import { getWorkspaceByNameOrId } from '@kata-sh/shared/config'
import {
  BotDirectory,
  createDirectChatJournal,
} from '@kata-sh/shared/bots'
import {
  ChannelDirectory,
  createChannelJournal,
} from '@kata-sh/shared/channels'
import type { ApprovalPending, ApprovalRecord, ToolInvocation } from '@kata-sh/core'
import {
  ApprovalStore,
  StandingRuleStore,
  ToolBroker,
} from '@kata-sh/shared/tools'
import type { ConversationJournal } from '@kata-sh/shared/conversations'
import { toApprovalCardView, type ApprovalCardView, type ApprovalInvalidatedEvent } from '@kata-sh/shared/protocol'

export interface ApprovalPermissionLink {
  sessionId: string
  requestId?: string
  invocation: ToolInvocation
}

export interface ApprovalRuntime {
  readonly workspaceId: string
  readonly workspaceRoot: string
  readonly bots: BotDirectory
  readonly broker: ToolBroker
  readonly store: ApprovalStore
  readonly rules: StandingRuleStore
  readonly directJournal: ConversationJournal
  readonly channelJournal: ConversationJournal
  readonly links: Map<string, ApprovalPermissionLink>
}

const runtimes = new Map<string, ApprovalRuntime>()
const eventListeners = new Set<(event: ApprovalInvalidatedEvent) => void>()

export function subscribeApprovalEvents(listener: (event: ApprovalInvalidatedEvent) => void): () => void {
  eventListeners.add(listener)
  return () => eventListeners.delete(listener)
}

function notify(event: ApprovalInvalidatedEvent): void {
  for (const listener of eventListeners) {
    try {
      listener(event)
    } catch (error) {
      console.error('[Approvals] Event listener failed after durable commit', error)
    }
  }
}

function refresh(runtime: ApprovalRuntime): ApprovalRuntime {
  runtime.bots.recover()
  runtime.bots.reload()
  runtime.store.reload()
  runtime.rules.reload()
  return runtime
}

export function getApprovalRuntime(workspaceId: string): ApprovalRuntime {
  const workspace = getWorkspaceByNameOrId(workspaceId)
  if (!workspace) throw new Error('Workspace not found')
  const existing = runtimes.get(workspace.rootPath)
  if (existing) return refresh(existing)

  const bots = new BotDirectory({ workspaceRoot: workspace.rootPath, workspaceId: workspace.id })
  bots.recover()
  const channels = new ChannelDirectory({
    workspaceRoot: workspace.rootPath,
    workspaceId: workspace.id,
    resolveBot: (botId) => {
      const bot = bots.getBot(botId)
      return bot
        ? { botId: bot.botId, name: bot.name, ...(bot.profile !== undefined ? { profile: bot.profile } : {}), lifecycle: bot.lifecycle }
        : null
    },
  })
  const store = new ApprovalStore({ workspaceRoot: workspace.rootPath, workspaceId: workspace.id })
  const rules = new StandingRuleStore({ workspaceRoot: workspace.rootPath, workspaceId: workspace.id })
  const runtime: ApprovalRuntime = {
    workspaceId: workspace.id,
    workspaceRoot: workspace.rootPath,
    bots,
    store,
    rules,
    broker: new ToolBroker(store, rules, { workspaceId: workspace.id }),
    directJournal: createDirectChatJournal({ workspaceRoot: workspace.rootPath, workspaceId: workspace.id }),
    channelJournal: createChannelJournal({ workspaceRoot: workspace.rootPath, workspaceId: workspace.id, directory: channels }),
    links: new Map(),
  }
  runtimes.set(workspace.rootPath, runtime)
  return runtime
}

export function journalFor(runtime: ApprovalRuntime, conversationId: string): ConversationJournal {
  return conversationId.startsWith('channel_') ? runtime.channelJournal : runtime.directJournal
}

export function announceApproval(runtime: ApprovalRuntime, record: ApprovalPending): void {
  const journal = journalFor(runtime, record.conversationId)
  journal.append({
    conversationId: record.conversationId,
    kind: 'approval',
    authorBotId: record.botId,
    approvalId: record.approvalId,
    body: `${record.sanitized.toolName} ${record.sanitized.target}`.trim(),
    idempotencyKey: `approval.${record.approvalId}`,
  })
  notify({
    workspaceId: runtime.workspaceId,
    conversationId: record.conversationId,
    approvalId: record.approvalId,
    botId: record.botId,
  })
}

export function notifyApproval(runtime: ApprovalRuntime, record: ApprovalRecord): void {
  notify({
    workspaceId: runtime.workspaceId,
    conversationId: record.conversationId,
    approvalId: record.approvalId,
    botId: record.botId,
  })
}

export function listApprovalCards(runtime: ApprovalRuntime, conversationId: string): ApprovalCardView[] {
  return runtime.store.listForConversation(conversationId).map((record) => {
    if (record.status === 'pending') {
      try {
        return toApprovalCardView(runtime.store.expireIfDue(record.approvalId))
      } catch {
        return toApprovalCardView(record)
      }
    }
    return toApprovalCardView(record)
  })
}
