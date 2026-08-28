import { randomUUID } from 'node:crypto'
import { RPC_CHANNELS, type ChannelEvent } from '@kata-sh/shared/protocol'
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
      const completion = agent.runMiniCompletion(buildClaimPrompt(request))
      // Swallow late rejection if abort wins the race; otherwise the completion
      // promise becomes an unhandled rejection after race settles on null.
      void completion.catch(() => undefined)
      return await Promise.race([completion, aborted])
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
    const existing = runtime.journal.list(request.channelId).find(
      (entry) => entry.kind === 'bot' && entry.idempotencyKey === request.dispatchIdempotencyKey,
    )
    if (existing) return existing.body

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
      {
        callerClientId,
        waitForReply: true,
        dispatchIdempotencyKey: request.dispatchIdempotencyKey,
      },
    )
    if (result.reply === null) throw new Error('Bot did not return a reply')
    return result.reply
  }
}

function routerFor(
  deps: HandlerDeps,
  runtime: ChannelRuntime,
  callerClientId?: string,
  onRouteCommitted?: (route: RouteRecord) => void,
): ChannelRouter {
  return new ChannelRouter({
    directory: runtime.directory,
    journal: runtime.journal,
    routes: runtime.routes,
    evaluateClaim: createProviderClaimEvaluator(deps, runtime.workspace, runtime.bots),
    dispatch: createStageDispatcher(deps, runtime, callerClientId),
    onRouteCommitted,
  })
}

async function recoverAndEmit(
  deps: HandlerDeps,
  runtime: ChannelRuntime,
  server: RpcServer,
  channelId: string,
  callerClientId?: string,
): Promise<RouteRecord[]> {
  await deps.sessionManager.waitForInit()
  const recovered = await routerFor(deps, runtime, callerClientId).recover(channelId)
  for (const route of recovered) {
    emit(server, runtime.workspace.id, { type: 'route-updated', channelId, route })
  }
  return recovered
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
    try {
      await recoverAndEmit(deps, runtime, server, channelId, ctx.clientId)
    } catch (error: unknown) {
      console.error('[Channels] Route recovery on journal load failed:', error)
    }
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
    let resolveRouteCommit!: (route: RouteRecord) => void
    let rejectRouteCommit!: (error: unknown) => void
    const routeCommit = new Promise<RouteRecord>((resolve, reject) => {
      resolveRouteCommit = resolve
      rejectRouteCommit = reject
    })
    // A rejected commit promise is only observed when waitForReplies is false.
    // Attach a handler here so a pre-commit validation failure cannot become an
    // unhandled rejection for callers that wait for the full route operation.
    void routeCommit.catch(() => undefined)
    const router = routerFor(deps, runtime, ctx.clientId, (route) => {
      emit(server, runtime.workspace.id, { type: 'route-updated', channelId, route })
      resolveRouteCommit(route)
    })
    void recoverAndEmit(deps, runtime, server, channelId, ctx.clientId).catch((error: unknown) => {
      console.error('[Channels] Background route recovery failed:', error)
    })
    const operation = router.send({
      channelId,
      message,
      idempotencyKey: options?.idempotencyKey ?? `send.${randomUUID()}`,
    }).then((result) => {
      emit(server, runtime.workspace.id, { type: 'route-updated', channelId, route: result.route })
      emit(server, runtime.workspace.id, { type: 'journal-updated', channelId, throughSeq: result.userEntry.seq })
      return result
    }, (error: unknown) => {
      rejectRouteCommit(error)
      throw error
    })

    if (options?.waitForReplies === false) {
      void operation.catch((error: unknown) => {
        console.error('[Channels] Background route operation failed:', error)
      })
      const route = await routeCommit
      const userEntry = runtime.journal.getEntry(channelId, route.messageEntryId)
      if (!userEntry) throw new Error(`Channel route user entry not found: ${route.messageEntryId}`)
      return { accepted: true as const, userEntry, route, replies: [] }
    }

    const result = await operation
    return { accepted: true as const, ...result }
  })

  server.handle(RPC_CHANNELS.channels.LIST_ROUTES, async (ctx, workspaceId: string, channelId: string, options?: { limit?: number }) => {
    const runtime = openRuntime(ctx, workspaceId, deps)
    return runtime.routes.list(channelId, options)
  })
}

export { createProviderClaimEvaluator, createStageDispatcher }
export type { ChannelEvent }
