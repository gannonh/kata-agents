import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { botProviderSessionPath } from '@kata-sh/shared/bots'
import { channelProviderSessionPath, RetryableStageDispatchError } from '@kata-sh/shared/channels'
import type { ApprovalPending, BotPermissionMode, BotProviderConfig, ToolInvocation } from '@kata-sh/core'
import type { BotTurnContext } from '@kata-sh/core'
import type { HandlerDeps } from '../handler-deps'
import { getApprovalRuntime } from '../../approvals/runtime'
import { assertDirectory, assertRegularFile, ensureDurableDirectory, syncDirectory, withDurableLockAsync, writeDurableFile, writeDurableFileIfAbsent } from '@kata-sh/shared/spawn-tasks/durable-fs'

export interface BotSessionTarget {
  readonly workspaceId: string
  readonly botId: string
  readonly name: string
  readonly permissionMode: BotPermissionMode
  readonly providerConfig: BotProviderConfig
  readonly sessionPointerPath: string
  /** Public conversation that owns this Bot turn, when the caller needs approval recovery. */
  readonly conversationId?: string
  /** Exact approved invocation used only to reconstruct a provider turn after restart. */
  readonly approvalInvocation?: ToolInvocation
}

export class BotApprovalPendingError extends Error {
  override readonly name = 'BotApprovalPendingError'

  constructor(readonly record: ApprovalPending) {
    super(`Bot execution is awaiting approval ${record.approvalId}`)
  }
}

export class BotDispatchUncertainError extends Error {
  override readonly name = 'BotDispatchUncertainError'

  constructor() {
    super('Bot provider dispatch outcome is uncertain')
  }
}

const SEND_TIMEOUT_MS = 120_000
const sessionQueues = new Map<string, Promise<void>>()

async function withSessionQueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prior = sessionQueues.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => { release = resolve })
  const queued = prior.then(() => current)
  sessionQueues.set(key, queued)
  await prior
  try { return await task() } finally {
    release()
    if (sessionQueues.get(key) === queued) sessionQueues.delete(key)
  }
}

async function withDispatchLock<T>(path: string, task: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + SEND_TIMEOUT_MS
  while (true) {
    try { return await withDurableLockAsync(path, () => task()) } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('Durable lock is busy:') || Date.now() >= deadline) throw error
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
}

function quarantine(path: string): void {
  try { renameSync(path, `${path}.corrupt-${randomUUID()}`) } catch { /* another process may have replaced it */ }
}

function readSessionId(path: string): string | null {
  if (!existsSync(path)) return null
  try {
    assertRegularFile(path, 'Bot provider session pointer')
    const value = readFileSync(path, 'utf8').trim()
    return value || null
  } catch {
    quarantine(path)
    return null
  }
}

function writeSessionId(path: string, sessionId: string): void {
  if (!sessionId.trim()) throw new TypeError('Bot provider session ID is required')
  const directory = dirname(path)
  ensureDurableDirectory(directory)
  if (existsSync(path)) assertRegularFile(path, 'Bot provider session pointer')
  if (writeDurableFileIfAbsent(path, `${sessionId}\n`)) {
    syncDirectory(directory)
    return
  }
  assertRegularFile(path, 'Bot provider session pointer')
  if (readSessionId(path) !== sessionId) {
    writeDurableFile(path, `${sessionId}\n`)
    syncDirectory(directory)
  }
}

function messageText(message: { content?: string; text?: string }): string { return message.content ?? message.text ?? '' }
function dispatchResultPath(sessionPointerPath: string, key: string): string { return join(dirname(sessionPointerPath), 'provider-dispatches', `${createHash('sha256').update(key, 'utf8').digest('hex')}.json`) }
type BotSessionMessage = { id?: string; role?: string; content?: string; text?: string; idempotencyKey?: string }
type BotSession = {
  id: string
  workspaceId: string
  hidden: true
  model?: string
  llmConnection?: string
  messages?: BotSessionMessage[]
  isProcessing?: boolean
}

function isUsableBotSession(
  session: { id?: string; workspaceId?: string; hidden?: boolean; model?: string; llmConnection?: string } | null,
  target: Pick<BotSessionTarget, 'workspaceId' | 'providerConfig'>,
): session is BotSession {
  return !!session
    && session.workspaceId === target.workspaceId
    && session.hidden === true
    && session.model === target.providerConfig.modelId
    && session.llmConnection === target.providerConfig.providerId
    && typeof session.id === 'string'
    && session.id.length > 0
}
function clearDispatchRecords(sessionPointerPath: string): void {
  const directory = join(dirname(sessionPointerPath), 'provider-dispatches')
  if (!existsSync(directory)) return
  try {
    assertDirectory(directory, 'Bot provider dispatch directory')
    rmSync(directory, { recursive: true, force: true })
    syncDirectory(dirname(directory))
  } catch {
    quarantine(directory)
  }
}

type DispatchRecord =
  | { dispatchIdempotencyKey: string; sessionId: string; state: 'starting' }
  | { dispatchIdempotencyKey: string; sessionId: string; state: 'pending'; userMessageId: string }
  | { dispatchIdempotencyKey: string; sessionId: string; state: 'completed'; userMessageId: string; reply: string }
function dispatchLockPath(sessionPointerPath: string): string { return `${sessionPointerPath}.dispatch.lock` }

function pendingApprovalFor(
  target: Pick<BotSessionTarget, 'workspaceId' | 'botId' | 'conversationId'>,
  sessionId: string,
): ApprovalPending | null {
  if (!target.conversationId) return null
  try {
    const runtime = getApprovalRuntime(target.workspaceId)
    const record = runtime.store.listForConversation(target.conversationId).find(candidate =>
      candidate.status === 'pending'
      && candidate.botId === target.botId
      && candidate.runtimeId === sessionId,
    )
    if (!record || record.status !== 'pending') return null
    const current = runtime.store.expireIfDue(record.approvalId)
    return current.status === 'pending' ? current : null
  } catch {
    return null
  }
}

function readDispatchRecord(sessionPointerPath: string, key: string): DispatchRecord | null {
  const path = dispatchResultPath(sessionPointerPath, key)
  if (!existsSync(path)) return null
  try {
    assertRegularFile(path, 'Bot dispatch record')
    const record = JSON.parse(readFileSync(path, 'utf8')) as Partial<DispatchRecord> & { schemaVersion?: unknown }
    if (record.schemaVersion !== 1 || record.dispatchIdempotencyKey !== key || typeof record.sessionId !== 'string' || !record.sessionId) throw new Error('Bot dispatch record is corrupt')
    if (record.state === 'starting') return { dispatchIdempotencyKey: key, sessionId: record.sessionId, state: 'starting' }
    if (record.state === 'completed' && typeof record.reply === 'string' && record.reply.trim() && typeof record.userMessageId === 'string' && record.userMessageId) return { dispatchIdempotencyKey: key, sessionId: record.sessionId, state: 'completed', userMessageId: record.userMessageId, reply: record.reply }
    if (record.state === 'pending' && typeof record.userMessageId === 'string' && record.userMessageId) return { dispatchIdempotencyKey: key, sessionId: record.sessionId, state: 'pending', userMessageId: record.userMessageId }
    throw new Error('Bot dispatch record is corrupt')
  } catch {
    // A malformed record leaves the provider outcome unknown. Keep it in place
    // so retries cannot silently issue a second provider turn; reset is the
    // explicit cleanup path.
    throw new BotDispatchUncertainError()
  }
}

type DispatchRecordInput =
  | { sessionId: string; state: 'starting' }
  | { sessionId: string; state: 'pending'; userMessageId: string }
  | { sessionId: string; state: 'completed'; userMessageId: string; reply: string }

function writeDispatchRecord(sessionPointerPath: string, key: string, record: DispatchRecordInput): void {
  const path = dispatchResultPath(sessionPointerPath, key)
  const directory = dirname(path)
  ensureDurableDirectory(directory)
  const payload = `${JSON.stringify({ schemaVersion: 1, dispatchIdempotencyKey: key, ...record }, null, 2)}\n`
  if (writeDurableFileIfAbsent(path, payload)) {
    syncDirectory(directory)
    return
  }
  const existing = readDispatchRecord(sessionPointerPath, key)
  if (!existing) {
    if (!writeDurableFileIfAbsent(path, payload)) throw new Error('Bot dispatch record changed concurrently')
    syncDirectory(directory)
    return
  }
  if (existing.state === 'completed') {
    if (record.state === 'completed' && (existing.sessionId !== record.sessionId || existing.userMessageId !== record.userMessageId)) throw new Error('Bot dispatch record message changed')
    return
  }
  if (existing.sessionId !== record.sessionId) throw new Error('Bot dispatch record identity changed')
  if (existing.state === 'starting' && record.state === 'starting') return
  if (existing.state === 'pending' && 'userMessageId' in record && existing.userMessageId !== record.userMessageId) throw new Error('Bot dispatch record message changed')
  if (existing.state === 'starting' && record.state === 'pending') {
    assertRegularFile(path, 'Bot dispatch record')
    writeDurableFile(path, payload)
    syncDirectory(directory)
    return
  }
  if (record.state === 'completed') {
    writeDurableFile(path, payload)
    syncDirectory(directory)
  }
}

function findDispatchMessage(session: BotSession, key: string): (BotSessionMessage & { id: string }) | null {
  const found = session.messages?.find(candidate => candidate.role === 'user' && candidate.idempotencyKey === key && typeof candidate.id === 'string' && candidate.id)
  return found && typeof found.id === 'string' ? found as BotSessionMessage & { id: string } : null
}

function dispatchMessageId(session: BotSession, key: string, message: string): string | null {
  const found = findDispatchMessage(session, key)
  return found && messageText(found) === message ? found.id : null
}

function assertDispatchMessage(session: BotSession, userMessageId: string, message: string): void {
  const found = session.messages?.find(candidate => candidate.id === userMessageId && candidate.role === 'user')
  if (!found) throw new BotDispatchUncertainError()
  if (messageText(found) !== message) throw new Error('Bot dispatch record message changed')
}

function assistantAfter(messages: readonly { id?: string; role?: string; content?: string; text?: string }[], userMessageId: string): string | null {
  const index = messages.findIndex(message => message.id === userMessageId)
  if (index < 0) return null
  const afterUser = messages.slice(index + 1)
  const nextUser = afterUser.findIndex(message => message.role === 'user')
  const turn = nextUser < 0 ? afterUser : afterUser.slice(0, nextUser)
  const assistant = turn.find(message => message.role === 'assistant' && messageText(message))
  return assistant ? messageText(assistant) : null
}

async function recoverPending(
  sessionManager: HandlerDeps['sessionManager'],
  pointerPath: string,
  pending: Extract<DispatchRecord, { state: 'pending' }>,
  message: string,
  target: Pick<BotSessionTarget, 'workspaceId' | 'providerConfig' | 'botId' | 'conversationId' | 'permissionMode' | 'approvalInvocation'>,
  stopOnPendingApproval: boolean,
  context: {
    botTurnContext?: BotTurnContext
    botRoutineRunId?: string
    botAttempt?: number
  },
): Promise<{ sessionId: string; reply: string }> {
  const deadline = Date.now() + SEND_TIMEOUT_MS
  let resumeStarted = false
  let resumeError: unknown
  while (Date.now() < deadline) {
    if (stopOnPendingApproval) {
      const approval = pendingApprovalFor(target, pending.sessionId)
      if (approval) throw new BotApprovalPendingError(approval)
    }
    const session = await sessionManager.getSession(pending.sessionId)
    if (!isUsableBotSession(session, target)) throw new BotDispatchUncertainError()
    const userMessage = session.messages?.find(candidate => candidate.id === pending.userMessageId && candidate.role === 'user')
    if (!userMessage) throw new BotDispatchUncertainError()
    if (messageText(userMessage) !== message) throw new Error('Bot dispatch record message changed')
    const messages = (session.messages ?? []) as Array<{ id?: string; role?: string; content?: string; text?: string }>
    const reply = assistantAfter(messages, pending.userMessageId)
    if (reply && !(session as { isProcessing?: boolean }).isProcessing) {
      writeDispatchRecord(pointerPath, pending.dispatchIdempotencyKey, { sessionId: pending.sessionId, state: 'completed', userMessageId: pending.userMessageId, reply })
      return { sessionId: pending.sessionId, reply }
    }
    if (!(session as { isProcessing?: boolean }).isProcessing && !reply) {
      if (!context.botRoutineRunId) throw new BotDispatchUncertainError()
      if (!resumeStarted) {
        resumeStarted = true
        void sessionManager.sendMessage(
          pending.sessionId,
          message,
          undefined,
          undefined,
          undefined,
          pending.userMessageId,
          undefined,
          undefined,
          {
            botTurnContext: context.botTurnContext,
            botRoutineRunId: context.botRoutineRunId,
            botPermissionMode: target.permissionMode,
            botAttempt: context.botAttempt,
            botApprovalInvocation: target.approvalInvocation,
            botDispatchIdempotencyKey: pending.dispatchIdempotencyKey,
          },
        ).catch(error => { resumeError = error })
      }
      if (resumeError) throw new BotDispatchUncertainError()
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  const session = await sessionManager.getSession(pending.sessionId)
  if (isUsableBotSession(session, target) && session.isProcessing) {
    throw new RetryableStageDispatchError()
  }
  throw new BotDispatchUncertainError()
}

export async function resetBotProviderSessions(
  sessionManager: HandlerDeps['sessionManager'],
  workspaceRoot: string,
  workspaceId: string,
  botId: string,
): Promise<void> {
  const pointers = [botProviderSessionPath(workspaceRoot, botId)]
  const channelsRoot = join(workspaceRoot, 'channels')
  for (const channelId of existsSync(channelsRoot) ? readdirSync(channelsRoot, { withFileTypes: true }) : []) {
    if (channelId.isDirectory()) pointers.push(channelProviderSessionPath(workspaceRoot, channelId.name, botId))
  }
  for (const pointer of pointers) {
    await withSessionQueue(pointer, () => withDispatchLock(dispatchLockPath(pointer), async () => {
      const sessionId = readSessionId(pointer)
      if (sessionId) {
        let session: Awaited<ReturnType<HandlerDeps['sessionManager']['getSession']>> = null
        try {
          session = await sessionManager.getSession(sessionId)
        } catch {
          // A provider lookup failure leaves the pointer unusable. Remove it so
          // the next send creates a fresh hidden session.
        }
        if (session && (
          !(session as { hidden?: boolean }).hidden
          || session.workspaceId !== workspaceId
        )) return
        try {
          if (session) await sessionManager.deleteSession(sessionId)
        } catch {
          // Leave an orphaned hidden session rather than keeping a reusable
          // pointer after edit/forget. Next send creates a fresh session.
        } finally {
          rmSync(pointer, { force: true })
          clearDispatchRecords(pointer)
        }
        return
      }
      rmSync(pointer, { force: true })
      clearDispatchRecords(pointer)
    }))
  }
}

export async function sendToBotSession(
  sessionManager: HandlerDeps['sessionManager'],
  target: BotSessionTarget,
  message: string,
  options: {
    callerClientId?: string
    waitForReply: boolean
    dispatchIdempotencyKey?: string
    botTurnContext?: BotTurnContext
    botRoutineRunId?: string
    botAttempt?: number
    stopOnPendingApproval?: boolean
  },
): Promise<{ sessionId: string; reply: string | null }> {
  if (options.botTurnContext && (
    options.botTurnContext.workspaceId !== target.workspaceId
    || options.botTurnContext.botId !== target.botId
  )) {
    throw new Error('Bot runtime context identity mismatch')
  }
  return withSessionQueue(target.sessionPointerPath, () => withDispatchLock(dispatchLockPath(target.sessionPointerPath), async () => {
    const key = options.dispatchIdempotencyKey
    if (key) {
      let cached = readDispatchRecord(target.sessionPointerPath, key)
      let cachedSession = cached ? await sessionManager.getSession(cached.sessionId) : null
      if (cached?.state === 'starting') {
        if (!isUsableBotSession(cachedSession, target)) throw new BotDispatchUncertainError()
        const messageId = dispatchMessageId(cachedSession, key, message)
        if (!messageId) throw new BotDispatchUncertainError()
        writeDispatchRecord(target.sessionPointerPath, key, { sessionId: cached.sessionId, state: 'pending', userMessageId: messageId })
        cached = readDispatchRecord(target.sessionPointerPath, key)
      }
      if (cached?.state === 'completed') {
        if (!isUsableBotSession(cachedSession, target)) throw new BotDispatchUncertainError()
        assertDispatchMessage(cachedSession, cached.userMessageId, message)
        return { sessionId: cached.sessionId, reply: cached.reply }
      }
      if (cached?.state === 'pending') {
        if (!isUsableBotSession(cachedSession, target)) throw new BotDispatchUncertainError()
        return await recoverPending(
          sessionManager,
          target.sessionPointerPath,
          cached,
          message,
          target,
          options.stopOnPendingApproval === true,
          {
            botTurnContext: options.botTurnContext,
            botRoutineRunId: options.botRoutineRunId,
            botAttempt: options.botAttempt,
          },
        )
      }
      if (cached && !isUsableBotSession(cachedSession, target)) throw new BotDispatchUncertainError()
    }

    let sessionId = readSessionId(target.sessionPointerPath)
    const pointedSession = sessionId ? await sessionManager.getSession(sessionId) : null
    if (sessionId && !isUsableBotSession(pointedSession, target)) {
      sessionId = null
      rmSync(target.sessionPointerPath, { force: true })
    }
    if (!sessionId) {
      const session = await sessionManager.createSession(target.workspaceId, { name: target.name, hidden: true, permissionMode: target.permissionMode, model: target.providerConfig.modelId, llmConnection: target.providerConfig.providerId })
      if (!isUsableBotSession(session, target)) throw new Error('Bot provider session was not created as a hidden workspace session')
      sessionId = session.id
      writeSessionId(target.sessionPointerPath, sessionId)
    }

    const before = await sessionManager.getSession(sessionId)
    if (!isUsableBotSession(before, target)) throw new Error('Bot provider session identity changed before dispatch')
    let acknowledgedMessageId: string | undefined
    if (before.isProcessing) throw new RetryableStageDispatchError()
    if (key) {
      const existingMessage = findDispatchMessage(before, key)
      if (existingMessage && messageText(existingMessage) !== message) throw new Error('Bot dispatch record message changed')
      const existingMessageId = existingMessage?.id
      if (existingMessageId) {
        writeDispatchRecord(target.sessionPointerPath, key, { sessionId, state: 'pending', userMessageId: existingMessageId })
        const existingReply = assistantAfter(before.messages ?? [], existingMessageId)
        if (!before.isProcessing && existingReply) {
          writeDispatchRecord(target.sessionPointerPath, key, { sessionId, state: 'completed', userMessageId: existingMessageId, reply: existingReply })
          return { sessionId, reply: existingReply }
        }
        return await recoverPending(
          sessionManager,
          target.sessionPointerPath,
          { dispatchIdempotencyKey: key, sessionId, state: 'pending', userMessageId: existingMessageId },
          message,
          target,
          options.stopOnPendingApproval === true,
          {
            botTurnContext: options.botTurnContext,
            botRoutineRunId: options.botRoutineRunId,
            botAttempt: options.botAttempt,
          },
        )
      }
      writeDispatchRecord(target.sessionPointerPath, key, { sessionId, state: 'starting' })
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const onAck = (messageId: string) => {
        acknowledgedMessageId = messageId
        if (key) writeDispatchRecord(target.sessionPointerPath, key, { sessionId: sessionId!, state: 'pending', userMessageId: messageId })
        if (!settled) {
          settled = true
          resolve()
        }
      }
      sessionManager.sendMessage(sessionId!, message, undefined, undefined, undefined, acknowledgedMessageId, undefined, onAck, options.callerClientId || options.botTurnContext || key ? { callerClientId: options.callerClientId, botTurnContext: options.botTurnContext, botRoutineRunId: options.botRoutineRunId, botPermissionMode: target.permissionMode, botAttempt: options.botAttempt, botApprovalInvocation: target.approvalInvocation, botDispatchIdempotencyKey: key } : undefined).then(() => {
        if (!settled) {
          settled = true
          reject(new Error('Bot send completed without persisting a user message'))
        }
      }).catch((error: unknown) => {
        if (!settled) {
          settled = true
          reject(error)
        }
      })
    })

    if (!options.waitForReply) return { sessionId, reply: null }
    const deadline = Date.now() + SEND_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (options.stopOnPendingApproval) {
        const approval = pendingApprovalFor(target, sessionId)
        if (approval) throw new BotApprovalPendingError(approval)
      }
      const session = await sessionManager.getSession(sessionId)
      if (!isUsableBotSession(session, target)) throw new Error('Bot provider session identity changed while dispatching')
      const messages = session.messages ?? []
      const reply = acknowledgedMessageId
        ? assistantAfter(messages, acknowledgedMessageId)
        : null
      if (!session.isProcessing && reply) {
        if (key) writeDispatchRecord(target.sessionPointerPath, key, { sessionId: sessionId!, state: 'completed', userMessageId: acknowledgedMessageId!, reply })
        return { sessionId, reply }
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    const session = await sessionManager.getSession(sessionId)
    if (isUsableBotSession(session, target) && session.isProcessing) throw new RetryableStageDispatchError()
    if (key) throw new BotDispatchUncertainError()
    return { sessionId, reply: null }
  }))
}
