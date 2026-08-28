import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { botProviderSessionPath } from '@kata-sh/shared/bots'
import { channelProviderSessionPath, RetryableStageDispatchError } from '@kata-sh/shared/channels'
import type { BotPermissionMode, BotProviderConfig } from '@kata-sh/core'
import type { BotTurnContext } from '@kata-sh/core'
import type { HandlerDeps } from '../handler-deps'
import { ensureDurableDirectory, syncDirectory, writeDurableFile, writeDurableFileIfAbsent } from '@kata-sh/shared/spawn-tasks/durable-fs'

export interface BotSessionTarget {
  readonly workspaceId: string
  readonly botId: string
  readonly name: string
  readonly permissionMode: BotPermissionMode
  readonly providerConfig: BotProviderConfig
  readonly sessionPointerPath: string
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

function readSessionId(path: string): string | null {
  if (!existsSync(path)) return null
  const value = readFileSync(path, 'utf8').trim()
  return value || null
}

function writeSessionId(path: string, sessionId: string): void {
  const directory = dirname(path)
  ensureDurableDirectory(directory)
  if (writeDurableFileIfAbsent(path, `${sessionId}\n`)) {
    syncDirectory(directory)
    return
  }
  if (readSessionId(path) !== sessionId) {
    writeDurableFile(path, `${sessionId}\n`)
    syncDirectory(directory)
  }
}

function messageText(message: { content?: string; text?: string }): string { return message.content ?? message.text ?? '' }
function dispatchResultPath(sessionPointerPath: string, key: string): string { return join(dirname(sessionPointerPath), 'provider-dispatches', `${createHash('sha256').update(key, 'utf8').digest('hex')}.json`) }
type BotSession = {
  id: string
  workspaceId: string
  hidden: true
  model?: string
  llmConnection?: string
  messages?: Array<{ id?: string; role?: string; content?: string; text?: string }>
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
function clearDispatchRecord(sessionPointerPath: string, key: string): void { rmSync(dispatchResultPath(sessionPointerPath, key), { force: true }) }

type DispatchRecord = { dispatchIdempotencyKey: string; sessionId: string; state: 'pending' | 'completed'; userMessageId?: string; reply?: string }

function readDispatchRecord(sessionPointerPath: string, key: string): DispatchRecord | null {
  const path = dispatchResultPath(sessionPointerPath, key)
  if (!existsSync(path)) return null
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as Partial<DispatchRecord> & { schemaVersion?: unknown }
    if (record.schemaVersion !== 1 || record.dispatchIdempotencyKey !== key || typeof record.sessionId !== 'string' || !record.sessionId) return null
    if (record.state === 'completed' && typeof record.reply === 'string' && record.reply.trim()) return { dispatchIdempotencyKey: key, sessionId: record.sessionId, state: 'completed', reply: record.reply }
    if (record.state === 'pending' && typeof record.userMessageId === 'string' && record.userMessageId) return { dispatchIdempotencyKey: key, sessionId: record.sessionId, state: 'pending', userMessageId: record.userMessageId }
    return null
  } catch { return null }
}

function writeDispatchRecord(sessionPointerPath: string, key: string, record: Omit<DispatchRecord, 'dispatchIdempotencyKey'>): void {
  const path = dispatchResultPath(sessionPointerPath, key)
  const directory = dirname(path)
  ensureDurableDirectory(directory)
  const payload = `${JSON.stringify({ schemaVersion: 1, dispatchIdempotencyKey: key, ...record }, null, 2)}\n`
  if (writeDurableFileIfAbsent(path, payload)) {
    syncDirectory(directory)
    return
  }
  const existing = readDispatchRecord(sessionPointerPath, key)
  if (record.state === 'completed' && existing?.state !== 'completed') {
    writeDurableFile(path, payload)
    syncDirectory(directory)
  }
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
  pending: DispatchRecord,
  target: Pick<BotSessionTarget, 'workspaceId' | 'providerConfig'>,
): Promise<{ sessionId: string; reply: string } | null> {
  const deadline = Date.now() + SEND_TIMEOUT_MS
  while (Date.now() < deadline) {
    const session = await sessionManager.getSession(pending.sessionId)
    if (!isUsableBotSession(session, target)) return null
    const messages = (session.messages ?? []) as Array<{ id?: string; role?: string; content?: string; text?: string }>
    const reply = assistantAfter(messages, pending.userMessageId!)
    if (reply && !(session as { isProcessing?: boolean }).isProcessing) {
      writeDispatchRecord(pointerPath, pending.dispatchIdempotencyKey, { sessionId: pending.sessionId, state: 'completed', reply })
      return { sessionId: pending.sessionId, reply }
    }
    if (!(session as { isProcessing?: boolean }).isProcessing && !reply) return null
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  const session = await sessionManager.getSession(pending.sessionId)
  if (isUsableBotSession(session, target) && session.isProcessing) {
    throw new RetryableStageDispatchError()
  }
  return null
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
    await withSessionQueue(pointer, async () => {
      const sessionId = readSessionId(pointer)
      if (sessionId) {
        const session = await sessionManager.getSession(sessionId)
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
        }
        return
      }
      rmSync(pointer, { force: true })
    })
  }
}

export async function sendToBotSession(
  sessionManager: HandlerDeps['sessionManager'],
  target: BotSessionTarget,
  message: string,
  options: { callerClientId?: string; waitForReply: boolean; dispatchIdempotencyKey?: string; botTurnContext?: BotTurnContext },
): Promise<{ sessionId: string; reply: string | null }> {
  if (options.botTurnContext && (
    options.botTurnContext.workspaceId !== target.workspaceId
    || options.botTurnContext.botId !== target.botId
  )) {
    throw new Error('Bot runtime context identity mismatch')
  }
  return withSessionQueue(target.sessionPointerPath, async () => {
    const key = options.dispatchIdempotencyKey
    if (key) {
      const cached = readDispatchRecord(target.sessionPointerPath, key)
      const cachedSession = cached ? await sessionManager.getSession(cached.sessionId) : null
      if (cached?.state === 'completed' && isUsableBotSession(cachedSession, target)) {
        return { sessionId: cached.sessionId, reply: cached.reply! }
      }
      if (cached?.state === 'pending' && isUsableBotSession(cachedSession, target)) {
        const recovered = await recoverPending(sessionManager, target.sessionPointerPath, cached, target)
        if (recovered) return recovered
        // Unsuccessful recovery must not leave the stale pending record: a later
        // read would retry its userMessageId and a restart could revive the old turn.
        clearDispatchRecord(target.sessionPointerPath, key)
      }
      if (cached && !isUsableBotSession(cachedSession, target)) clearDispatchRecord(target.sessionPointerPath, key)
    }

    let pending = key ? readDispatchRecord(target.sessionPointerPath, key) : null
    const pendingSession = pending?.state === 'pending'
      ? await sessionManager.getSession(pending.sessionId)
      : null
    if (pending && !isUsableBotSession(pendingSession, target)) {
      clearDispatchRecord(target.sessionPointerPath, key!)
      pending = null
    }
    let sessionId = isUsableBotSession(pendingSession, target)
      ? pendingSession.id
      : readSessionId(target.sessionPointerPath)
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
    if (before.isProcessing) throw new RetryableStageDispatchError()
    let acknowledgedMessageId: string | undefined = pending?.state === 'pending' ? pending.userMessageId : undefined
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
      sessionManager.sendMessage(sessionId!, message, undefined, undefined, undefined, acknowledgedMessageId, undefined, onAck, options.callerClientId || options.botTurnContext ? { callerClientId: options.callerClientId, botTurnContext: options.botTurnContext } : undefined).then(() => {
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
      const session = await sessionManager.getSession(sessionId)
      if (!isUsableBotSession(session, target)) throw new Error('Bot provider session identity changed while dispatching')
      const messages = session.messages ?? []
      const reply = acknowledgedMessageId
        ? assistantAfter(messages, acknowledgedMessageId)
        : null
      if (!session.isProcessing && reply) {
        if (key) writeDispatchRecord(target.sessionPointerPath, key, { sessionId, state: 'completed', reply })
        return { sessionId, reply }
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    const session = await sessionManager.getSession(sessionId)
    if (isUsableBotSession(session, target) && session.isProcessing) throw new RetryableStageDispatchError()
    return { sessionId, reply: null }
  })
}
