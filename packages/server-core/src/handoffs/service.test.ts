import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BotRecord, BotTurnContext, JournalEntry, SpawnTask } from '@kata-sh/core'
import { HandoffDeliveryStore } from '@kata-sh/shared/handoffs'
import { SpawnTaskStore } from '@kata-sh/shared/spawn-tasks'
import type { ConversationJournal } from '@kata-sh/shared/conversations'
import {
  HandoffService,
  toHandoffTaskView,
  type HandoffReserveInput,
  type HandoffServiceOptions,
  type HandoffTaskStore,
} from './service'

const at = '2026-08-28T00:00:00.000Z'

function bot(botId: string, name: string, directChatId: string, profile?: string): BotRecord {
  return {
    schemaVersion: 1,
    botId,
    workspaceId: 'ws_1',
    directChatId,
    name,
    permissionMode: 'safe',
    providerConfig: { providerId: 'openai-codex', modelId: 'gpt-5' },
    lifecycle: 'active',
    ...(profile !== undefined ? { profile } : {}),
    createdAt: at,
    updatedAt: at,
  }
}

function task(): SpawnTask {
  return {
    schemaVersion: 1,
    version: 1,
    taskId: 'task_1',
    workspaceId: 'ws_1',
    parentSessionId: 'session_source',
    childSessionId: 'session_target',
    delegatedPrompt: 'Audit the release diff.',
    childConfig: {},
    runtimeState: 'queued',
    stateTimestamps: { createdAt: at, updatedAt: at, queuedAt: at },
    dispatch: {
      state: 'reserved',
      dispatchAttemptId: 'attempt_1',
      messageId: 'message_1',
      reservedAt: at,
    },
  }
}

function makeService(
  deliveryStore: HandoffDeliveryStore,
  taskStore: HandoffTaskStore,
  onDispatch?: (task: SpawnTask, botTurnContext?: BotTurnContext) => void,
  journalOverride?: Pick<ConversationJournal, 'append' | 'list'>,
): HandoffService {
  const source = bot('bot_source', 'Source', 'chat_source')
  const target = bot('bot_target', 'Reviewer', 'chat_target', 'Review carefully <private>.')
  const journal = ({
    workspaceId: 'ws_1',
    append: () => undefined,
    list: () => [],
    getHeadSequence: () => 0,
    ...journalOverride,
  }) as unknown as ConversationJournal
  const options: HandoffServiceOptions = {
    workspaceId: 'ws_1',
    workspaceRoot: deliveryStore.rootPath,
    deliveryStore,
    resolveJournal: () => journal,
    botDirectory: {
      getBotByLegacySession: () => source,
      getBot: (botId: string) => [source, target].find((candidate) => candidate.botId === botId) ?? null,
      listBots: () => [source, target],
    } as never,
    channelDirectory: {
      listChannels: () => [],
      isMember: () => true,
    } as never,
    sessionManager: {
      getSession: async (id: string) => ({ id, workspaceId: 'ws_1' }),
    },
    taskStore,
    coordinator: {
      dispatchReserved: async (reserved, _attachments, _fence, botTurnContext) => {
        onDispatch?.(reserved, botTurnContext)
        return {
        taskId: reserved.taskId,
        childSessionId: reserved.childSessionId,
        runtimeState: reserved.runtimeState,
        version: reserved.version,
        }
      },
      cancelTask: async () => ({ status: 'already_terminal' as const, task: null }),
    },
    clock: () => at,
    randomId: (() => {
      const ids = ['handoff', 'delivery', 'claim']
      return () => ids.shift() ?? 'extra'
    })(),
  }
  return new HandoffService(options)
}

describe('HandoffService creation boundary', () => {
  it('projects only the allowlisted task fields', () => {
    const projected = toHandoffTaskView(task())
    expect(projected).toMatchObject({ taskId: 'task_1', version: 1, runtimeState: 'queued' })
    expect(projected).not.toHaveProperty('childConfig')
    expect(projected).not.toHaveProperty('parentSessionId')
    expect(projected).not.toHaveProperty('childSessionId')
    expect(projected).not.toHaveProperty('dispatch')
  })

  it('persists delivery mail before reserving the canonical task', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'handoff-service-'))
    try {
      const deliveryStore = new HandoffDeliveryStore({ workspaceRoot, clock: () => at })
      const order: string[] = []
      let reservedInput: HandoffReserveInput | undefined
      let dispatchedContext: BotTurnContext | undefined
      const taskStore = {
        reserveForHandoff: (_handoffId: string, input: HandoffReserveInput) => {
          order.push('reserve')
          reservedInput = input
          if (!deliveryStore.getByHandoff('handoff_handoff')) {
            throw new Error('delivery must exist before task reservation')
          }
          return task()
        },
        get: () => null,
        setHandoffDispatchFence: (taskId: string, fence: SpawnTask['dispatch']['handoffFence']) => ({
          ...task(),
          taskId,
          version: 2,
          origin: { kind: 'handoff' as const, handoffId: 'handoff_handoff' },
          dispatch: { ...task().dispatch, handoffFence: fence },
        }),
      } as unknown as HandoffTaskStore
      const originalCreate = deliveryStore.create.bind(deliveryStore)
      deliveryStore.create = ((input) => {
        order.push('delivery')
        return originalCreate(input)
      }) as HandoffDeliveryStore['create']
      const service = makeService(deliveryStore, taskStore, (_task, botTurnContext) => {
        dispatchedContext = botTurnContext
      })

      await expect(service.createHandoff({
        callerSessionId: 'session_source',
        targetBot: 'Reviewer',
        request: 'Audit the release diff.',
      })).resolves.toMatchObject({ handoffId: 'handoff_handoff' })

      expect(order.slice(0, 2)).toEqual(['delivery', 'reserve'])
      expect(reservedInput!.childConfig.permissionMode).toBe('safe')
      expect(dispatchedContext?.botId).toBe('bot_target')
      expect(dispatchedContext?.text).toContain('Review carefully &lt;private&gt;.')
      expect(dispatchedContext?.text).not.toContain('bot_source')
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('projects journal references through canonical delivery and task state', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'handoff-projection-'))
    try {
      const deliveryStore = new HandoffDeliveryStore({ workspaceRoot, clock: () => at })
      const taskStore = new SpawnTaskStore({ workspaceRoot, workspaceId: 'ws_1', clock: () => at })
      const entries: JournalEntry[] = []
      const journal = {
        append: (input: Parameters<ConversationJournal['append']>[0]) => {
          const entry: JournalEntry = {
            schemaVersion: 1,
            entryId: `entry_${entries.length + 1}`,
            seq: entries.length + 1,
            createdAt: at,
            ...input,
          }
          entries.push(entry)
          return entry
        },
        list: () => entries,
      }
      const service = makeService(deliveryStore, taskStore, undefined, journal)

      const created = await service.createHandoff({
        callerSessionId: 'session_source',
        targetBot: 'Reviewer',
        request: 'Audit the release diff.',
      })
      let current = taskStore.get(created.taskId)!
      current = taskStore.updateDispatch(current.taskId, 'ready', at)
      current = taskStore.updateDispatch(current.taskId, 'claimed', at)
      current = taskStore.updateDispatch(current.taskId, 'sent', at)
      current = taskStore.transition(current.taskId, { runtimeState: 'processing', at })
      const completed = taskStore.commitResult(current.taskId, 'canonical result', { committedAt: at })
      await service.onTaskUpdated(completed.taskId)

      const rail = service.getHandoffRail('chat_source', created.handoffId)
      expect(rail.sourceBotName).toBe('Source')
      expect(rail.targetBotName).toBe('Reviewer')
      expect(rail.exchange.map((entry) => entry.phase)).toEqual(['requested', 'terminal'])
      expect(rail.task?.result?.preview).toBe('canonical result')
      const projectedTask = rail.task!
      expect(JSON.parse(entries[0]!.body)).toEqual({
        type: 'handoff-requested',
        handoffId: created.handoffId,
        deliveryId: created.deliveryId,
      })
      expect(JSON.parse(entries[1]!.body)).toEqual({
        type: 'handoff-terminal',
        handoffId: created.handoffId,
        deliveryId: created.deliveryId,
        taskId: created.taskId,
        taskVersion: completed.version,
      })
      await expect(service.inspectHandoff('session_source', {
        action: 'get',
        taskId: created.taskId,
      })).resolves.toEqual(projectedTask)
      await expect(service.inspectHandoff('session_source', {
        action: 'wait',
        taskId: created.taskId,
        afterVersion: completed.version - 1,
      })).resolves.toEqual(projectedTask)
      const chunk = await service.inspectHandoff('session_source', {
        action: 'read-result',
        taskId: created.taskId,
        offset: 0,
        limit: 64,
      })
      expect('dataBase64' in chunk ? Buffer.from(chunk.dataBase64, 'base64').toString('utf8') : null)
        .toBe('canonical result')
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('returns the same access error for unknown and unauthorized task IDs', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'handoff-authorization-'))
    try {
      const deliveryStore = new HandoffDeliveryStore({ workspaceRoot, clock: () => at })
      const taskStore = new SpawnTaskStore({ workspaceRoot, workspaceId: 'ws_1', clock: () => at })
      const unauthorized = taskStore.reserveForHandoff('handoff_other', {
        parentSessionId: 'session_other',
        delegatedPrompt: 'Private task.',
        childConfig: {},
      })
      deliveryStore.create({
        deliveryId: 'delivery_other',
        handoffId: 'handoff_other',
        workspaceId: 'ws_1',
        conversationId: 'chat_other',
        sourceBotId: 'bot_other',
        targetBotId: 'bot_target',
        request: 'Private task.',
      })
      deliveryStore.attachSpawnTask('delivery_other', unauthorized.taskId)
      const service = makeService(deliveryStore, taskStore)
      const capture = async (taskId: string): Promise<unknown> => {
        try {
          return await service.inspectHandoff('session_source', { action: 'get', taskId })
        } catch (error) {
          return error
        }
      }

      const unknown = await capture('task_unknown')
      const denied = await capture(unauthorized.taskId)

      expect(unknown).toMatchObject({ code: 'handoff_task_unavailable', message: 'Requested task is not available.' })
      expect(denied).toMatchObject({ code: 'handoff_task_unavailable', message: 'Requested task is not available.' })
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('rereads the authorized task and returns when a wait is aborted', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'handoff-wait-abort-'))
    try {
      const deliveryStore = new HandoffDeliveryStore({ workspaceRoot, clock: () => at })
      const taskStore = new SpawnTaskStore({ workspaceRoot, workspaceId: 'ws_1', clock: () => at })
      const service = makeService(deliveryStore, taskStore)
      const created = await service.createHandoff({
        callerSessionId: 'session_source',
        targetBot: 'Reviewer',
        request: 'Wait for cancellation.',
      })
      const controller = new AbortController()
      const startedAt = Date.now()
      setTimeout(() => controller.abort(), 10)

      const result = await service.inspectHandoff('session_source', {
        action: 'wait',
        taskId: created.taskId,
        afterVersion: created.version,
        timeoutMs: 5_000,
      }, controller.signal)

      expect(result).toMatchObject({ taskId: created.taskId, version: created.version })
      expect(Date.now() - startedAt).toBeLessThan(500)
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('replays a claimed delivery through fenced dispatch before acknowledgement', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'handoff-recovery-'))
    try {
      const deliveryStore = new HandoffDeliveryStore({ workspaceRoot, clock: () => at })
      const taskStore = new SpawnTaskStore({ workspaceRoot, workspaceId: 'ws_1', clock: () => at })
      const task = taskStore.reserveForHandoff('handoff_recover', {
        parentSessionId: 'session_source',
        delegatedPrompt: 'Recover this handoff.',
        childConfig: {},
      })
      deliveryStore.create({
        deliveryId: 'delivery_recover',
        handoffId: 'handoff_recover',
        workspaceId: 'ws_1',
        conversationId: 'chat_source',
        sourceBotId: 'bot_source',
        targetBotId: 'bot_target',
        request: 'Recover this handoff.',
      })
      deliveryStore.attachSpawnTask('delivery_recover', task.taskId)

      const dispatched: SpawnTask[] = []
      const service = makeService(deliveryStore, taskStore, (reserved) => dispatched.push(reserved))

      await service.reconcileStartup()

      expect(dispatched).toHaveLength(1)
      expect(dispatched[0]?.dispatch.handoffFence).toEqual({
        deliveryId: 'delivery_recover',
        claimId: 'claim_handoff',
        recipientBotId: 'bot_target',
        ownerEpoch: 1,
      })
      expect(deliveryStore.get('delivery_recover')?.mailState).toBe('acknowledged')
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('publishes terminal unread and journal state after a fast task completion', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'handoff-terminal-'))
    try {
      const deliveryStore = new HandoffDeliveryStore({ workspaceRoot, clock: () => at })
      const taskStore = new SpawnTaskStore({ workspaceRoot, workspaceId: 'ws_1', clock: () => at })
      const task = taskStore.reserveForHandoff('handoff_terminal', {
        parentSessionId: 'session_source',
        delegatedPrompt: 'Finish quickly.',
        childConfig: {},
      })
      deliveryStore.create({
        deliveryId: 'delivery_terminal',
        handoffId: 'handoff_terminal',
        workspaceId: 'ws_1',
        conversationId: 'chat_source',
        sourceBotId: 'bot_source',
        targetBotId: 'bot_target',
        request: 'Finish quickly.',
      })
      deliveryStore.attachSpawnTask('delivery_terminal', task.taskId)
      const claimed = deliveryStore.claimDelivery('delivery_terminal', {
        claimId: 'claim_terminal',
        recipientBotId: 'bot_target',
        expectedOwnerEpoch: 0,
      })
      deliveryStore.acknowledgeDelivery('delivery_terminal', {
        claimId: claimed.claim!.claimId,
        recipientBotId: 'bot_target',
        ownerEpoch: claimed.claim!.ownerEpoch,
      })
      taskStore.setHandoffDispatchFence(task.taskId, {
        deliveryId: 'delivery_terminal',
        claimId: 'claim_terminal',
        recipientBotId: 'bot_target',
        ownerEpoch: 1,
      }, at)
      let current = taskStore.updateDispatch(task.taskId, 'ready', at)
      current = taskStore.updateDispatch(current.taskId, 'claimed', at)
      current = taskStore.updateDispatch(current.taskId, 'sent', at)
      current = taskStore.transition(current.taskId, { runtimeState: 'processing', at })
      const entries: string[] = []
      const journal = {
        append: (input: { idempotencyKey: string }) => {
          entries.push(input.idempotencyKey)
          return {} as never
        },
        list: () => entries.map((idempotencyKey, index) => ({ idempotencyKey, seq: index + 1 })) as never,
      } as unknown as ConversationJournal
      const service = makeService(deliveryStore, taskStore, undefined, journal)
      const completed = taskStore.commitResult(current.taskId, 'done', { committedAt: at })

      await service.onTaskUpdated(completed.taskId)
      await service.onTaskUpdated(completed.taskId)

      expect(deliveryStore.get('delivery_terminal')?.resultUnread).toEqual({ taskVersion: completed.version, at })
      expect(entries.filter((key) => key === 'handoff.handoff_terminal.terminal')).toHaveLength(1)
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('surfaces terminal journal persistence failures for startup retry', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'handoff-terminal-failure-'))
    try {
      const deliveryStore = new HandoffDeliveryStore({ workspaceRoot, clock: () => at })
      const taskStore = new SpawnTaskStore({ workspaceRoot, workspaceId: 'ws_1', clock: () => at })
      const reserved = taskStore.reserveForHandoff('handoff_terminal_failure', {
        parentSessionId: 'session_source',
        delegatedPrompt: 'Finish and persist.',
        childConfig: {},
      })
      deliveryStore.create({
        deliveryId: 'delivery_terminal_failure',
        handoffId: 'handoff_terminal_failure',
        workspaceId: 'ws_1',
        conversationId: 'chat_source',
        sourceBotId: 'bot_source',
        targetBotId: 'bot_target',
        request: 'Finish and persist.',
      })
      deliveryStore.attachSpawnTask('delivery_terminal_failure', reserved.taskId)
      const claimed = deliveryStore.claimDelivery('delivery_terminal_failure', {
        claimId: 'claim_terminal_failure',
        recipientBotId: 'bot_target',
        expectedOwnerEpoch: 0,
      })
      deliveryStore.acknowledgeDelivery('delivery_terminal_failure', {
        claimId: claimed.claim!.claimId,
        recipientBotId: 'bot_target',
        ownerEpoch: claimed.claim!.ownerEpoch,
      })
      taskStore.setHandoffDispatchFence(reserved.taskId, {
        deliveryId: 'delivery_terminal_failure',
        claimId: 'claim_terminal_failure',
        recipientBotId: 'bot_target',
        ownerEpoch: 1,
      }, at)
      let current = taskStore.updateDispatch(reserved.taskId, 'ready', at)
      current = taskStore.updateDispatch(current.taskId, 'claimed', at)
      current = taskStore.updateDispatch(current.taskId, 'sent', at)
      current = taskStore.transition(current.taskId, { runtimeState: 'processing', at })
      const journal = {
        append: () => { throw new Error('journal disk is full') },
        list: () => [],
      } as unknown as ConversationJournal
      const service = makeService(deliveryStore, taskStore, undefined, journal)
      taskStore.commitResult(current.taskId, 'done', { committedAt: at })

      const report = await service.reconcileStartup()

      expect(report.terminalAppendFailures).toBe(1)
      expect(report.recoveryFailures).toEqual([])
      expect(deliveryStore.get('delivery_terminal_failure')?.resultUnread).toBeDefined()
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('reports a recovery failure with the affected delivery ID', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'handoff-recovery-report-'))
    try {
      const deliveryStore = new HandoffDeliveryStore({ workspaceRoot, clock: () => at })
      const taskStore = new SpawnTaskStore({ workspaceRoot, workspaceId: 'ws_1', clock: () => at })
      const reserved = taskStore.reserveForHandoff('handoff_broken', {
        parentSessionId: 'session_source',
        delegatedPrompt: 'Recover me.',
        childConfig: {},
      })
      deliveryStore.create({
        deliveryId: 'delivery_broken',
        handoffId: 'handoff_broken',
        workspaceId: 'ws_1',
        conversationId: 'chat_source',
        sourceBotId: 'bot_source',
        targetBotId: 'bot_target',
        request: 'Recover me.',
      })
      deliveryStore.attachSpawnTask('delivery_broken', reserved.taskId)
      const claimed = deliveryStore.claimDelivery('delivery_broken', {
        claimId: 'claim_broken',
        recipientBotId: 'bot_target',
        expectedOwnerEpoch: 0,
      })
      deliveryStore.acknowledgeDelivery('delivery_broken', {
        claimId: claimed.claim!.claimId,
        recipientBotId: 'bot_target',
        ownerEpoch: claimed.claim!.ownerEpoch,
      })
      const service = makeService(deliveryStore, taskStore)
      taskStore.get = () => { throw new Error('task storage unavailable') }

      const report = await service.reconcileStartup()

      expect(report.recoveryFailures).toEqual([{
        deliveryId: 'delivery_broken',
        message: 'task storage unavailable',
      }])
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true })
    }
  })
})
