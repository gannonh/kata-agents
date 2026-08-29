import { RPC_CHANNELS, type HandoffRailView } from '@kata-sh/shared/protocol'
import { getWorkspaceByNameOrId } from '@kata-sh/shared/config'
import {
  getHandoffRuntime,
  subscribeHandoffEvents,
  type HandoffRuntime,
  type HandoffRuntimeSessionManager,
} from '../../handoffs/runtime'
import { TaskAccessError } from '../../handoffs/service'
import type { RpcServer } from '../../transport'

interface HandoffHandlerDeps {
  readonly sessionManager: HandoffRuntimeSessionManager
}

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.handoffs.LIST,
  RPC_CHANNELS.handoffs.GET_RAIL,
  RPC_CHANNELS.handoffs.WAIT,
  RPC_CHANNELS.handoffs.CANCEL_WAIT,
  RPC_CHANNELS.handoffs.READ_RESULT_CHUNK,
  RPC_CHANNELS.handoffs.CANCEL,
  RPC_CHANNELS.handoffs.MARK_RESULT_READ,
] as const

const MAX_WAIT_MS = 25_000
const WAIT_POLL_MS = 50

export class HandoffWaitRegistry {
  private readonly activeByClient = new Map<string, Map<string, AbortController>>()

  begin(clientId: string, waitId: string): AbortController {
    if (!waitId) throw new TypeError('waitId must be a non-empty string')
    const active = this.activeByClient.get(clientId) ?? new Map<string, AbortController>()
    active.get(waitId)?.abort()
    const controller = new AbortController()
    active.set(waitId, controller)
    this.activeByClient.set(clientId, active)
    return controller
  }

  finish(clientId: string, waitId: string, controller: AbortController): void {
    const active = this.activeByClient.get(clientId)
    if (active?.get(waitId) !== controller) return
    active.delete(waitId)
    if (active.size === 0) this.activeByClient.delete(clientId)
  }

  cancelWait(clientId: string, waitId: string): boolean {
    if (!waitId) throw new TypeError('waitId must be a non-empty string')
    const controller = this.activeByClient.get(clientId)?.get(waitId)
    controller?.abort()
    return controller !== undefined
  }

  cancelClient(clientId: string): void {
    const active = this.activeByClient.get(clientId)
    if (!active) return
    this.activeByClient.delete(clientId)
    for (const controller of active.values()) controller.abort()
  }
}

function boundedWaitMs(value: number | undefined): number {
  if (value === undefined) return MAX_WAIT_MS
  if (!Number.isFinite(value)) throw new TypeError('timeoutMs must be a finite number')
  return Math.max(0, Math.min(Math.trunc(value), MAX_WAIT_MS))
}

function runtimeFor(ctx: { workspaceId: string | null }, deps: HandoffHandlerDeps): HandoffRuntime {
  if (!ctx.workspaceId) throw new TaskAccessError()
  const workspace = getWorkspaceByNameOrId(ctx.workspaceId)
  if (!workspace || workspace.id !== ctx.workspaceId) throw new TaskAccessError()
  return getHandoffRuntime(deps.sessionManager, ctx.workspaceId)
}

function assertConversation(runtime: HandoffRuntime, conversationId: string): void {
  if (conversationId.startsWith('channel_')) {
    const channel = runtime.channels.getChannel(conversationId)
    if (!channel || channel.workspaceId !== runtime.workspaceId) throw new TaskAccessError()
    return
  }
  const bot = runtime.bots.listBots({ lifecycle: 'all' }).find((candidate) => candidate.directChatId === conversationId)
  if (!bot || bot.workspaceId !== runtime.workspaceId) throw new TaskAccessError()
}

function railFor(runtime: HandoffRuntime, conversationId: string, handoffId: string): HandoffRailView {
  assertConversation(runtime, conversationId)
  return runtime.service.getHandoffRail(conversationId, handoffId)
}

function isNewer(rail: HandoffRailView, after?: HandoffRailView['freshness']): boolean {
  if (!after) return true
  return rail.freshness.deliveryVersion > (after.deliveryVersion ?? 0)
    || rail.freshness.taskVersion > (after.taskVersion ?? 0)
    || rail.freshness.journalSequence > (after.journalSequence ?? 0)
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function registerHandoffsHandlers(
  server: RpcServer,
  deps: HandoffHandlerDeps,
): void {
  const waits = new HandoffWaitRegistry()
  server.registerClientDisconnectHandler?.((clientId) => waits.cancelClient(clientId))
  subscribeHandoffEvents((workspaceId, event) => {
    try {
      const runtime = runtimeFor({ workspaceId }, deps)
      const rail = runtime.service.getHandoffRail(event.conversationId, event.handoffId)
      server.push(RPC_CHANNELS.handoffs.EVENT, { to: 'workspace', workspaceId }, {
        workspaceId,
        conversationId: rail.conversationId,
        handoffId: rail.handoffId,
        ...rail.freshness,
      })
    } catch (error) {
      console.error('[Handoffs] Failed to push invalidation after durable commit', error)
    }
  })

  server.handle(RPC_CHANNELS.handoffs.LIST, async (ctx, conversationId: string) => {
    const runtime = runtimeFor(ctx, deps)
    assertConversation(runtime, conversationId)
    return runtime.service.listConversationHandoffRails(conversationId)
  })

  server.handle(RPC_CHANNELS.handoffs.GET_RAIL, async (ctx, input: { conversationId: string; handoffId: string }) => {
    return railFor(runtimeFor(ctx, deps), input.conversationId, input.handoffId)
  })

  server.handle(
    RPC_CHANNELS.handoffs.WAIT,
    async (
      ctx,
      input: {
        conversationId: string
        handoffId: string
        waitId: string
        after?: HandoffRailView['freshness']
        timeoutMs?: number
      },
    ) => {
      const runtime = runtimeFor(ctx, deps)
      const controller = waits.begin(ctx.clientId, input.waitId)
      const timeoutMs = boundedWaitMs(input.timeoutMs)
      const deadline = Date.now() + timeoutMs
      try {
        while (!controller.signal.aborted) {
          const rail = railFor(runtime, input.conversationId, input.handoffId)
          if (isNewer(rail, input.after) || Date.now() >= deadline) return rail
          await delay(Math.min(WAIT_POLL_MS, Math.max(1, deadline - Date.now())), controller.signal)
        }
        return railFor(runtime, input.conversationId, input.handoffId)
      } finally {
        waits.finish(ctx.clientId, input.waitId, controller)
      }
    },
  )

  server.handle(RPC_CHANNELS.handoffs.CANCEL_WAIT, async (ctx, input: { waitId: string }) => {
    return { cancelled: waits.cancelWait(ctx.clientId, input.waitId) }
  })

  server.handle(
    RPC_CHANNELS.handoffs.READ_RESULT_CHUNK,
    async (ctx, input: { conversationId: string; handoffId: string; offset: number; limit: number }) => {
      const runtime = runtimeFor(ctx, deps)
      assertConversation(runtime, input.conversationId)
      return runtime.service.readResultChunk(input.conversationId, input.handoffId, input.offset, input.limit)
    },
  )

  server.handle(
    RPC_CHANNELS.handoffs.CANCEL,
    async (ctx, input: { conversationId: string; handoffId: string; reason: string }) => {
      const runtime = runtimeFor(ctx, deps)
      assertConversation(runtime, input.conversationId)
      await runtime.service.cancelHandoff(input.conversationId, input.handoffId, input.reason)
      return railFor(runtime, input.conversationId, input.handoffId)
    },
  )

  server.handle(
    RPC_CHANNELS.handoffs.MARK_RESULT_READ,
    async (ctx, input: { conversationId: string; handoffId: string; expectedTaskVersion: number }) => {
      const runtime = runtimeFor(ctx, deps)
      assertConversation(runtime, input.conversationId)
      runtime.service.markResultRead(input.conversationId, input.handoffId, input.expectedTaskVersion)
      return railFor(runtime, input.conversationId, input.handoffId)
    },
  )
}
