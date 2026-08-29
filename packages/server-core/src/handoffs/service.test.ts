import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { BotRecord, BotTurnContext, HandoffDeliveryClaim, JournalEntry, SpawnTask } from '@kata-sh/core'
import { HandoffDeliveryStore } from '@kata-sh/shared/handoffs'
import { SpawnTaskStore } from '@kata-sh/shared/spawn-tasks'
import { botProviderSessionPath } from '@kata-sh/shared/bots'
import { channelProviderSessionPath } from '@kata-sh/shared/channels'
import { SpawnTaskCoordinator } from '../sessions/spawn-task-coordinator'
import {
  HandoffService,
  toHandoffTaskView,
  type HandoffReserveInput,
  type HandoffServiceOptions,
  type HandoffTaskStore,
} from './service'

const at = '2026-08-28T00:00:00.000Z'
type TestJournal = ReturnType<HandoffServiceOptions['resolveJournal']>

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message)
  return value
}

function requireClaim(value: { readonly claim?: HandoffDeliveryClaim }): HandoffDeliveryClaim {
  return requireValue(value.claim, 'Expected a delivery claim')
}

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
  journalOverride?: Partial<TestJournal>,
  overrides?: Partial<Pick<HandoffServiceOptions, 'channelDirectory' | 'sessionManager'>>,
): HandoffService {
  const source = bot('bot_source', 'Source', 'chat_source')
  const target = bot('bot_target', 'Reviewer', 'chat_target', 'Review carefully <private>.')
  const entries: JournalEntry[] = []
  const journal: TestJournal = {
    workspaceId: 'ws_1',
    append: (input) => {
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
    getHeadSequence: () => entries.length,
    ...journalOverride,
  }
  const options: HandoffServiceOptions = {
    workspaceId: 'ws_1',
    workspaceRoot: dirname(deliveryStore.rootPath),
    deliveryStore,
    resolveJournal: () => journal,
    botDirectory: {
      getBotByLegacySession: () => source,
      getBot: (botId: string) => [source, target].find((candidate) => candidate.botId === botId) ?? null,
      listBots: () => [source, target],
    },
    channelDirectory: overrides?.channelDirectory ?? {
      getChannel: () => null,
      listChannels: () => [],
      isMember: () => true,
    },
    sessionManager: overrides?.sessionManager ?? {
      getSession: async (id: string) => ({ id, workspaceId: 'ws_1' }),
      cancelSpawnTask: async () => ({ status: 'already_terminal' as const, task: null }),
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
      const taskStore: HandoffTaskStore = {
        reserveForHandoff: (_handoffId: string, input: HandoffReserveInput) => {
          order.push('reserve')
          reservedInput = input
          if (!deliveryStore.getByHandoff('handoff_handoff')) {
            throw new Error('delivery must exist before task reservation')
          }
          return task()
        },
        getByHandoff: () => null,
        get: () => null,
        setHandoffDispatchFence: (taskId, fence) => ({
          ...task(),
          taskId,
          version: 2,
          origin: { kind: 'handoff' as const, handoffId: 'handoff_handoff' },
          dispatch: { ...task().dispatch, handoffFence: fence },
        }),
        readResultChunk: () => { throw new Error('No result in this fixture') },
      }
      const originalCreate = deliveryStore.create.bind(deliveryStore)
      deliveryStore.create = (input) => {
        order.push('delivery')
        return originalCreate(input)
      }
      const service = makeService(deliveryStore, taskStore, (_task, botTurnContext) => {
        dispatchedContext = botTurnContext
      })

      await expect(service.createHandoff({
        callerSessionId: 'session_source',
        targetBot: 'Reviewer',
        request: 'Audit the release diff.',
      })).resolves.toMatchObject({ handoffId: 'handoff_handoff' })

      expect(order.slice(0, 2)).toEqual(['delivery', 'reserve'])
      const capturedInput = requireValue(reservedInput, 'Expected a reserved task input')
      const capturedContext = requireValue(dispatchedContext, 'Expected a dispatched Bot context')
      expect(capturedInput.childConfig.permissionMode).toBe('safe')
      expect(capturedContext.botId).toBe('bot_target')
      expect(capturedContext.text).toContain('Review carefully &lt;private&gt;.')
      expect(capturedContext.text).not.toContain('bot_source')
      expect(readdirSync(join(workspaceRoot, 'bots', 'bot_target', 'memory', 'runs'))).toEqual([
        `${capturedContext.runId}.json`,
      ])
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('fails durable delivery mail when task reservation fails', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'handoff-reserve-failure-'))
    try {
      const deliveryStore = new HandoffDeliveryStore({ workspaceRoot, clock: () => at })
      const taskStore = new SpawnTaskStore({ workspaceRoot, workspaceId: 'ws_1', clock: () => at })
      taskStore.reserveForHandoff = () => { throw new Error('task storage unavailable') }
      const entries: Array<Parameters<TestJournal['append']>[0]> = []
      const service = makeService(deliveryStore, taskStore, undefined, {
        append: (entry) => {
          entries.push(entry)
          return {
            schemaVersion: 1,
            entryId: `entry_${entries.length}`,
            seq: entries.length,
            createdAt: at,
            ...entry,
          }
        },
        list: () => entries.map((entry, index) => ({
          schemaVersion: 1,
          entryId: `entry_${index + 1}`,
          seq: index + 1,
          createdAt: at,
          ...entry,
        })),
      })

      await expect(service.createHandoff({
        callerSessionId: 'session_source',
        targetBot: 'Reviewer',
        request: 'This cannot reserve.',
      })).rejects.toMatchObject({ code: 'handoff_reserve_failed' })

      expect(deliveryStore.listAll()).toEqual([
        expect.objectContaining({
          handoffId: 'handoff_handoff',
          mailState: 'delivery-failed',
          failure: expect.objectContaining({ code: 'task_reservation_failed' }),
        }),
      ])
      expect(entries).toHaveLength(1)
      expect(entries[0]?.idempotencyKey).toBe('handoff.handoff_handoff.terminal')
      await service.reconcileStartup()
      expect(entries).toHaveLength(1)
      expect(taskStore.getByHandoff('handoff_handoff')).toBeNull()
      expect(deliveryStore.getByHandoff('handoff_handoff')?.mailState).toBe('delivery-failed')
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('keeps provider-started work recoverable when acknowledgement persistence fails', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'handoff-ack-recovery-'))
    try {
      const deliveryStore = new HandoffDeliveryStore({ workspaceRoot, clock: () => at })
      const taskStore = new SpawnTaskStore({ workspaceRoot, workspaceId: 'ws_1', clock: () => at })
      const acknowledgeDelivery = deliveryStore.acknowledgeDelivery.bind(deliveryStore)
      let rejectAcknowledgement = true
      deliveryStore.acknowledgeDelivery = (deliveryId, input) => {
        if (rejectAcknowledgement) {
          rejectAcknowledgement = false
          throw new Error('acknowledgement unavailable')
        }
        return acknowledgeDelivery(deliveryId, input)
      }
      let providerCalls = 0
      const service = makeService(deliveryStore, taskStore, (dispatched) => {
        providerCalls += 1
        let current = taskStore.updateDispatch(dispatched.taskId, 'ready', at)
        current = taskStore.updateDispatch(current.taskId, 'claimed', at)
        current = taskStore.updateDispatch(current.taskId, 'sent', at)
        taskStore.transition(current.taskId, { runtimeState: 'processing', at })
      })

      const created = await service.createHandoff({
        callerSessionId: 'session_source',
        targetBot: 'Reviewer',
        request: 'Continue through acknowledgement recovery.',
      })

      expect(deliveryStore.get(created.deliveryId)?.mailState).toBe('claimed')
      expect(providerCalls).toBe(1)

      const report = await service.reconcileStartup()

      expect(report.acknowledged).toBe(1)
      expect(deliveryStore.get(created.deliveryId)?.mailState).toBe('acknowledged')
      expect(providerCalls).toBe(1)
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('returns stable IDs when requested journal publication needs startup repair', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'handoff-journal-repair-'))
    try {
      const deliveryStore = new HandoffDeliveryStore({ workspaceRoot, clock: () => at })
      const taskStore = new SpawnTaskStore({ workspaceRoot, workspaceId: 'ws_1', clock: () => at })
      const entries: JournalEntry[] = []
      let rejectRequestedEntry = true
      const journal = {
        append: (input: Parameters<TestJournal['append']>[0]) => {
          if (rejectRequestedEntry && input.idempotencyKey.endsWith('.requested')) {
            rejectRequestedEntry = false
            throw new Error('journal unavailable')
          }
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
      let providerCalls = 0
      const service = makeService(deliveryStore, taskStore, () => {
        providerCalls += 1
      }, journal)

      const created = await service.createHandoff({
        callerSessionId: 'session_source',
        targetBot: 'Reviewer',
        request: 'Repair the journal without duplicating this task.',
      })

      expect(created).toMatchObject({ handoffId: 'handoff_handoff', deliveryId: 'delivery_delivery' })
      expect(providerCalls).toBe(1)
      expect(entries).toHaveLength(0)

      await service.reconcileStartup()

      expect(entries.map((entry) => entry.idempotencyKey)).toEqual(['handoff.handoff_handoff.requested'])
      expect(providerCalls).toBe(1)
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
        append: (input: Parameters<TestJournal['append']>[0]) => {
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
      let current = requireValue(taskStore.get(created.taskId), 'Expected the created handoff task')
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
      const projectedTask = requireValue(rail.task, 'Expected a projected handoff task')
      const requestedEntry = requireValue(entries[0], 'Expected the requested journal entry')
      const terminalEntry = requireValue(entries[1], 'Expected the terminal journal entry')
      expect(JSON.parse(requestedEntry.body)).toEqual({
        type: 'handoff-requested',
        handoffId: created.handoffId,
        deliveryId: created.deliveryId,
      })
      expect(JSON.parse(terminalEntry.body)).toEqual({
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

  it('recovers a channel handoff through its channel provider session', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'handoff-channel-recovery-'))
    try {
      const deliveryStore = new HandoffDeliveryStore({ workspaceRoot, clock: () => at })
      const taskStore = new SpawnTaskStore({ workspaceRoot, workspaceId: 'ws_1', clock: () => at })
      deliveryStore.create({
        deliveryId: 'delivery_channel',
        handoffId: 'handoff_channel',
        workspaceId: 'ws_1',
        conversationId: 'channel_team',
        sourceBotId: 'bot_source',
        targetBotId: 'bot_target',
        request: 'Recover in the channel.',
      })
      const directPointer = botProviderSessionPath(workspaceRoot, 'bot_source')
      const channelPointer = channelProviderSessionPath(workspaceRoot, 'channel_team', 'bot_source')
      mkdirSync(dirname(directPointer), { recursive: true })
      mkdirSync(dirname(channelPointer), { recursive: true })
      writeFileSync(directPointer, 'session_direct\n', 'utf8')
      writeFileSync(channelPointer, 'session_channel\n', 'utf8')
      const service = makeService(deliveryStore, taskStore, undefined, undefined, {
        channelDirectory: {
          getChannel: () => ({
            schemaVersion: 1,
            channelId: 'channel_team',
            workspaceId: 'ws_1',
            name: 'Team',
            lifecycle: 'active',
            membershipRevision: 1,
            members: [{ botId: 'bot_source', priority: 0, addedAt: at }],
            createdAt: at,
            updatedAt: at,
          }),
          listChannels: () => [],
          isMember: () => true,
        },
      })

      await service.reconcileStartup()

      expect(taskStore.getByHandoff('handoff_channel')?.parentSessionId).toBe('session_channel')
      expect(deliveryStore.get('delivery_channel')?.mailState).toBe('acknowledged')
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('cancels an acknowledged active child and rejects its late result', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'handoff-active-cancel-'))
    try {
      const deliveryStore = new HandoffDeliveryStore({ workspaceRoot, clock: () => at })
      const taskStore = new SpawnTaskStore({ workspaceRoot, workspaceId: 'ws_1', clock: () => at })
      const reserved = taskStore.reserveForHandoff('handoff_cancel', {
        parentSessionId: 'session_source',
        delegatedPrompt: 'Keep running.',
        childConfig: {},
      })
      deliveryStore.create({
        deliveryId: 'delivery_cancel',
        handoffId: 'handoff_cancel',
        workspaceId: 'ws_1',
        conversationId: 'chat_source',
        sourceBotId: 'bot_source',
        targetBotId: 'bot_target',
        request: 'Keep running.',
      })
      deliveryStore.attachSpawnTask('delivery_cancel', reserved.taskId)
      const claimed = deliveryStore.claimDelivery('delivery_cancel', {
        claimId: 'claim_cancel',
        recipientBotId: 'bot_target',
        expectedOwnerEpoch: 0,
      })
      if (!claimed.claim) throw new Error('Expected the cancellation delivery claim')
      deliveryStore.acknowledgeDelivery('delivery_cancel', {
        claimId: claimed.claim.claimId,
        recipientBotId: 'bot_target',
        ownerEpoch: claimed.claim.ownerEpoch,
      })
      let current = taskStore.updateDispatch(reserved.taskId, 'ready', at)
      current = taskStore.updateDispatch(current.taskId, 'claimed', at)
      current = taskStore.updateDispatch(current.taskId, 'sent', at)
      current = taskStore.transition(current.taskId, { runtimeState: 'processing', at })
      const lateEvents: string[] = []
      const coordinator = new SpawnTaskCoordinator({
        store: taskStore,
        createChild: async () => {},
        appendDelegatedPrompt: async () => {},
        dispatchProvider: async () => {},
        onLateEvent: (event) => { lateEvents.push(event.eventKind) },
        clock: () => at,
      })
      let aborted = false
      const service = makeService(deliveryStore, taskStore, undefined, undefined, {
        sessionManager: {
          getSession: async (id: string) => ({ id, workspaceId: 'ws_1' }),
          cancelSpawnTask: (taskId, reason) => coordinator.cancelTask(taskId, reason ?? 'cancelled', {
            abort: () => { aborted = true },
          }),
        },
      })

      expect(service.getHandoffRail('chat_source', 'handoff_cancel').actions).toContain('cancel')
      await expect(service.cancelHandoff('chat_source', 'handoff_cancel', 'Stop now.'))
        .resolves.toMatchObject({ status: 'cancelled', task: { runtimeState: 'cancelled' } })
      expect(aborted).toBe(true)

      await coordinator.finalizeResultForChildSession(current.childSessionId, 'late result')
      expect(taskStore.get(current.taskId)).toMatchObject({ runtimeState: 'cancelled' })
      expect(taskStore.get(current.taskId)).not.toHaveProperty('result')
      expect(lateEvents).toContain('result')
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
      const claim = requireClaim(claimed)
      deliveryStore.acknowledgeDelivery('delivery_terminal', {
        claimId: claim.claimId,
        recipientBotId: 'bot_target',
        ownerEpoch: claim.ownerEpoch,
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
      const entries: JournalEntry[] = []
      const journal: TestJournal = {
        workspaceId: 'ws_1',
        append: (input) => {
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
        getHeadSequence: () => entries.length,
      }
      const service = makeService(deliveryStore, taskStore, undefined, journal)
      const completed = taskStore.commitResult(current.taskId, 'done', { committedAt: at })

      await service.onTaskUpdated(completed.taskId)
      await service.onTaskUpdated(completed.taskId)

      expect(deliveryStore.get('delivery_terminal')?.resultUnread).toEqual({ taskVersion: completed.version, at })
      expect(entries.filter((entry) => entry.idempotencyKey === 'handoff.handoff_terminal.terminal')).toHaveLength(1)
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
      const claim = requireClaim(claimed)
      deliveryStore.acknowledgeDelivery('delivery_terminal_failure', {
        claimId: claim.claimId,
        recipientBotId: 'bot_target',
        ownerEpoch: claim.ownerEpoch,
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
      const journal: TestJournal = {
        workspaceId: 'ws_1',
        append: () => { throw new Error('journal disk is full') },
        list: () => [{
          schemaVersion: 1,
          entryId: 'entry_requested',
          conversationId: 'chat_source',
          seq: 1,
          kind: 'handoff',
          authorBotId: 'bot_source',
          handoffId: 'handoff_terminal_failure',
          idempotencyKey: 'handoff.handoff_terminal_failure.requested',
          body: JSON.stringify({ type: 'handoff-requested' }),
          createdAt: at,
        }],
        getHeadSequence: () => 1,
      }
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
      const claim = requireClaim(claimed)
      deliveryStore.acknowledgeDelivery('delivery_broken', {
        claimId: claim.claimId,
        recipientBotId: 'bot_target',
        ownerEpoch: claim.ownerEpoch,
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
