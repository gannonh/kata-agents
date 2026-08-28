import { getWorkspaceByNameOrId } from '@kata-sh/shared/config'
import {
  BotDirectory,
  createDirectChatJournal,
} from '@kata-sh/shared/bots'
import {
  ChannelDirectory,
  createChannelJournal,
} from '@kata-sh/shared/channels'
import { HandoffDeliveryStore } from '@kata-sh/shared/handoffs'
import { HandoffService, type HandoffDelegate, type HandoffSessionLookup, type HandoffSpawnCoordinator, type HandoffTaskStore } from './service.ts'

export interface HandoffRuntime {
  readonly workspaceId: string
  readonly workspaceRoot: string
  readonly bots: BotDirectory
  readonly channels: ChannelDirectory
  readonly deliveryStore: HandoffDeliveryStore
  readonly service: HandoffService
}

export interface HandoffRuntimeSessionManager extends HandoffSessionLookup {
  getOrCreateWorkspaceSpawnTaskRuntime(workspaceId: string): {
    coordinator: HandoffSpawnCoordinator
    taskStore: HandoffTaskStore
  }
  setHandoffDelegateFactory(factory: ((workspaceId: string) => HandoffDelegate | undefined) | null): void
}

const runtimes = new Map<string, HandoffRuntime>()

function refreshRuntime(runtime: HandoffRuntime): HandoffRuntime {
  runtime.bots.recover()
  runtime.bots.reload()
  runtime.channels.reload()
  runtime.service.reloadDeliveries()
  return runtime
}

/**
 * Per-workspace handoff runtime cache, mirroring the Channel handler runtime
 * pattern: constructed once per workspace root, refreshed on reuse. The RPC
 * slice resolves services through this factory; SessionManager reaches the
 * same service instance through the delegate factory installed below.
 */
export function getHandoffRuntime(sessionManager: HandoffRuntimeSessionManager, workspaceId: string): HandoffRuntime {
  const workspace = getWorkspaceByNameOrId(workspaceId)
  if (!workspace) throw new Error('Workspace not found')

  const existing = runtimes.get(workspace.rootPath)
  if (existing) return refreshRuntime(existing)

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
  const deliveryStore = new HandoffDeliveryStore({ workspaceRoot: workspace.rootPath })
  const directJournal = createDirectChatJournal({ workspaceRoot: workspace.rootPath, workspaceId: workspace.id })
  const channelJournal = createChannelJournal({
    workspaceRoot: workspace.rootPath,
    workspaceId: workspace.id,
    directory: channels,
  })
  const resolveJournal = (conversationId: string) =>
    conversationId.startsWith('channel_') ? channelJournal : directJournal

  const { coordinator, taskStore } = sessionManager.getOrCreateWorkspaceSpawnTaskRuntime(workspace.id)
  const service = new HandoffService({
    workspaceId: workspace.id,
    workspaceRoot: workspace.rootPath,
    deliveryStore,
    resolveJournal,
    botDirectory: bots,
    channelDirectory: channels,
    sessionManager,
    taskStore,
    coordinator,
  })

  const runtime: HandoffRuntime = {
    workspaceId: workspace.id,
    workspaceRoot: workspace.rootPath,
    bots,
    channels,
    deliveryStore,
    service,
  }
  runtimes.set(workspace.rootPath, runtime)
  return runtime
}

/** Installs the per-workspace delegate factory so SessionManager can notify handoffs. */
export function attachHandoffDelegate(sessionManager: HandoffRuntimeSessionManager): void {
  sessionManager.setHandoffDelegateFactory((workspaceId) => {
    try {
      return getHandoffRuntime(sessionManager, workspaceId).service
    } catch {
      return undefined
    }
  })
}
