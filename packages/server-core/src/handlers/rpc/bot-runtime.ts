import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { botProviderSessionPath } from '@kata-sh/shared/bots'
import { channelProviderSessionPath } from '@kata-sh/shared/channels'
import type { BotPermissionMode, BotProviderConfig } from '@kata-sh/core'
import type { BotTurnContext } from '@kata-sh/core'
import type { HandlerDeps } from '../handler-deps'
import { ensureDurableDirectory, syncDirectory, writeDurableFile, writeDurableFileIfAbsent } from '@kata-sh/shared/spawn-tasks/durable-fs'

export interface BotSessionTarget {
  readonly workspaceId: string
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

type DispatchRecord = { dispatchIdempotencyKey: string; sessionId: string; state: 'pending' | 'completed'; userMessageId?: string; reply?: string }

function readDispatchRecord(sessionPointerPath: string, key: string): DispatchRecord | null {
  const path = dispatchResultPath(sessionPointerPath, key)
  if (!existsSync(path)) return null
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as Partial<DispatchRecord> & { schemaVersion?: unknown }
    if (record.schemaVersion !== 1 || record.dispatchIdempotencyKey !== key || typeof record.sessionId !== 'string' || !record.sessionId) return null
    if (record.state === 'completed' && typeof record.reply === 'string') return { dispatchIdempotencyKey: key, sessionId: record.sessionId, state: 'completed', reply: record.reply }
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
  let index = messages.findIndex(message => message.id === userMessageId)
  if (index < 0) index = messages.map(message => message.role).lastIndexOf('user')
  if (index < 0) return null
  const assistant = messages.slice(index + 1).find(message => message.role === 'assistant' && messageText(message))
  return assistant ? messageText(assistant) : null
}

async function recoverPending(
  sessionManager: HandlerDeps['sessionManager'],
  pointerPath: string,
  pending: DispatchRecord,
): Promise<{ sessionId: string; reply: string } | null> {
  const deadline = Date.now() + SEND_TIMEOUT_MS
  while (Date.now() < deadline) {
    const session = await sessionManager.getSession(pending.sessionId)
    if (!session) return null
    const messages = (session.messages ?? []) as Array<{ id?: string; role?: string; content?: string; text?: string }>
    const reply = assistantAfter(messages, pending.userMessageId!)
    if (reply && !(session as { isProcessing?: boolean }).isProcessing) {
      writeDispatchRecord(pointerPath, pending.dispatchIdempotencyKey, { sessionId: pending.sessionId, state: 'completed', reply })
      return { sessionId: pending.sessionId, reply }
    }
    if (!(session as { isProcessing?: boolean }).isProcessing && !reply) return null
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return null
}

export async function resetBotProviderSessions(
  sessionManager: HandlerDeps['sessionManager'],
  workspaceRoot: string,
  botId: string,
): Promise<void> {
  const pointers = [botProviderSessionPath(workspaceRoot, botId)]
  const channelsRoot = join(workspaceRoot, 'channels')
  for (const channelId of existsSync(channelsRoot) ? readdirSync(channelsRoot, { withFileTypes: true }) : []) {
    if (channelId.isDirectory()) pointers.push(channelProviderSessionPath(workspaceRoot, channelId.name, botId))
  }
  for (const pointer of pointers) {
    const sessionId = readSessionId(pointer)
    if (sessionId) {
      const session = await sessionManager.getSession(sessionId)
      if (session && !(session as { hidden?: boolean }).hidden) continue
      if (session) await sessionManager.deleteSession(sessionId)
    }
    rmSync(pointer, { force: true })
  }
}

export async function sendToBotSession(
  sessionManager: HandlerDeps['sessionManager'],
  target: BotSessionTarget,
  message: string,
  options: { callerClientId?: string; waitForReply: boolean; dispatchIdempotencyKey?: string; botTurnContext?: BotTurnContext },
): Promise<{ sessionId: string; reply: string | null }> {
  return withSessionQueue(target.sessionPointerPath, async () => {
    const key = options.dispatchIdempotencyKey
    if (key) {
      const cached = readDispatchRecord(target.sessionPointerPath, key)
      if (cached?.state === 'completed') return { sessionId: cached.sessionId, reply: cached.reply! }
      if (cached?.state === 'pending') {
        const recovered = await recoverPending(sessionManager, target.sessionPointerPath, cached)
        if (recovered) return recovered
      }
    }

    const pending = key ? readDispatchRecord(target.sessionPointerPath, key) : null
    let sessionId = readSessionId(target.sessionPointerPath)
    if (sessionId && !(await sessionManager.getSession(sessionId))) sessionId = null
    if (!sessionId && pending?.state === 'pending' && await sessionManager.getSession(pending.sessionId)) {
      sessionId = pending.sessionId
      writeSessionId(target.sessionPointerPath, sessionId)
    }
    if (!sessionId) {
      const session = await sessionManager.createSession(target.workspaceId, { name: target.name, hidden: true, permissionMode: target.permissionMode, model: target.providerConfig.modelId, llmConnection: target.providerConfig.providerId })
      sessionId = session.id
      writeSessionId(target.sessionPointerPath, sessionId)
    }

    const before = await sessionManager.getSession(sessionId)
    const beforeAssistantCount = (before?.messages ?? []).filter((entry: { role?: string }) => entry.role === 'assistant').length
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
      const messages = (session?.messages ?? []) as Array<{ role?: string; content?: string; text?: string }>
      const assistantMessages = messages.filter(entry => entry.role === 'assistant')
      const processing = Boolean((session as { isProcessing?: boolean } | null)?.isProcessing)
      if (!processing && assistantMessages.length > beforeAssistantCount) {
        const reply = messageText(assistantMessages[assistantMessages.length - 1]!)
        if (reply) {
          if (key) writeDispatchRecord(target.sessionPointerPath, key, { sessionId, state: 'completed', reply })
          return { sessionId, reply }
        }
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    return { sessionId, reply: null }
  })
}
