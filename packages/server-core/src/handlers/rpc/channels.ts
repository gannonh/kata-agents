import { randomUUID } from 'node:crypto'
import { RPC_CHANNELS } from '@kata-sh/shared/protocol'
import { getWorkspaceByNameOrId } from '@kata-sh/shared/config'
import { createBackendFromConnection, type AgentBackend } from '@kata-sh/shared/agent/backend'
import {
  ChannelDirectory,
  ChannelRouter,
  RouteStore,
  buildClaimPrompt,
  createChannelJournal,
  channelProviderSessionPath,
  toChannelPublicDto,
  type ClaimEvaluator,
  type DispatchRequest,
} from '@kata-sh/shared/channels'
import { BotDirectory, toBotPublicDto } from '@kata-sh/shared/bots'
import type {
  BotRecord,
  ChannelPublicDto,
  RouteRecord,
} from '@kata-sh/core'
import { pushTyped, type RpcServer } from '@kata-sh/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { sendToBotSession } from './bot-runtime'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.channels.LIST,
  RPC_CHANNELS.channels.GET,
  RPC_CHANNELS.channels.CREATE,
  RPC_CHANNELS.channels.RENAME,
  RPC_CHANNELS.channels.ARCHIVE,
  RPC_CHANNELS.channels.REOPEN,
  RPC_CHANNELS.channels.DELETE,
  RPC_CHANNELS.channels.ADD_MEMBER,
  RPC_CHANNELS.channels.REMOVE_MEMBER,
  RPC_CHANNELS.channels.GET_JOURNAL,
  RPC_CHANNELS.channels.SEND_MESSAGE,
  RPC_CHANNELS.channels.LIST_ROUTES,
] as const

type ChannelEvent =
  | { type: 'channel-created'; channel: ChannelPublicDto }
  | { type: 'channel-updated'; channel: ChannelPublicDto }
  | { type: 'channel-deleted'; channelId: string }
  | { type: 'journal-updated'; channelId: string; throughSeq: number }
  | { type: 'route-updated'; channelId: string; route: RouteRecord }

interface ChannelRuntime {
  readonly workspace: NonNullable<ReturnType<typeof getWorkspaceByNameOrId>>
  readonly bots: BotDirectory
  readonly directory: ChannelDirectory
  readonly journal: ReturnType<typeof createChannelJournal>
  readonly routes: RouteStore
}

const runtimes = new Map<string, ChannelRuntime>()

function refreshRuntime(runtime: ChannelRuntime): ChannelRuntime {
  runtime.bots.recover()
  runtime.bots.reload()
  runtime.directory.reload()
  return runtime
}

function requireWorkspace(ctx: { workspaceId: string | null }, workspaceId: string) {
  const workspace = getWorkspaceByNameOrId(workspaceId)
  if (!workspace) throw new Error('Workspace not found')
  if (ctx.workspaceId && ctx.workspaceId !== workspace.id) throw new Error('Workspace access denied')
  return workspace
}

function botView(bot: BotRecord) {
  return {
    botId: bot.botId,
    name: bot.name,
    ...(bot.profile !== undefined ? { profile: bot.profile } : {}),
    lifecycle: bot.lifecycle,
  }
}

function hostRuntime(deps: HandlerDeps) {
  return {
    appRootPath: deps.platform.appRootPath,
    resourcesPath: deps.platform.resourcesPath,
    isPackaged: deps.platform.isPackaged,
  }
}

function openRuntime(ctx: { workspaceId: string | null }, workspaceId: string, deps: HandlerDeps): ChannelRuntime {
  const workspace = requireWorkspace(ctx, workspaceId)
  const existing = runtimes.get(workspace.rootPath)
  if (existing) return refreshRuntime(existing)

  const bots = new BotDirectory({ workspaceRoot: workspace.rootPath, workspaceId: workspace.id })
  bots.recover()
  const directory = new ChannelDirectory({
    workspaceRoot: workspace.rootPath,
    workspaceId: workspace.id,
    resolveBot: (botId) => {
      const bot = bots.getBot(botId)
      return bot ? botView(bot) : null
    },
  })
  const runtime: ChannelRuntime = {
    workspace,
    bots,
    directory,
    journal: createChannelJournal({ workspaceRoot: workspace.rootPath, workspaceId: workspace.id, directory }),
    routes: new RouteStore({ workspaceRoot: workspace.rootPath, workspaceId: workspace.id }),
  }
  runtimes.set(workspace.rootPath, runtime)
  return runtime
}

function emit(server: RpcServer, workspaceId: string, event: ChannelEvent): void {
  pushTyped(server, RPC_CHANNELS.channels.EVENT, { to: 'workspace', workspaceId }, event)
}

function createProviderClaimEvaluator(
  deps: HandlerDeps,
  workspace: NonNullable<ReturnType<typeof getWorkspaceByNameOrId>>,
  bots: BotDirectory,
): ClaimEvaluator {
  return async (request, signal) => {
    const bot = bots.getBot(request.botId)
    if (!bot) return null
    const agent = createBackendFromConnection(bot.providerConfig.providerId, {
      workspace,
      model: bot.providerConfig.modelId,
      miniModel: bot.providerConfig.modelId,
      isHeadless: true,
      systemPromptPreset: 'mini',
      session: {
        id: `channel-claim-${request.routeId}-${bot.botId}`,
        workspaceRootPath: workspace.rootPath,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        model: bot.providerConfig.modelId,
        llmConnection: bot.providerConfig.providerId,
      },
    }, hostRuntime(deps)) as AgentBackend & { runMiniCompletion(prompt: string): Promise<string | null> }
    let removeAbortListener: (() => void) | undefined
    try {
      const aborted = new Promise<string | null>((resolve) => {
        if (signal.aborted) {
          resolve(null)
          return
        }
        const onAbort = () => resolve(null)
        signal.addEventListener('abort', onAbort, { once: true })
        removeAbortListener = () => signal.removeEventListener('abort', onAbort)
      })
      return await Promise.race([
        agent.runMiniCompletion(buildClaimPrompt(request)),
        aborted,
      ])
    } finally {
      removeAbortListener?.()
      agent.destroy()
    }
  }
}

function createStageDispatcher(
  deps: HandlerDeps,
  runtime: ChannelRuntime,
  callerClientId?: string,
) {
  return async (request: DispatchRequest): Promise<string> => {
    const bot = runtime.bots.getBot(request.ownerBotId)
    if (!bot) throw new Error(`Bot not found: ${request.ownerBotId}`)
    const message = request.isFirstDispatch
      ? `You are ${bot.name} in the Channel "${request.channelName}". Channel members: ${request.memberNames.join(', ') || '(none)'}.\n\n${request.message}`
      : request.message
    const result = await sendToBotSession(
      deps.sessionManager,
      {
        workspaceId: runtime.workspace.id,
        name: bot.name,
        permissionMode: bot.permissionMode,
        providerConfig: bot.providerConfig,
        sessionPointerPath: channelProviderSessionPath(runtime.directory.rootPath, request.channelId, bot.botId),
      },
      message,
      { callerClientId, waitForReply: true },
    )
    if (result.reply === null) throw new Error('Bot did not return a reply')
    return result.reply
  }
}

function routerFor(
  deps: HandlerDeps,
  runtime: ChannelRuntime,
  callerClientId?: string,
): ChannelRouter {
  return new ChannelRouter({
    directory: runtime.directory,
    journal: runtime.journal,
    routes: runtime.routes,
    evaluateClaim: createProviderClaimEvaluator(deps, runtime.workspace, runtime.bots),
    dispatch: createStageDispatcher(deps, runtime, callerClientId),
  })
}

function membersFor(runtime: ChannelRuntime, channelId: string) {
  const channel = runtime.directory.getChannel(channelId)
  if (!channel) throw new Error('Channel not found')
  return channel.members.flatMap((member) => {
    const bot = runtime.bots.getBot(member.botId)
    return bot ? [toBotPublicDto(bot)] : []
  })
}

export function registerChannelsHandlers(server: RpcServer, deps: HandlerDeps): void {
  server.handle(RPC_CHANNELS.channels.LIST, async (ctx, workspaceId: string, filter?: { lifecycle?: 'active' | 'archived' | 'all' }) => {
    const runtime = openRuntime(ctx, workspaceId, deps)
    return runtime.directory.listChannels(filter).map(toChannelPublicDto)
  })

  server.handle(RPC_CHANNELS.channels.GET, async (ctx, workspaceId: string, channelId: string) => {
    const runtime = openRuntime(ctx, workspaceId, deps)
    const channel = runtime.directory.getChannel(channelId)
    if (!channel) throw new Error('Channel not found')
    return toChannelPublicDto(channel)
  })

  server.handle(RPC_CHANNELS.channels.CREATE, async (
    ctx,
    workspaceId: string,
    input: { name: string; botIds?: string[]; idempotencyKey?: string },
  ) => {
    const runtime = openRuntime(ctx, workspaceId, deps)
    const channel = runtime.directory.createChannel({
      name: input.name,
      botIds: input.botIds,
      idempotencyKey: input.idempotencyKey ?? `create.${randomUUID()}`,
    })
    const dto = toChannelPublicDto(channel)
    emit(server, runtime.workspace.id, { type: 'channel-created', channel: dto })
    return dto
  })

  server.handle(RPC_CHANNELS.channels.RENAME, async (ctx, workspaceId: string, channelId: string, name: string) => {
    const runtime = openRuntime(ctx, workspaceId, deps)
    const dto = toChannelPublicDto(runtime.directory.renameChannel(channelId, name))
    emit(server, runtime.workspace.id, { type: 'channel-updated', channel: dto })
    return dto
  })

  server.handle(RPC_CHANNELS.channels.ARCHIVE, async (ctx, workspaceId: string, channelId: string) => {
    const runtime = openRuntime(ctx, workspaceId, deps)
    const dto = toChannelPublicDto(runtime.directory.archiveChannel(channelId))
    emit(server, runtime.workspace.id, { type: 'channel-updated', channel: dto })
    return dto
  })

  server.handle(RPC_CHANNELS.channels.REOPEN, async (ctx, workspaceId: string, channelId: string) => {
    const runtime = openRuntime(ctx, workspaceId, deps)
    const dto = toChannelPublicDto(runtime.directory.reopenChannel(channelId))
    emit(server, runtime.workspace.id, { type: 'channel-updated', channel: dto })
    return dto
  })

  server.handle(RPC_CHANNELS.channels.DELETE, async (ctx, workspaceId: string, channelId: string) => {
    const runtime = openRuntime(ctx, workspaceId, deps)
    runtime.directory.deleteChannel(channelId)
    emit(server, runtime.workspace.id, { type: 'channel-deleted', channelId })
    return { deleted: true as const, channelId }
  })

  server.handle(RPC_CHANNELS.channels.ADD_MEMBER, async (ctx, workspaceId: string, channelId: string, botId: string) => {
    const runtime = openRuntime(ctx, workspaceId, deps)
    const dto = toChannelPublicDto(runtime.directory.addMember(channelId, botId))
    emit(server, runtime.workspace.id, { type: 'channel-updated', channel: dto })
    return dto
  })

  server.handle(RPC_CHANNELS.channels.REMOVE_MEMBER, async (ctx, workspaceId: string, channelId: string, botId: string) => {
    const runtime = openRuntime(ctx, workspaceId, deps)
    const dto = toChannelPublicDto(runtime.directory.removeMember(channelId, botId))
    emit(server, runtime.workspace.id, { type: 'channel-updated', channel: dto })
    return dto
  })

  server.handle(RPC_CHANNELS.channels.GET_JOURNAL, async (ctx, workspaceId: string, channelId: string, options?: { afterSeq?: number; limit?: number }) => {
    const runtime = openRuntime(ctx, workspaceId, deps)
    const channel = runtime.directory.getChannel(channelId)
    if (!channel) throw new Error('Channel not found')
    return {
      channel: toChannelPublicDto(channel),
      members: membersFor(runtime, channelId),
      entries: runtime.journal.list(channelId, options),
      cursor: runtime.journal.getCursor(channelId),
    }
  })

  server.handle(RPC_CHANNELS.channels.SEND_MESSAGE, async (
    ctx,
    workspaceId: string,
    channelId: string,
    message: string,
    options?: { idempotencyKey?: string; waitForReplies?: boolean },
  ) => {
    const runtime = openRuntime(ctx, workspaceId, deps)
    await deps.sessionManager.waitForInit()
    const router = routerFor(deps, runtime, ctx.clientId)
    const recovered = await router.recover(channelId)
    for (const route of recovered) emit(server, runtime.workspace.id, { type: 'route-updated', channelId, route })
    const result = await router.send({
      channelId,
      message,
      idempotencyKey: options?.idempotencyKey ?? `send.${randomUUID()}`,
    })
    emit(server, runtime.workspace.id, { type: 'route-updated', channelId, route: result.route })
    emit(server, runtime.workspace.id, { type: 'journal-updated', channelId, throughSeq: result.userEntry.seq })
    return { accepted: true as const, ...result }
  })

  server.handle(RPC_CHANNELS.channels.LIST_ROUTES, async (ctx, workspaceId: string, channelId: string, options?: { limit?: number }) => {
    const runtime = openRuntime(ctx, workspaceId, deps)
    return runtime.routes.list(channelId, options)
  })
}

export { createProviderClaimEvaluator, createStageDispatcher }
export type { ChannelEvent }
