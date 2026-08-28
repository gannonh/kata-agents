import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
  const current = new Promise<void>((resolve) => { release = resolve })
  const queued = prior.then(() => current)
  sessionQueues.set(key, queued)
  await prior
  try {
    return await task()
  } finally {
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

function messageText(message: { content?: string; text?: string }): string {
  return message.content ?? message.text ?? ''
}

function dispatchResultPath(sessionPointerPath: string, dispatchIdempotencyKey: string): string {
  const digest = createHash('sha256').update(dispatchIdempotencyKey, 'utf8').digest('hex')
  return join(dirname(sessionPointerPath), 'provider-dispatches', `${digest}.json`)
}

function readDispatchResult(
  sessionPointerPath: string,
  dispatchIdempotencyKey: string,
): { sessionId: string; reply: string } | null {
  const path = dispatchResultPath(sessionPointerPath, dispatchIdempotencyKey)
  if (!existsSync(path)) return null
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as {
      dispatchIdempotencyKey?: unknown
      sessionId?: unknown
      reply?: unknown
    }
    if (record.dispatchIdempotencyKey !== dispatchIdempotencyKey) return null
    if (typeof record.sessionId !== 'string' || !record.sessionId) return null
    if (typeof record.reply !== 'string') return null
    return { sessionId: record.sessionId, reply: record.reply }
  } catch {
    return null
  }
}

function writeDispatchResult(
  sessionPointerPath: string,
  dispatchIdempotencyKey: string,
  result: { sessionId: string; reply: string },
): void {
  const path = dispatchResultPath(sessionPointerPath, dispatchIdempotencyKey)
  const directory = dirname(path)
  ensureDurableDirectory(directory)
  const payload = `${JSON.stringify({
    schemaVersion: 1,
    dispatchIdempotencyKey,
    sessionId: result.sessionId,
    reply: result.reply,
  }, null, 2)}\n`
  if (writeDurableFileIfAbsent(path, payload)) {
    syncDirectory(directory)
    return
  }
  const existing = readDispatchResult(sessionPointerPath, dispatchIdempotencyKey)
  if (!existing || existing.sessionId !== result.sessionId || existing.reply !== result.reply) {
    writeDurableFile(path, payload)
    syncDirectory(directory)
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
  },
): Promise<{ sessionId: string; reply: string | null }> {
  return withSessionQueue(target.sessionPointerPath, async () => {
    if (options.dispatchIdempotencyKey) {
      const cached = readDispatchResult(target.sessionPointerPath, options.dispatchIdempotencyKey)
      if (cached) return { sessionId: cached.sessionId, reply: cached.reply }
    }

    let sessionId = readSessionId(target.sessionPointerPath)
    if (sessionId && !(await sessionManager.getSession(sessionId))) sessionId = null
    if (!sessionId) {
      const session = await sessionManager.createSession(target.workspaceId, {
        name: target.name,
        hidden: true,
        permissionMode: target.permissionMode,
        model: target.providerConfig.modelId,
        llmConnection: target.providerConfig.providerId,
      })
      sessionId = session.id
      writeSessionId(target.sessionPointerPath, sessionId)
    }

    const before = await sessionManager.getSession(sessionId)
    const beforeAssistantCount = (before?.messages ?? []).filter((entry) => entry.role === 'assistant').length
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const onAck = (messageId: string) => {
        void messageId
        if (!settled) {
          settled = true
          resolve()
        }
      }
      sessionManager.sendMessage(
        sessionId!,
        message,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        onAck,
        options.callerClientId || options.botTurnContext
          ? { callerClientId: options.callerClientId, botTurnContext: options.botTurnContext }
          : undefined,
      ).then(() => {
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
      const messages = session?.messages ?? []
      const assistantMessages = messages.filter((entry) => entry.role === 'assistant')
      const processing = Boolean((session as { isProcessing?: boolean } | null)?.isProcessing)
      if (!processing && assistantMessages.length > beforeAssistantCount) {
        const reply = messageText(assistantMessages[assistantMessages.length - 1]!)
        if (reply) {
          if (options.dispatchIdempotencyKey) {
            writeDispatchResult(target.sessionPointerPath, options.dispatchIdempotencyKey, { sessionId, reply })
          }
          return { sessionId, reply }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return { sessionId, reply: null }
  })
}
