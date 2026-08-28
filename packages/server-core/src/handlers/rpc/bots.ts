import { randomUUID } from 'node:crypto'
import { RPC_CHANNELS } from '@kata-sh/shared/protocol'
import { getWorkspaceByNameOrId } from '@kata-sh/shared/config'
import {
  BotDirectory,
  convertSessionToBot,
  createDirectChatJournal,
  toBotPublicDto,
  BotContextLedger,
  ContextAssembler,
  StaleCompactionError,
  botProviderSessionPath,
} from '@kata-sh/shared/bots'
import { BOT_MEMORY_LIMITS, type BotPermissionMode, type BotProviderConfig, type BotRecord, type JournalEntry } from '@kata-sh/core'
import { pushTyped, type RpcServer } from '@kata-sh/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { resetBotProviderSessions, sendToBotSession } from './bot-runtime'

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
  RPC_CHANNELS.bots.GET_MEMORY,
  RPC_CHANNELS.bots.GET_CONTEXT,
  RPC_CHANNELS.bots.MUTATE_MEMORY,
  RPC_CHANNELS.bots.SEND_MESSAGE,
  RPC_CHANNELS.bots.CONVERT_SESSION,
] as const

function requireWorkspace(ctx: { workspaceId: string | null }, workspaceId: string) {
  const workspace = getWorkspaceByNameOrId(workspaceId)
  if (!workspace) throw new Error('Workspace not found')
  if (ctx.workspaceId && ctx.workspaceId !== workspace.id) throw new Error('Workspace access denied')
  return workspace
}

function openStores(ctx: { workspaceId: string | null }, workspaceId: string) {
  const workspace = requireWorkspace(ctx, workspaceId)
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

function memoryFor(workspaceRoot: string, workspaceId: string, botId: string, journal: ReturnType<typeof createDirectChatJournal>) {
  const ledger = new BotContextLedger({ workspaceRoot, workspaceId, botId, journal })
  return { ledger, assembler: new ContextAssembler({ ledger, journal }) }
}

async function compactIfNeeded(ledger: BotContextLedger, assembler: ContextAssembler, conversationId: string): Promise<void> {
  const journalHead = ledger.journal.getHeadSequence(conversationId)
  if (journalHead < BOT_MEMORY_LIMITS.recentEntries * 2) return
  const checkpoint = ledger.getCheckpoint(conversationId)
  try {
    await assembler.compact({
      botId: ledger.store.botId,
      conversationId,
      expectedJournalHeadSequence: journalHead,
      expectedMemoryRevision: ledger.store.getHead().revision,
      expectedCheckpointRevision: checkpoint?.checkpointRevision ?? 0,
      operationId: `compact.${conversationId}.${journalHead}`,
    })
  } catch (error) {
    if (!(error instanceof StaleCompactionError)) throw error
    const latestHead = ledger.journal.getHeadSequence(conversationId)
    const latestCheckpoint = ledger.getCheckpoint(conversationId)
    await assembler.compact({
      botId: ledger.store.botId,
      conversationId,
      expectedJournalHeadSequence: latestHead,
      expectedMemoryRevision: ledger.store.getHead().revision,
      expectedCheckpointRevision: latestCheckpoint?.checkpointRevision ?? 0,
      operationId: `compact.retry.${conversationId}.${latestHead}`,
    })
  }
}

function publishDirectEvents(server: RpcServer, workspaceId: string, botId: string, chatId: string): void {
  pushTyped(server, RPC_CHANNELS.bots.EVENT, { to: 'workspace', workspaceId }, { type: 'journal-updated', botId, chatId })
  pushTyped(server, RPC_CHANNELS.bots.EVENT, { to: 'workspace', workspaceId }, { type: 'memory-updated', botId })
}

async function finishDirectReply(
  server: RpcServer,
  workspaceId: string,
  botId: string,
  bot: BotRecord,
  userEntry: JournalEntry,
  runtime: { reply: string | null },
  ledger: BotContextLedger,
  assembler: ContextAssembler,
  journal: ReturnType<typeof createDirectChatJournal>,
): Promise<JournalEntry | null> {
  if (!runtime.reply) return null
  const botEntry = journal.append({ conversationId: bot.directChatId, kind: 'bot', body: runtime.reply, idempotencyKey: `reply.${userEntry.entryId}` })
  try {
    await ledger.completeTurn({ userEntry, replyEntry: botEntry, operationId: `turn.${userEntry.entryId}` })
    await compactIfNeeded(ledger, assembler, bot.directChatId)
  } catch (error) {
    console.error('[Bots] Durable memory post-processing failed after reply commit', error)
  }
  publishDirectEvents(server, workspaceId, botId, bot.directChatId)
  return botEntry
}

export function registerBotsHandlers(server: RpcServer, deps: HandlerDeps): void {
  const { sessionManager } = deps

  server.handle(RPC_CHANNELS.bots.LIST, async (ctx, workspaceId: string, filter?: { lifecycle?: 'active' | 'hidden' | 'archived' | 'all' }) => {
    const { directory } = openStores(ctx, workspaceId)
    return directory.listBots(filter).map(toBotPublicDto)
  })

  server.handle(RPC_CHANNELS.bots.GET, async (ctx, workspaceId: string, botId: string) => {
    const { directory } = openStores(ctx, workspaceId)
    const bot = directory.getBot(botId)
    if (!bot) throw new Error('Bot not found')
    return toBotPublicDto(bot)
  })

  server.handle(
    RPC_CHANNELS.bots.CREATE,
    async (
      ctx,
      workspaceId: string,
      input: {
        name: string
        permissionMode: BotPermissionMode
        providerConfig: BotProviderConfig
        profile?: string
        idempotencyKey?: string
      },
    ) => {
      const { directory } = openStores(ctx, workspaceId)
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

  server.handle(RPC_CHANNELS.bots.RENAME, async (ctx, workspaceId: string, botId: string, name: string) => {
    const { directory } = openStores(ctx, workspaceId)
    return toBotPublicDto(directory.renameBot(botId, name))
  })

  server.handle(
    RPC_CHANNELS.bots.UPDATE,
    async (
      ctx,
      workspaceId: string,
      botId: string,
      patch: {
        name?: string
        profile?: string
        permissionMode?: BotPermissionMode
        providerConfig?: BotProviderConfig
      },
    ) => {
      const { directory } = openStores(ctx, workspaceId)
      return toBotPublicDto(directory.updateBot(botId, patch))
    },
  )

  server.handle(RPC_CHANNELS.bots.HIDE, async (ctx, workspaceId: string, botId: string) => {
    const { directory } = openStores(ctx, workspaceId)
    return toBotPublicDto(directory.hideBot(botId))
  })

  server.handle(RPC_CHANNELS.bots.ARCHIVE, async (ctx, workspaceId: string, botId: string) => {
    const { directory } = openStores(ctx, workspaceId)
    return toBotPublicDto(directory.archiveBot(botId))
  })

  server.handle(RPC_CHANNELS.bots.REOPEN, async (ctx, workspaceId: string, botId: string) => {
    const { directory } = openStores(ctx, workspaceId)
    return toBotPublicDto(directory.reopenBot(botId))
  })

  server.handle(
    RPC_CHANNELS.bots.GET_JOURNAL,
    async (ctx, workspaceId: string, botId: string, opts?: { afterSeq?: number; limit?: number }) => {
      const { directory, journal } = openStores(ctx, workspaceId)
      const bot = directory.getBot(botId)
      if (!bot) throw new Error('Bot not found')
      return {
        bot: toBotPublicDto(bot),
        entries: journal.list(bot.directChatId, opts),
        cursor: journal.getCursor(bot.directChatId),
      }
    },
  )

  server.handle(RPC_CHANNELS.bots.GET_MEMORY, async (ctx, workspaceId: string, botId: string) => {
    const { workspace, directory, journal } = openStores(ctx, workspaceId)
    const bot = directory.getBot(botId)
    if (!bot) throw new Error('Bot not found')
    const { ledger } = memoryFor(workspace.rootPath, workspaceId, bot.botId, journal)
    return ledger.store.getHead()
  })

  server.handle(RPC_CHANNELS.bots.GET_CONTEXT, async (ctx, workspaceId: string, botId: string) => {
    const { workspace, directory, journal } = openStores(ctx, workspaceId)
    const bot = directory.getBot(botId)
    if (!bot) throw new Error('Bot not found')
    const { assembler } = memoryFor(workspace.rootPath, workspaceId, bot.botId, journal)
    return assembler.assemble({ conversationId: bot.directChatId, operationId: `inspect.${randomUUID()}`, conversationKind: 'direct' })
  })

  server.handle(RPC_CHANNELS.bots.MUTATE_MEMORY, async (ctx, workspaceId: string, botId: string, mutation: import('@kata-sh/core').BotMemoryMutation) => {
    const { workspace, directory, journal } = openStores(ctx, workspaceId)
    const bot = directory.getBot(botId)
    if (!bot) throw new Error('Bot not found')
    const { ledger } = memoryFor(workspace.rootPath, workspaceId, bot.botId, journal)
    const head = await ledger.store.mutate(mutation)
    try {
      await resetBotProviderSessions(sessionManager, workspace.rootPath, bot.botId)
    } catch (error) {
      console.error('[Bots] Failed to reset hidden provider sessions after memory mutation', error)
    }
    pushTyped(server, RPC_CHANNELS.bots.EVENT, { to: 'workspace', workspaceId }, { type: 'memory-updated', botId: bot.botId })
    return head
  })

  server.handle(
    RPC_CHANNELS.bots.SEND_MESSAGE,
    async (
      ctx,
      workspaceId: string,
      botId: string,
      message: string,
      options?: { idempotencyKey?: string; waitForReply?: boolean },
    ) => {
      const { workspace, directory, journal } = openStores(ctx, workspaceId)
      const bot = directory.getBot(botId)
      if (!bot) throw new Error('Bot not found')
      const { ledger, assembler } = memoryFor(workspace.rootPath, workspaceId, bot.botId, journal)

      const idempotencyKey = options?.idempotencyKey ?? `send.${randomUUID()}`
      const userEntry = journal.append({
        conversationId: bot.directChatId,
        kind: 'user',
        body: message,
        idempotencyKey,
      })
      const operationId = `turn.${userEntry.entryId}`
      const prepared = assembler.assemble({ conversationId: bot.directChatId, operationId, currentEntryId: userEntry.entryId, conversationKind: 'direct' })
      await ledger.recordRun(prepared.context)

      await sessionManager.waitForInit()
      const dispatch = sendToBotSession(
        sessionManager,
        {
          workspaceId,
          name: bot.name,
          permissionMode: bot.permissionMode,
          providerConfig: bot.providerConfig,
          sessionPointerPath: botProviderSessionPath(workspace.rootPath, bot.botId),
        },
        message,
        {
          callerClientId: ctx.clientId,
          waitForReply: true,
          dispatchIdempotencyKey: operationId,
          botTurnContext: prepared.context,
        },
      )
      if (options?.waitForReply === false) {
        void dispatch.then(runtime => finishDirectReply(server, workspaceId, bot.botId, bot, userEntry, runtime, ledger, assembler, journal)).catch(error => {
          console.error('[Bots] Background Bot reply failed after accepted send', error)
        })
        publishDirectEvents(server, workspaceId, bot.botId, bot.directChatId)
        return { accepted: true as const, userEntry, botEntry: null, bot: toBotPublicDto(bot) }
      }
      const runtime = await dispatch
      const botEntry = await finishDirectReply(server, workspaceId, bot.botId, bot, userEntry, runtime, ledger, assembler, journal)
      if (!botEntry) publishDirectEvents(server, workspaceId, bot.botId, bot.directChatId)
      return { accepted: true as const, userEntry, botEntry, bot: toBotPublicDto(bot) }
    },
  )

  server.handle(
    RPC_CHANNELS.bots.CONVERT_SESSION,
    async (
      ctx,
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
      const { directory, journal } = openStores(ctx, workspaceId)
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
