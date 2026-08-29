import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS, type HandoffRailView } from '@kata-sh/shared/protocol'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport/types'
import { TaskAccessError } from '../../handoffs/service'
import type { HandoffRuntime } from '../../handoffs/runtime'
import { HandoffWaitRegistry, registerHandoffsHandlers } from './handoffs'

function context(workspaceId: string | null): RequestContext {
  return { clientId: 'client-a', workspaceId, webContentsId: 1 }
}

function handlerHarness() {
  const handlers = new Map<string, HandlerFn>()
  const server: RpcServer = {
    handle(channel, handler) { handlers.set(channel, handler) },
    push() {},
    async invokeClient() { return undefined },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }
  const calls: string[] = []
  const rail = {
    handoffId: 'handoff_1',
    conversationId: 'chat_1',
    sourceBotName: 'Source',
    targetBotName: 'Target',
    delivery: { conversationId: 'chat_1' },
    exchange: [],
    task: null,
    unread: true,
    freshness: { deliveryVersion: 2, taskVersion: 3, journalSequence: 4 },
    actions: ['read'],
  } as unknown as HandoffRailView
  const runtime = {
    workspaceId: 'ws-1',
    bots: {
      listBots: () => [{ workspaceId: 'ws-1', directChatId: 'chat_1' }],
    },
    channels: { getChannel: () => null },
    service: {
      listConversationHandoffRails: () => [rail],
      getHandoffRail: () => rail,
      readResultChunk: (_conversationId: string, _handoffId: string, offset: number, limit: number) => {
        calls.push(`read:${offset}:${limit}`)
        return { dataBase64: 'b2s=' }
      },
      cancelHandoff: async (_conversationId: string, _handoffId: string, reason: string) => {
        calls.push(`cancel:${reason}`)
      },
      markResultRead: (_conversationId: string, _handoffId: string, version: number) => {
        calls.push(`mark:${version}`)
      },
    },
  } as unknown as HandoffRuntime
  registerHandoffsHandlers(server, {} as never, {
    resolveRuntime: (ctx) => {
      if (ctx.workspaceId !== runtime.workspaceId) throw new TaskAccessError()
      return runtime
    },
  })
  return { handlers, calls, rail }
}

describe('HandoffWaitRegistry', () => {
  it('replaces only the matching client wait and preserves the successor', () => {
    const waits = new HandoffWaitRegistry()
    const first = waits.begin('client-a', 'wait-1')
    const otherClient = waits.begin('client-b', 'wait-1')
    const successor = waits.begin('client-a', 'wait-1')

    expect(first.signal.aborted).toBe(true)
    expect(successor.signal.aborted).toBe(false)
    expect(otherClient.signal.aborted).toBe(false)

    waits.finish('client-a', 'wait-1', first)
    expect(waits.cancelWait('client-a', 'wait-1')).toBe(true)
    expect(successor.signal.aborted).toBe(true)
    expect(otherClient.signal.aborted).toBe(false)
  })

  it('cancels every wait owned by a disconnected client', () => {
    const waits = new HandoffWaitRegistry()
    const first = waits.begin('client-a', 'wait-1')
    const second = waits.begin('client-a', 'wait-2')
    const otherClient = waits.begin('client-b', 'wait-1')

    waits.cancelClient('client-a')

    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(true)
    expect(otherClient.signal.aborted).toBe(false)
    expect(waits.cancelWait('client-a', 'wait-1')).toBe(false)
  })
})

describe('handoff RPC authority boundary', () => {
  it('binds reads, chunks, cancellation, acknowledgement, waits, and workspace switches to the context', async () => {
    const { handlers, calls, rail } = handlerHarness()
    const invoke = (channel: string, ctx: RequestContext, input: unknown) => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`Missing handler ${channel}`)
      return handler(ctx, input)
    }

    await expect(invoke(RPC_CHANNELS.handoffs.GET_RAIL, context('ws-1'), {
      conversationId: 'chat_1',
      handoffId: 'handoff_1',
    })).resolves.toBe(rail)
    await expect(invoke(RPC_CHANNELS.handoffs.READ_RESULT_CHUNK, context('ws-1'), {
      conversationId: 'chat_1',
      handoffId: 'handoff_1',
      offset: 4,
      limit: 8,
    })).resolves.toEqual({ dataBase64: 'b2s=' })
    await invoke(RPC_CHANNELS.handoffs.CANCEL, context('ws-1'), {
      conversationId: 'chat_1',
      handoffId: 'handoff_1',
      reason: 'Stop.',
    })
    await invoke(RPC_CHANNELS.handoffs.MARK_RESULT_READ, context('ws-1'), {
      conversationId: 'chat_1',
      handoffId: 'handoff_1',
      expectedTaskVersion: 3,
    })
    await expect(invoke(RPC_CHANNELS.handoffs.WAIT, context('ws-1'), {
      conversationId: 'chat_1',
      handoffId: 'handoff_1',
      waitId: 'wait-1',
      after: { deliveryVersion: 1, taskVersion: 3, journalSequence: 4 },
      timeoutMs: 10,
    })).resolves.toBe(rail)

    expect(calls).toEqual(['read:4:8', 'cancel:Stop.', 'mark:3'])
    await expect(invoke(RPC_CHANNELS.handoffs.GET_RAIL, context('ws-2'), {
      conversationId: 'chat_1',
      handoffId: 'handoff_1',
    })).rejects.toBeInstanceOf(TaskAccessError)
    await expect(invoke(RPC_CHANNELS.handoffs.GET_RAIL, context('ws-1'), {
      conversationId: 'chat_other',
      handoffId: 'handoff_1',
    })).rejects.toBeInstanceOf(TaskAccessError)
  })
})
