import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { basename } from 'node:path'
import { RPC_CHANNELS } from '@kata-sh/shared/protocol'
import { saveConfig } from '@kata-sh/shared/config'
import { SpawnTaskStore } from '@kata-sh/shared/spawn-tasks'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport/types'
import { TaskAccessError } from '../../handoffs/service'
import { getHandoffRuntime, type HandoffRuntimeSessionManager } from '../../handoffs/runtime'
import { registerHandoffsHandlers } from './handoffs'

const workspaceRoot = process.env.KATA_HANDOFF_TEST_WORKSPACE
if (!workspaceRoot) throw new Error('KATA_HANDOFF_TEST_WORKSPACE is required')
mkdirSync(workspaceRoot, { recursive: true })

const workspaceId = 'ws_handoff_authority'
saveConfig({
  workspaces: [{
    id: workspaceId,
    name: 'Handoff Authority',
    slug: basename(workspaceRoot),
    rootPath: workspaceRoot,
    createdAt: Date.now(),
  }],
  activeWorkspaceId: workspaceId,
  activeSessionId: null,
})

const taskStore = new SpawnTaskStore({ workspaceRoot, workspaceId })
const sessionManager: HandoffRuntimeSessionManager = {
  getSession: async (sessionId) => ({ id: sessionId, workspaceId }),
  cancelSpawnTask: async (taskId) => ({ status: 'already_terminal', task: taskStore.get(taskId) }),
  getOrCreateWorkspaceSpawnTaskRuntime: () => ({
    taskStore,
    coordinator: {
      dispatchReserved: async (task) => ({
        taskId: task.taskId,
        childSessionId: task.childSessionId,
        runtimeState: task.runtimeState,
        version: task.version,
      }),
    },
  }),
  setHandoffDelegateFactory: () => {},
}

const runtime = getHandoffRuntime(sessionManager, workspaceId)
const source = runtime.bots.createBot({
  name: 'Source',
  permissionMode: 'safe',
  providerConfig: { providerId: 'openai-codex', modelId: 'gpt-5' },
  idempotencyKey: 'source',
  legacySessionId: 'session_source',
})
const target = runtime.bots.createBot({
  name: 'Target',
  permissionMode: 'safe',
  providerConfig: { providerId: 'openai-codex', modelId: 'gpt-5' },
  idempotencyKey: 'target',
})

const delivery = runtime.deliveryStore.create({
  deliveryId: 'delivery_authority',
  handoffId: 'handoff_authority',
  workspaceId,
  conversationId: source.directChatId,
  sourceBotId: source.botId,
  targetBotId: target.botId,
  request: 'Verify the authority boundary.',
})
let task = taskStore.reserveForHandoff(delivery.handoffId, {
  parentSessionId: 'session_source',
  delegatedPrompt: delivery.request,
  childConfig: {},
})
runtime.deliveryStore.attachSpawnTask(delivery.deliveryId, task.taskId)
const claimed = runtime.deliveryStore.claimDelivery(delivery.deliveryId, {
  claimId: 'claim_authority',
  recipientBotId: target.botId,
  expectedOwnerEpoch: 0,
})
if (!claimed.claim) throw new Error('Expected a delivery claim')
runtime.deliveryStore.acknowledgeDelivery(delivery.deliveryId, {
  claimId: claimed.claim.claimId,
  recipientBotId: target.botId,
  ownerEpoch: claimed.claim.ownerEpoch,
})
task = taskStore.updateDispatch(task.taskId, 'ready', new Date().toISOString())
task = taskStore.updateDispatch(task.taskId, 'claimed', new Date().toISOString())
task = taskStore.updateDispatch(task.taskId, 'sent', new Date().toISOString())
task = taskStore.transition(task.taskId, { runtimeState: 'processing', at: new Date().toISOString() })
task = taskStore.commitResult(task.taskId, 'verified result', { committedAt: new Date().toISOString() })
runtime.deliveryStore.markResultUnread(delivery.deliveryId, {
  taskVersion: task.version,
  at: new Date().toISOString(),
})

const handlers = new Map<string, HandlerFn>()
const server: RpcServer = {
  handle: (channel, handler) => { handlers.set(channel, handler) },
  push: () => {},
  invokeClient: async () => undefined,
  hasClientCapability: () => false,
  findClientsWithCapability: () => [],
}
registerHandoffsHandlers(server, { sessionManager })

const context = (selectedWorkspaceId: string | null): RequestContext => ({
  clientId: 'client_authority',
  workspaceId: selectedWorkspaceId,
  webContentsId: 1,
})
const invoke = (channel: string, ctx: RequestContext, input: unknown): Promise<unknown> => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`Missing handler ${channel}`)
  return Promise.resolve(handler(ctx, input))
}
const authorized = context(workspaceId)
const foreign = context('ws_foreign')
const input = { conversationId: source.directChatId, handoffId: delivery.handoffId }

const rail = await invoke(RPC_CHANNELS.handoffs.GET_RAIL, authorized, input)
assert.equal(typeof rail, 'object')
await invoke(RPC_CHANNELS.handoffs.LIST, authorized, source.directChatId)
await invoke(RPC_CHANNELS.handoffs.READ_RESULT_CHUNK, authorized, { ...input, offset: 0, limit: 64 })
await invoke(RPC_CHANNELS.handoffs.CANCEL, authorized, { ...input, reason: 'Already complete.' })
await invoke(RPC_CHANNELS.handoffs.MARK_RESULT_READ, authorized, { ...input, expectedTaskVersion: task.version })
await invoke(RPC_CHANNELS.handoffs.WAIT, authorized, {
  ...input,
  waitId: 'wait_authority',
  after: { deliveryVersion: 0, taskVersion: 0, journalSequence: 0 },
  timeoutMs: 1,
})

for (const [channel, operationInput] of [
  [RPC_CHANNELS.handoffs.LIST, source.directChatId],
  [RPC_CHANNELS.handoffs.GET_RAIL, input],
  [RPC_CHANNELS.handoffs.READ_RESULT_CHUNK, { ...input, offset: 0, limit: 64 }],
  [RPC_CHANNELS.handoffs.CANCEL, { ...input, reason: 'Denied.' }],
  [RPC_CHANNELS.handoffs.MARK_RESULT_READ, { ...input, expectedTaskVersion: task.version }],
  [RPC_CHANNELS.handoffs.WAIT, { ...input, waitId: 'wait_foreign', timeoutMs: 1 }],
] satisfies ReadonlyArray<readonly [string, unknown]>) {
  await assert.rejects(invoke(channel, foreign, operationInput), TaskAccessError)
}

await assert.rejects(invoke(RPC_CHANNELS.handoffs.GET_RAIL, context(null), input), TaskAccessError)
process.stdout.write('handoff authority verified\n')
