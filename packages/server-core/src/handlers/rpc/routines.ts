import { RPC_CHANNELS } from '@kata-sh/shared/protocol'
import { getWorkspaceByNameOrId } from '@kata-sh/shared/config'
import { BotDirectory } from '@kata-sh/shared/bots'
import { ChannelDirectory } from '@kata-sh/shared/channels'
import type { RoutineId, RoutineRunId } from '@kata-sh/core'
import type { RpcServer } from '@kata-sh/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import type { CreateRoutineInput, UpdateRoutineInput } from '@kata-sh/shared/routines'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.routines.LIST,
  RPC_CHANNELS.routines.GET,
  RPC_CHANNELS.routines.CREATE,
  RPC_CHANNELS.routines.UPDATE,
  RPC_CHANNELS.routines.ENABLE,
  RPC_CHANNELS.routines.PAUSE,
  RPC_CHANNELS.routines.DELETE,
  RPC_CHANNELS.routines.TEST,
  RPC_CHANNELS.routines.LIST_RUNS,
  RPC_CHANNELS.routines.REPLAY,
  RPC_CHANNELS.routines.RESUME_APPROVAL,
  RPC_CHANNELS.routines.INGEST_EVENT,
] as const

function requireWorkspace(ctx: { workspaceId: string | null }, workspaceId: string) {
  const workspace = getWorkspaceByNameOrId(workspaceId)
  if (!workspace) throw new Error('Workspace not found')
  if (ctx.workspaceId && ctx.workspaceId !== workspace.id) throw new Error('Workspace access denied')
  return workspace
}

async function engineFor(ctx: { workspaceId: string | null }, deps: HandlerDeps, workspaceId: string) {
  const workspace = requireWorkspace(ctx, workspaceId)
  await deps.sessionManager.waitForInit()
  const engine = deps.sessionManager.getRoutineEngine(workspace.id)
  if (!engine) throw new Error('Routine engine is unavailable')
  await engine.start()
  return { workspace, engine }
}

function validateOwner(workspaceRoot: string, workspaceId: string, input: CreateRoutineInput | UpdateRoutineInput, ownerBotId: string) {
  const bots = new BotDirectory({ workspaceRoot, workspaceId })
  bots.recover()
  const bot = bots.getBot(ownerBotId)
  if (!bot || bot.lifecycle !== 'active') throw new Error('Routine owner Bot is unavailable')
  const destination = 'destination' in input ? input.destination : undefined
  if (!destination) return
  if (destination.kind === 'direct') {
    const destinationBot = bots.getBotByChat(destination.chatId)
    if (!destinationBot || destinationBot.botId !== ownerBotId) throw new Error('Routine direct destination must belong to its owner Bot')
    return
  }
  const channels = new ChannelDirectory({
    workspaceRoot,
    workspaceId,
    resolveBot: botId => {
      const member = bots.getBot(botId)
      return member
        ? { botId: member.botId, name: member.name, ...(member.profile !== undefined ? { profile: member.profile } : {}), lifecycle: member.lifecycle }
        : null
    },
  })
  const channel = channels.getChannel(destination.channelId)
  if (!channel || channel.lifecycle !== 'active' || !channels.isMember(destination.channelId, ownerBotId)) {
    throw new Error('Routine channel destination must be an active channel owned by its Bot')
  }
}

export function registerRoutinesHandlers(server: RpcServer, deps: HandlerDeps): void {
  server.handle(RPC_CHANNELS.routines.LIST, async (ctx, workspaceId: string, ownerBotId?: string) => {
    const { engine } = await engineFor(ctx, deps, workspaceId)
    return engine.list(ownerBotId)
  })

  server.handle(RPC_CHANNELS.routines.GET, async (ctx, workspaceId: string, routineId: RoutineId) => {
    const { engine } = await engineFor(ctx, deps, workspaceId)
    return engine.get(routineId)
  })

  server.handle(RPC_CHANNELS.routines.CREATE, async (ctx, workspaceId: string, input: CreateRoutineInput) => {
    const { workspace, engine } = await engineFor(ctx, deps, workspaceId)
    validateOwner(workspace.rootPath, workspace.id, input, input.ownerBotId)
    return engine.create(input)
  })

  server.handle(RPC_CHANNELS.routines.UPDATE, async (ctx, workspaceId: string, routineId: RoutineId, input: UpdateRoutineInput) => {
    const { workspace, engine } = await engineFor(ctx, deps, workspaceId)
    const current = engine.store.get(routineId)
    if (!current) throw new Error('Routine not found')
    validateOwner(workspace.rootPath, workspace.id, input, current.ownerBotId)
    return engine.update(routineId, input)
  })

  server.handle(RPC_CHANNELS.routines.ENABLE, async (ctx, workspaceId: string, routineId: RoutineId) => {
    const { engine } = await engineFor(ctx, deps, workspaceId)
    return engine.enable(routineId)
  })

  server.handle(RPC_CHANNELS.routines.PAUSE, async (ctx, workspaceId: string, routineId: RoutineId) => {
    const { engine } = await engineFor(ctx, deps, workspaceId)
    return engine.pause(routineId)
  })

  server.handle(RPC_CHANNELS.routines.DELETE, async (ctx, workspaceId: string, routineId: RoutineId) => {
    const { engine } = await engineFor(ctx, deps, workspaceId)
    return engine.delete(routineId)
  })

  server.handle(RPC_CHANNELS.routines.TEST, async (ctx, workspaceId: string, routineId: RoutineId) => {
    const { engine } = await engineFor(ctx, deps, workspaceId)
    return engine.testRoutine(routineId)
  })

  server.handle(RPC_CHANNELS.routines.LIST_RUNS, async (ctx, workspaceId: string, routineId: RoutineId, limit?: number) => {
    const { engine } = await engineFor(ctx, deps, workspaceId)
    return engine.listRuns(routineId, limit)
  })

  server.handle(RPC_CHANNELS.routines.REPLAY, async (ctx, workspaceId: string, runId: string) => {
    const { engine } = await engineFor(ctx, deps, workspaceId)
    return engine.replayRun(runId as RoutineRunId)
  })

  server.handle(RPC_CHANNELS.routines.RESUME_APPROVAL, async (ctx, workspaceId: string, input: { runId: string; expectedVersion: number }) => {
    const { engine } = await engineFor(ctx, deps, workspaceId)
    return engine.resumeAfterApproval(input.runId as RoutineRunId, input.expectedVersion)
  })

  server.handle(RPC_CHANNELS.routines.INGEST_EVENT, async (ctx, workspaceId: string, event: { source: string; externalEventId: string; payload: unknown; occurredAt?: string }) => {
    const { engine } = await engineFor(ctx, deps, workspaceId)
    return engine.ingestEvent(event)
  })
}
