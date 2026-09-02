import { getWorkspaceByNameOrId } from '@kata-sh/shared/config'
import {
  BotDirectory,
  createDirectChatJournal,
} from '@kata-sh/shared/bots'
import {
  ChannelDirectory,
  createChannelJournal,
} from '@kata-sh/shared/channels'
import { KatacodeAttemptStore } from '@kata-sh/shared/katacode'
import { SpawnTaskStore } from '@kata-sh/shared/spawn-tasks'
import type { DispatchKatacodeResult } from '@kata-sh/shared/agent'
import { getDefaultGitServices } from '../git'
import {
  KatacodeService,
  type KatacodeCaller,
  type KatacodeServiceEvent,
} from './service.ts'
import { createManagedKatacodeWorktreeAllocator } from './worktree-allocator.ts'

export interface KatacodeRuntime {
  readonly workspaceId: string
  readonly workspaceRoot: string
  readonly bots: BotDirectory
  readonly channels: ChannelDirectory
  readonly service: KatacodeService
}

export interface KatacodeRuntimeSessionManager {
  getOrCreateWorkspaceSpawnTaskRuntime(workspaceId: string): {
    taskStore: SpawnTaskStore
  }
  getKatacodeCaller(sessionId: string): KatacodeCaller | null
  setKatacodeDelegateFactory(factory: ((workspaceId: string) => KatacodeDelegate | undefined) | null): void
}

export interface KatacodeDelegate {
  dispatchKatacode(callerSessionId: string, request: {
    repository: string
    prompt: string
    acceptanceCriteria: string
    permissionMode?: KatacodeCaller['permissionMode']
    worktreePolicy?: 'isolated' | 'shared'
    sharedWorktreeId?: string
  }): Promise<DispatchKatacodeResult>
}

const runtimes = new Map<string, KatacodeRuntime>()
const eventListeners = new Set<(workspaceId: string, event: KatacodeServiceEvent) => void>()

function notifyListeners(workspaceId: string, event: KatacodeServiceEvent): void {
  for (const listener of eventListeners) {
    try {
      listener(workspaceId, event)
    } catch (error) {
      console.error('[Katacode] Event listener failed after durable commit', error)
    }
  }
}

export function subscribeKatacodeEvents(
  listener: (workspaceId: string, event: KatacodeServiceEvent) => void,
): () => void {
  eventListeners.add(listener)
  return () => eventListeners.delete(listener)
}

export function getKatacodeRuntime(
  sessionManager: KatacodeRuntimeSessionManager,
  workspaceId: string,
): KatacodeRuntime {
  const workspace = getWorkspaceByNameOrId(workspaceId)
  if (!workspace) throw new Error('Workspace not found')

  const existing = runtimes.get(workspace.rootPath)
  if (existing) return existing

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
  const directJournal = createDirectChatJournal({ workspaceRoot: workspace.rootPath, workspaceId: workspace.id })
  const channelJournal = createChannelJournal({
    workspaceRoot: workspace.rootPath,
    workspaceId: workspace.id,
    directory: channels,
  })
  const resolveJournal = (conversationId: string) =>
    conversationId.startsWith('channel_') ? channelJournal : directJournal

  const { taskStore } = sessionManager.getOrCreateWorkspaceSpawnTaskRuntime(workspace.id)
  const attempts = new KatacodeAttemptStore({
    workspaceRoot: workspace.rootPath,
    workspaceId: workspace.id,
  })
  const git = getDefaultGitServices()
  const service = new KatacodeService({
    workspaceId: workspace.id,
    workspaceRoot: workspace.rootPath,
    taskStore,
    attempts,
    worktrees: createManagedKatacodeWorktreeAllocator({
      git,
      workspaceRoot: workspace.rootPath,
      workspaceName: workspace.name ?? workspace.id,
    }),
    resolveJournal,
    botDirectory: bots,
    channelDirectory: channels,
    resolveCaller: (sessionId) => sessionManager.getKatacodeCaller(sessionId),
    onEvent: (event) => notifyListeners(workspace.id, event),
  })

  const runtime: KatacodeRuntime = {
    workspaceId: workspace.id,
    workspaceRoot: workspace.rootPath,
    bots,
    channels,
    service,
  }
  runtimes.set(workspace.rootPath, runtime)
  return runtime
}

export function attachKatacodeDelegate(sessionManager: KatacodeRuntimeSessionManager): void {
  sessionManager.setKatacodeDelegateFactory((workspaceId) => {
    try {
      const service = getKatacodeRuntime(sessionManager, workspaceId).service
      return {
        dispatchKatacode: (callerSessionId, request) => service.dispatchFromSession(callerSessionId, request),
      }
    } catch {
      return undefined
    }
  })
}
