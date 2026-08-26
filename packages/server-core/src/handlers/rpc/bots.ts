import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { RPC_CHANNELS } from '@kata-sh/shared/protocol'
import { getWorkspaceByNameOrId } from '@kata-sh/shared/config'
import {
  BotDirectory,
  convertSessionToBot,
  createDirectChatJournal,
  toBotPublicDto,
} from '@kata-sh/shared/bots'
import type { BotPermissionMode, BotProviderConfig, JournalEntry } from '@kata-sh/core'
import { pushTyped, type RpcServer } from '@kata-sh/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.bots.LIST,
  RPC_CHANNELS.bots.GET,
  RPC_CHANNELS.bots.CREATE,
  RPC_CHANNELS.bots.RENAME,
  RPC_CHANNELS.bots.UPDATE,
  RPC_CHANNELS.bots.HIDE,
  RPC_CHANNELS.bots.ARCHIVE,
  RPC_CHANNELS.bots.REOPEN,
  RPC_CHANNELS.bots.GET_JOURNAL,
  RPC_CHANNELS.bots.SEND_MESSAGE,
  RPC_CHANNELS.bots.CONVERT_SESSION,
] as const

function requireWorkspace(workspaceId: string) {
  const workspace = getWorkspaceByNameOrId(workspaceId)
  if (!workspace) throw new Error('Workspace not found')
  return workspace
}

function openStores(workspaceId: string) {
  const workspace = requireWorkspace(workspaceId)
  const directory = new BotDirectory({
    workspaceRoot: workspace.rootPath,
    workspaceId: workspace.id,
  })
  directory.recover()
  const journal = createDirectChatJournal({
    workspaceRoot: workspace.rootPath,
    workspaceId: workspace.id,
  })
  return { workspace, directory, journal }
}

function providerSessionPath(botsRoot: string, botId: string): string {
  return join(botsRoot, 'bots', botId, 'provider-session')
}

function readProviderSessionId(botsRoot: string, botId: string): string | null {
  const path = providerSessionPath(botsRoot, botId)
  if (!existsSync(path)) return null
  const value = readFileSync(path, 'utf8').trim()
  return value || null
}

function writeProviderSessionId(botsRoot: string, botId: string, sessionId: string): void {
  const path = providerSessionPath(botsRoot, botId)
  mkdirSync(dirname(path), { recursive: true })
  if (!existsSync(path)) {
    writeFileSync(path, `${sessionId}\n`, { flag: 'wx' })
    return
  }
  if (readFileSync(path, 'utf8').trim() !== sessionId) {
    writeFileSync(path, `${sessionId}\n`)
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

export function registerBotsHandlers(server: RpcServer, deps: HandlerDeps): void {
  const { sessionManager } = deps

  server.handle(RPC_CHANNELS.bots.LIST, async (_ctx, workspaceId: string, filter?: { lifecycle?: 'active' | 'hidden' | 'archived' | 'all' }) => {
    const { directory } = openStores(workspaceId)
    return directory.listBots(filter).map(toBotPublicDto)
  })

  server.handle(RPC_CHANNELS.bots.GET, async (_ctx, workspaceId: string, botId: string) => {
    const { directory } = openStores(workspaceId)
    const bot = directory.getBot(botId)
    if (!bot) throw new Error('Bot not found')
    return toBotPublicDto(bot)
  })

  server.handle(
    RPC_CHANNELS.bots.CREATE,
    async (
      _ctx,
      workspaceId: string,
      input: {
        name: string
        permissionMode: BotPermissionMode
        providerConfig: BotProviderConfig
        profile?: string
        idempotencyKey?: string
      },
    ) => {
      const { directory } = openStores(workspaceId)
      const bot = directory.createBot({
        name: input.name,
        permissionMode: input.permissionMode,
        providerConfig: input.providerConfig,
        profile: input.profile,
        idempotencyKey: input.idempotencyKey ?? `create.${randomUUID()}`,
      })
      pushTyped(server, RPC_CHANNELS.bots.EVENT, { to: 'workspace', workspaceId }, {
        type: 'bot-created',
        bot: toBotPublicDto(bot),
      })
      return toBotPublicDto(bot)
    },
  )

  server.handle(RPC_CHANNELS.bots.RENAME, async (_ctx, workspaceId: string, botId: string, name: string) => {
    const { directory } = openStores(workspaceId)
    return toBotPublicDto(directory.renameBot(botId, name))
  })

  server.handle(
    RPC_CHANNELS.bots.UPDATE,
    async (
      _ctx,
      workspaceId: string,
      botId: string,
      patch: {
        name?: string
        profile?: string
        permissionMode?: BotPermissionMode
        providerConfig?: BotProviderConfig
      },
    ) => {
      const { directory } = openStores(workspaceId)
      return toBotPublicDto(directory.updateBot(botId, patch))
    },
  )

  server.handle(RPC_CHANNELS.bots.HIDE, async (_ctx, workspaceId: string, botId: string) => {
    const { directory } = openStores(workspaceId)
    return toBotPublicDto(directory.hideBot(botId))
  })

  server.handle(RPC_CHANNELS.bots.ARCHIVE, async (_ctx, workspaceId: string, botId: string) => {
    const { directory } = openStores(workspaceId)
    return toBotPublicDto(directory.archiveBot(botId))
  })

  server.handle(RPC_CHANNELS.bots.REOPEN, async (_ctx, workspaceId: string, botId: string) => {
    const { directory } = openStores(workspaceId)
    return toBotPublicDto(directory.reopenBot(botId))
  })

  server.handle(
    RPC_CHANNELS.bots.GET_JOURNAL,
    async (_ctx, workspaceId: string, botId: string, opts?: { afterSeq?: number; limit?: number }) => {
      const { directory, journal } = openStores(workspaceId)
      const bot = directory.getBot(botId)
      if (!bot) throw new Error('Bot not found')
      return {
        bot: toBotPublicDto(bot),
        entries: journal.list(bot.directChatId, opts),
        cursor: journal.getCursor(bot.directChatId),
      }
    },
  )

  server.handle(
    RPC_CHANNELS.bots.SEND_MESSAGE,
    async (
      ctx,
      workspaceId: string,
      botId: string,
      message: string,
      options?: { idempotencyKey?: string; waitForReply?: boolean },
    ) => {
      const { directory, journal } = openStores(workspaceId)
      const bot = directory.getBot(botId)
      if (!bot) throw new Error('Bot not found')

      const idempotencyKey = options?.idempotencyKey ?? `send.${randomUUID()}`
      const userEntry = journal.append({
        conversationId: bot.directChatId,
        kind: 'user',
        body: message,
        idempotencyKey,
      })

      await sessionManager.waitForInit()
      let sessionId = readProviderSessionId(directory.rootPath, bot.botId)
      if (!sessionId) {
        const session = await sessionManager.createSession(workspaceId, {
          name: bot.name,
          hidden: true,
          permissionMode: bot.permissionMode,
          model: bot.providerConfig.modelId,
          llmConnection: bot.providerConfig.providerId,
        })
        sessionId = session.id
        writeProviderSessionId(directory.rootPath, bot.botId, sessionId)
      }

      const callerClientId = ctx.clientId
      await new Promise<{ accepted: true; messageId: string }>((resolve, reject) => {
        let acked = false
        const onAck = (messageId: string) => {
          if (!acked) {
            acked = true
            resolve({ accepted: true, messageId })
          }
        }
        sessionManager
          .sendMessage(sessionId!, message, undefined, undefined, undefined, undefined, undefined, onAck, {
            callerClientId,
          })
          .then(() => {
            if (!acked) {
              acked = true
              reject(new Error('sendMessage completed without persisting a user message'))
            }
          })
          .catch((error) => {
            if (!acked) {
              acked = true
              reject(error)
            }
          })
      })

      let botEntry: JournalEntry | undefined
      if (options?.waitForReply !== false) {
        const deadline = Date.now() + 120_000
        while (Date.now() < deadline) {
          const session = await sessionManager.getSession(sessionId)
          const processing = Boolean((session as { isProcessing?: boolean } | null)?.isProcessing)
          const messages = (session as { messages?: Array<{ role: string; content?: string; text?: string }> } | null)?.messages ?? []
          const lastAssistant = [...messages].reverse().find((entry) => entry.role === 'assistant')
          if (!processing && lastAssistant) {
            const body = lastAssistant.content ?? lastAssistant.text ?? ''
            if (body) {
              botEntry = journal.append({
                conversationId: bot.directChatId,
                kind: 'bot',
                body,
                idempotencyKey: `reply.${userEntry.entryId}`,
              })
              break
            }
          }
          await sleep(500)
        }
      }

      pushTyped(server, RPC_CHANNELS.bots.EVENT, { to: 'workspace', workspaceId }, {
        type: 'journal-updated',
        botId: bot.botId,
        chatId: bot.directChatId,
      })

      return {
        accepted: true as const,
        userEntry,
        botEntry: botEntry ?? null,
        bot: toBotPublicDto(bot),
      }
    },
  )

  server.handle(
    RPC_CHANNELS.bots.CONVERT_SESSION,
    async (
      _ctx,
      workspaceId: string,
      input: {
        sessionId: string
        idempotencyKey?: string
        name: string
        permissionMode: BotPermissionMode
        providerConfig: BotProviderConfig
        profile?: string
      },
    ) => {
      const { directory, journal } = openStores(workspaceId)
      await sessionManager.waitForInit()
      const session = await sessionManager.getSession(input.sessionId)
      if (!session) throw new Error('Session not found')
      if (session.workspaceId && session.workspaceId !== workspaceId) {
        throw new Error('Session belongs to another workspace')
      }

      const messages = (session.messages ?? [])
        .filter((entry: { role?: string }) => entry.role === 'user' || entry.role === 'assistant')
        .map((entry: { role: string; content?: string; text?: string; createdAt?: string | number }) => ({
          role: entry.role,
          text: entry.content ?? entry.text ?? '',
          createdAt:
            typeof entry.createdAt === 'string'
              ? entry.createdAt
              : new Date(entry.createdAt ?? Date.now()).toISOString().replace(/\.\d{3}Z$/, '.000Z'),
        }))

      const result = convertSessionToBot(directory, journal, {
        sessionId: input.sessionId,
        idempotencyKey: input.idempotencyKey ?? `convert.${input.sessionId}`,
        name: input.name,
        permissionMode: input.permissionMode,
        providerConfig: input.providerConfig,
        profile: input.profile,
        messages,
      })

      return {
        bot: toBotPublicDto(result.bot),
        chatId: result.chatId,
        entries: result.entries,
        disposition: result.disposition,
      }
    },
  )
}
