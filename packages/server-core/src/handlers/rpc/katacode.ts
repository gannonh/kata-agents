import { RPC_CHANNELS, type KatacodeTaskRailView } from '@kata-sh/shared/protocol'
import { getWorkspaceByNameOrId } from '@kata-sh/shared/config'
import {
  getKatacodeRuntime,
  subscribeKatacodeEvents,
  type KatacodeRuntime,
  type KatacodeRuntimeSessionManager,
} from '../../katacode/runtime.ts'
import { KatacodeAccessError } from '../../katacode/service.ts'
import type { ISessionManager } from '../session-manager-interface.ts'
import type { RpcServer } from '../../transport'

interface KatacodeHandlerDeps {
  readonly sessionManager: ISessionManager
}

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.katacode.LIST,
  RPC_CHANNELS.katacode.GET_RAIL,
  RPC_CHANNELS.katacode.WAIT,
  RPC_CHANNELS.katacode.CANCEL_WAIT,
  RPC_CHANNELS.katacode.CANCEL,
  RPC_CHANNELS.katacode.RETRY,
  RPC_CHANNELS.katacode.RECONCILE,
  RPC_CHANNELS.katacode.MARK_RESULT_READ,
] as const

const MAX_WAIT_MS = 25_000
const WAIT_FALLBACK_MS = 1_000

class KatacodeWaitRegistry {
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

function runtimeFor(ctx: { workspaceId: string | null }, deps: KatacodeHandlerDeps): KatacodeRuntime {
  if (!ctx.workspaceId) throw new KatacodeAccessError()
  const workspace = getWorkspaceByNameOrId(ctx.workspaceId)
  if (!workspace || workspace.id !== ctx.workspaceId) throw new KatacodeAccessError()
  return getKatacodeRuntime(deps.sessionManager as unknown as KatacodeRuntimeSessionManager, ctx.workspaceId)
}

function isNewer(rail: KatacodeTaskRailView, after?: KatacodeTaskRailView['freshness']): boolean {
  if (!after) return true
  return rail.freshness.taskVersion > (after.taskVersion ?? 0)
    || rail.freshness.journalSequence > (after.journalSequence ?? 0)
}

function delay(ms: number, ...signals: AbortSignal[]): Promise<void> {
  return new Promise((resolve) => {
    if (signals.some((signal) => signal.aborted)) {
      resolve()
      return
    }
    const onDone = () => {
      clearTimeout(timer)
      for (const signal of signals) signal.removeEventListener('abort', onDone)
      resolve()
    }
    const timer = setTimeout(onDone, ms)
    for (const signal of signals) signal.addEventListener('abort', onDone, { once: true })
  })
}

export function registerKatacodeHandlers(
  server: RpcServer,
  deps: KatacodeHandlerDeps,
): void {
  const waits = new KatacodeWaitRegistry()
  server.registerClientDisconnectHandler?.((clientId) => waits.cancelClient(clientId))
  subscribeKatacodeEvents((workspaceId, event) => {
    try {
      const runtime = runtimeFor({ workspaceId }, deps)
      const rail = runtime.service.getRail(event.conversationId, event.taskId)
      server.push(RPC_CHANNELS.katacode.EVENT, { to: 'workspace', workspaceId }, {
        workspaceId,
        conversationId: rail.conversationId,
        taskId: rail.taskId,
        taskVersion: rail.freshness.taskVersion,
        attemptId: rail.freshness.attemptId,
        journalSequence: rail.freshness.journalSequence,
      })
    } catch (error) {
      console.error('[Katacode] Failed to push invalidation after durable commit', error)
    }
  })

  server.handle(RPC_CHANNELS.katacode.LIST, async (ctx, conversationId: string) => {
    return runtimeFor(ctx, deps).service.listConversationRails(conversationId)
  })

  server.handle(RPC_CHANNELS.katacode.GET_RAIL, async (ctx, input: { conversationId: string; taskId: string }) => {
    const runtime = runtimeFor(ctx, deps)
    try {
      return await runtime.service.refresh(input.conversationId, input.taskId)
    } catch {
      return runtime.service.getRail(input.conversationId, input.taskId)
    }
  })

  server.handle(
    RPC_CHANNELS.katacode.WAIT,
    async (
      ctx,
      input: {
        conversationId: string
        taskId: string
        waitId: string
        after?: KatacodeTaskRailView['freshness']
        timeoutMs?: number
      },
    ) => {
      const runtime = runtimeFor(ctx, deps)
      const timeoutMs = boundedWaitMs(input.timeoutMs)
      const controller = waits.begin(ctx.clientId, input.waitId)
      const deadline = Date.now() + timeoutMs
      try {
        // Refresh once per WAIT. Persistence and in-process events drive the
        // loop; the fallback poll is only a missed-event safety net.
        try {
          await runtime.service.refresh(input.conversationId, input.taskId)
        } catch {
          // Keep the last persisted rail if the provider poll fails.
        }
        let pendingEvent = false
        let wake = new AbortController()
        const unsubscribe = subscribeKatacodeEvents((workspaceId, event) => {
          if (workspaceId !== runtime.workspaceId) return
          if (event.conversationId !== input.conversationId || event.taskId !== input.taskId) return
          pendingEvent = true
          wake.abort()
        })
        try {
          while (!controller.signal.aborted) {
            const rail = runtime.service.getRail(input.conversationId, input.taskId)
            if (isNewer(rail, input.after) || Date.now() >= deadline) return rail
            if (!pendingEvent) {
              await delay(
                Math.min(WAIT_FALLBACK_MS, Math.max(1, deadline - Date.now())),
                controller.signal,
                wake.signal,
              )
            }
            if (pendingEvent) {
              pendingEvent = false
              if (wake.signal.aborted) wake = new AbortController()
            }
          }
          return runtime.service.getRail(input.conversationId, input.taskId)
        } finally {
          unsubscribe()
        }
      } finally {
        waits.finish(ctx.clientId, input.waitId, controller)
      }
    },
  )

  server.handle(RPC_CHANNELS.katacode.CANCEL_WAIT, async (ctx, input: { waitId: string }) => {
    return { cancelled: waits.cancelWait(ctx.clientId, input.waitId) }
  })

  server.handle(
    RPC_CHANNELS.katacode.CANCEL,
    async (ctx, input: { conversationId: string; taskId: string; reason: string }) => {
      return runtimeFor(ctx, deps).service.cancel(input.conversationId, input.taskId, input.reason)
    },
  )

  server.handle(
    RPC_CHANNELS.katacode.RETRY,
    async (ctx, input: { conversationId: string; taskId: string }) => {
      return runtimeFor(ctx, deps).service.retry(input.conversationId, input.taskId)
    },
  )

  server.handle(
    RPC_CHANNELS.katacode.RECONCILE,
    async (ctx, input: { conversationId: string; taskId: string }) => {
      return runtimeFor(ctx, deps).service.reconcile(input.conversationId, input.taskId)
    },
  )

  server.handle(
    RPC_CHANNELS.katacode.MARK_RESULT_READ,
    async (ctx, input: { conversationId: string; taskId: string; expectedTaskVersion: number }) => {
      return runtimeFor(ctx, deps).service.markResultRead(
        input.conversationId,
        input.taskId,
        input.expectedTaskVersion,
      )
    },
  )
}
