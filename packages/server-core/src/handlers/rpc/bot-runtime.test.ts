import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import type { BotTurnContext, ToolInvocation } from '@kata-sh/core'
import type { HandlerDeps } from '../handler-deps'
import { resetBotProviderSessions, sendToBotSession } from './bot-runtime'
import { botProviderSessionPath } from '@kata-sh/shared/bots'
import { channelProviderSessionPath } from '@kata-sh/shared/channels'
import { respondToPermissionOnce } from '../../routines/bot-routine-executor'

function makeSessionManager() {
  const sessions = new Map<string, { id: string; workspaceId: string; hidden?: boolean; model?: string; llmConnection?: string; messages: Array<{ id?: string; role: string; content: string }> }>()
  const calls: string[] = []
  const rpcContexts: unknown[] = []
  let created = 0
  let messageCount = 0

  const manager = {
    async createSession(workspaceId: string, options: { name?: string; hidden?: boolean; model?: string; llmConnection?: string }) {
      const id = `session-${++created}`
      const session = { id, workspaceId, hidden: options.hidden, model: options.model, llmConnection: options.llmConnection, messages: [] }
      sessions.set(id, session)
      return session
    },
    async getSession(sessionId: string) {
      return sessions.get(sessionId) ?? null
    },
    async deleteSession(sessionId: string) {
      sessions.delete(sessionId)
      return { deleted: true }
    },
    async sendMessage(
      sessionId: string,
      message: string,
      ...args: unknown[]
    ) {
      const session = sessions.get(sessionId)
      if (!session) throw new Error('session not found')
      rpcContexts.push(args[6])
      calls.push(sessionId)
      const existingMessageId = args[3] as string | undefined
      if (existingMessageId) {
        session.messages.push({ role: 'assistant', content: `reply: ${message}` })
        const onAck = args[5]
        if (typeof onAck === 'function') (onAck as (messageId: string) => void)(existingMessageId)
        return
      }
      const messageId = `message-${++messageCount}`
      session.messages.push({ id: messageId, role: 'user', content: message })
      session.messages.push({ role: 'assistant', content: `reply: ${message}` })
      const onAck = args[5]
      if (typeof onAck === 'function') (onAck as (messageId: string) => void)(messageId)
    },
  }

  return { manager, sessions, calls, rpcContexts, get created() { return created } }
}

const target = {
  workspaceId: 'workspace-one',
  botId: 'bot-one',
  name: 'Research Bot',
  permissionMode: 'ask' as const,
  providerConfig: { providerId: 'openai-codex', modelId: 'gpt-5-codex' },
}

describe('sendToBotSession', () => {
  it('persists permission delivery so duplicate approval recovery sends one response', () => {
    const root = mkdtempSync(join(tmpdir(), 'kata-bot-runtime-approval-response-'))
    let responses = 0
    const manager = {
      respondToPermission() {
        responses += 1
        return true
      },
    }

    expect(respondToPermissionOnce(manager as unknown as HandlerDeps['sessionManager'], root, 'approval-one', 'session-one', 'request-one', true)).toBe(true)
    expect(respondToPermissionOnce(manager as unknown as HandlerDeps['sessionManager'], root, 'approval-one', 'session-one', 'request-one', true)).toBe(true)
    expect(respondToPermissionOnce(manager as unknown as HandlerDeps['sessionManager'], root, 'approval-one', 'session-one', 'request-two', true)).toBe(true)
    expect(responses).toBe(2)
  })

  it('does not replay a permission response when its durable marker is malformed', () => {
    const root = mkdtempSync(join(tmpdir(), 'kata-bot-runtime-approval-marker-'))
    const approvalId = 'approval-one'
    const sessionId = 'session-one'
    const requestId = 'request-one'
    const markerDirectory = join(root, '.routines', 'approval-responses')
    mkdirSync(markerDirectory, { recursive: true })
    const markerKey = createHash('sha256').update(JSON.stringify([approvalId, requestId, true]), 'utf8').digest('hex')
    writeFileSync(join(markerDirectory, `${markerKey}.json`), '{}')
    let responses = 0
    const manager = { respondToPermission: () => { responses += 1; return true } }

    expect(() => respondToPermissionOnce(
      manager as unknown as HandlerDeps['sessionManager'],
      root,
      approvalId,
      sessionId,
      requestId,
      true,
    )).toThrow('outcome is uncertain')
    expect(responses).toBe(0)
  })

  it('forwards Bot routine identity and context to SessionManager', async () => {
    const fixture = makeSessionManager()
    const root = mkdtempSync(join(tmpdir(), 'kata-bot-runtime-context-'))
    const context = {
      workspaceId: target.workspaceId,
      botId: target.botId,
      conversationId: 'chat-one',
      runId: 'run-one',
      operationId: 'routine.run-one',
      journalCursor: 0,
      conversationCursor: 0,
      memoryRevision: 0,
      checkpointRevision: 0,
      text: 'routine prompt',
      memoryIds: [],
    }
    const result = await sendToBotSession(
      fixture.manager as unknown as HandlerDeps['sessionManager'],
      { ...target, sessionPointerPath: join(root, 'provider-session') },
      'routine prompt',
      {
        waitForReply: true,
        botTurnContext: context,
        botRoutineRunId: 'run-one',
        botAttempt: 3,
        stopOnPendingApproval: true,
      },
    )

    expect(result.reply).toBe('reply: routine prompt')
    expect(fixture.rpcContexts[0]).toMatchObject({
      botTurnContext: context,
      botRoutineRunId: 'run-one',
      botPermissionMode: 'ask',
      botAttempt: 3,
    })
  })

  it('preserves a dispatch whose provider outcome is unknown after user-message persistence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kata-bot-runtime-starting-'))
    const sessionPointerPath = botProviderSessionPath(root, 'bot-one')
    const sessions = new Map<string, { id: string; workspaceId: string; hidden: true; model: string; llmConnection: string; messages: Array<{ id?: string; role: string; content: string; idempotencyKey?: string }>; isProcessing?: boolean }>()
    let sends = 0
    const manager = {
      async createSession(workspaceId: string, options: { model?: string; llmConnection?: string }) {
        const session = { id: 'session-1', workspaceId, hidden: true as const, model: options.model!, llmConnection: options.llmConnection!, messages: [] }
        sessions.set(session.id, session)
        return session
      },
      async getSession(sessionId: string) { return sessions.get(sessionId) ?? null },
      async sendMessage(sessionId: string, message: string, ...args: unknown[]) {
        const session = sessions.get(sessionId)!
        sends += 1
        const existingMessageId = args[3] as string | undefined
        const rpcContext = args[6] as { botDispatchIdempotencyKey?: string } | undefined
        if (existingMessageId) {
          session.messages.push({ role: 'assistant', content: `reply: ${message}` })
          ;(args[5] as (messageId: string) => void)(existingMessageId)
          return
        }
        const messageId = 'message-1'
        session.messages.push({ id: messageId, role: 'user', content: message, idempotencyKey: rpcContext?.botDispatchIdempotencyKey })
        if (sends === 1) throw new Error('simulated crash after message persistence')
        session.messages.push({ role: 'assistant', content: `reply: ${message}` })
        ;(args[5] as (messageId: string) => void)(messageId)
      },
    }

    await expect(sendToBotSession(
      manager as unknown as HandlerDeps['sessionManager'],
      { ...target, sessionPointerPath },
      'recover me',
      { waitForReply: true, dispatchIdempotencyKey: 'dispatch.starting' },
    )).rejects.toThrow('simulated crash')

    await expect(sendToBotSession(
      manager as unknown as HandlerDeps['sessionManager'],
      { ...target, sessionPointerPath },
      'recover me',
      { waitForReply: true, dispatchIdempotencyKey: 'dispatch.starting' },
    )).rejects.toThrow('uncertain')

    expect(sends).toBe(1)
    expect(sessions.get('session-1')?.messages.filter(message => message.role === 'user')).toHaveLength(1)
  })

  it('creates one durable hidden session per pointer and serializes concurrent sends', async () => {
    const fixture = makeSessionManager()
    const root = mkdtempSync(join(tmpdir(), 'kata-bot-runtime-'))
    const sessionPointerPath = join(root, 'channels', 'channel-one', 'members', 'bot-one', 'provider-session')
    const completeTarget = { ...target, sessionPointerPath }

    const [first, second] = await Promise.all([
      sendToBotSession(fixture.manager as unknown as HandlerDeps['sessionManager'], completeTarget, 'first', { waitForReply: true }),
      sendToBotSession(fixture.manager as unknown as HandlerDeps['sessionManager'], completeTarget, 'second', { waitForReply: true }),
    ])

    expect(first.sessionId).toBe('session-1')
    expect(second.sessionId).toBe('session-1')
    expect(first.reply).toBe('reply: first')
    expect(second.reply).toBe('reply: second')
    expect(fixture.created).toBe(1)
    expect(fixture.calls).toEqual(['session-1', 'session-1'])
    expect(readFileSync(sessionPointerPath, 'utf8')).toBe('session-1\n')
  })

  it('resets only hidden Bot provider sessions across DirectChat and Channels', async () => {
    const fixture = makeSessionManager()
    const root = mkdtempSync(join(tmpdir(), 'kata-bot-runtime-reset-'))
    const direct = botProviderSessionPath(root, 'bot-one')
    const channel = channelProviderSessionPath(root, 'channel-one', 'bot-one')
    const publicPointer = join(root, 'channels', 'channel-two', 'members', 'bot-one', 'provider-session')
    const foreignPointer = join(root, 'channels', 'channel-three', 'members', 'bot-one', 'provider-session')
    const pointers = [direct, channel, publicPointer, foreignPointer]
    for (const pointer of pointers) {
      mkdirSync(join(pointer, '..'), { recursive: true })
    }
    fixture.sessions.set('hidden-direct', { id: 'hidden-direct', workspaceId: target.workspaceId, hidden: true, model: target.providerConfig.modelId, llmConnection: target.providerConfig.providerId, messages: [] })
    fixture.sessions.set('hidden-channel', { id: 'hidden-channel', workspaceId: target.workspaceId, hidden: true, model: target.providerConfig.modelId, llmConnection: target.providerConfig.providerId, messages: [] })
    fixture.sessions.set('public', { id: 'public', workspaceId: target.workspaceId, hidden: false, model: target.providerConfig.modelId, llmConnection: target.providerConfig.providerId, messages: [] })
    fixture.sessions.set('foreign-hidden', { id: 'foreign-hidden', workspaceId: 'workspace-two', hidden: true, model: target.providerConfig.modelId, llmConnection: target.providerConfig.providerId, messages: [] })
    writeFileSync(direct, 'hidden-direct\n')
    writeFileSync(channel, 'hidden-channel\n')
    writeFileSync(publicPointer, 'public\n')
    writeFileSync(foreignPointer, 'foreign-hidden\n')
    await resetBotProviderSessions(fixture.manager as unknown as HandlerDeps['sessionManager'], root, target.workspaceId, 'bot-one')
    expect(fixture.sessions.has('hidden-direct')).toBe(false)
    expect(fixture.sessions.has('hidden-channel')).toBe(false)
    expect(fixture.sessions.has('public')).toBe(true)
    expect(fixture.sessions.has('foreign-hidden')).toBe(true)
    expect(existsSync(publicPointer)).toBe(true)
    expect(existsSync(foreignPointer)).toBe(true)
  })

  it('does not reuse a public or foreign-workspace provider session pointer', async () => {
    const fixture = makeSessionManager()
    const root = mkdtempSync(join(tmpdir(), 'kata-bot-runtime-identity-'))
    const sessionPointerPath = botProviderSessionPath(root, 'bot-one')
    mkdirSync(join(sessionPointerPath, '..'), { recursive: true })
    fixture.sessions.set('public', { id: 'public', workspaceId: target.workspaceId, hidden: false, messages: [] })
    writeFileSync(sessionPointerPath, 'public\n')

    const result = await sendToBotSession(
      fixture.manager as unknown as HandlerDeps['sessionManager'],
      { ...target, sessionPointerPath },
      'hello',
      { waitForReply: true, dispatchIdempotencyKey: 'identity.public' },
    )

    expect(result.sessionId).toBe('session-1')
    expect(fixture.sessions.get('public')).toBeDefined()
    expect(fixture.calls).toEqual(['session-1'])

    const foreignRoot = mkdtempSync(join(tmpdir(), 'kata-bot-runtime-foreign-'))
    const foreignPointer = botProviderSessionPath(foreignRoot, 'bot-one')
    mkdirSync(join(foreignPointer, '..'), { recursive: true })
    fixture.sessions.set('foreign', { id: 'foreign', workspaceId: 'workspace-two', hidden: true, model: target.providerConfig.modelId, llmConnection: target.providerConfig.providerId, messages: [] })
    writeFileSync(foreignPointer, 'foreign\n')
    const foreignResult = await sendToBotSession(
      fixture.manager as unknown as HandlerDeps['sessionManager'],
      { ...target, sessionPointerPath: foreignPointer },
      'again',
      { waitForReply: true, dispatchIdempotencyKey: 'identity.foreign' },
    )

    expect(foreignResult.sessionId).toBe('session-2')
    expect(fixture.sessions.get('foreign')).toBeDefined()
    expect(fixture.calls).toEqual(['session-1', 'session-2'])
  })

  it('recovers a pending dispatch from the hidden provider transcript', async () => {
    const fixture = makeSessionManager()
    const root = mkdtempSync(join(tmpdir(), 'kata-bot-runtime-pending-'))
    const sessionPointerPath = join(root, 'channels', 'channel-one', 'members', 'bot-one', 'provider-session')
    mkdirSync(join(root, 'channels', 'channel-one', 'members', 'bot-one'), { recursive: true })
    writeFileSync(sessionPointerPath, 'session-1\n')
    fixture.sessions.set('session-1', {
      id: 'session-1',
      workspaceId: target.workspaceId,
      hidden: true,
      model: target.providerConfig.modelId,
      llmConnection: target.providerConfig.providerId,
      messages: [
        { id: 'user-one', role: 'user', content: 'hello' },
        { role: 'assistant', content: 'recovered reply' },
      ],
    })
    const key = 'dispatch.pending'
    const dispatchDir = join(root, 'channels', 'channel-one', 'members', 'bot-one', 'provider-dispatches')
    mkdirSync(dispatchDir, { recursive: true })
    const hash = createHash('sha256').update(key).digest('hex')
    writeFileSync(join(dispatchDir, `${hash}.json`), JSON.stringify({ schemaVersion: 1, dispatchIdempotencyKey: key, sessionId: 'session-1', state: 'pending', userMessageId: 'user-one' }))
    const result = await sendToBotSession(fixture.manager as unknown as HandlerDeps['sessionManager'], { ...target, sessionPointerPath }, 'hello', { waitForReply: true, dispatchIdempotencyKey: key })
    expect(result.reply).toBe('recovered reply')
    expect(fixture.calls).toEqual([])
  })

  it('resumes an approved idle routine dispatch through the existing user message', async () => {
    const fixture = makeSessionManager()
    const root = mkdtempSync(join(tmpdir(), 'kata-bot-runtime-routine-restart-'))
    const sessionPointerPath = join(root, 'channels', 'channel-one', 'members', 'bot-one', 'provider-session')
    mkdirSync(join(root, 'channels', 'channel-one', 'members', 'bot-one'), { recursive: true })
    writeFileSync(sessionPointerPath, 'session-1\n')
    fixture.sessions.set('session-1', {
      id: 'session-1',
      workspaceId: target.workspaceId,
      hidden: true,
      model: target.providerConfig.modelId,
      llmConnection: target.providerConfig.providerId,
      messages: [{ id: 'user-one', role: 'user', content: 'approved work' }],
    })
    const key = 'dispatch.routine-restart'
    const dispatchDir = join(root, 'channels', 'channel-one', 'members', 'bot-one', 'provider-dispatches')
    mkdirSync(dispatchDir, { recursive: true })
    const hash = createHash('sha256').update(key).digest('hex')
    writeFileSync(join(dispatchDir, `${hash}.json`), JSON.stringify({ schemaVersion: 1, dispatchIdempotencyKey: key, sessionId: 'session-1', state: 'pending', userMessageId: 'user-one' }))
    const botTurnContext: BotTurnContext = {
      runId: 'run-restart',
      operationId: 'routine.run-restart',
      workspaceId: target.workspaceId,
      botId: target.botId,
      conversationId: 'channel-one',
      journalCursor: 0,
      conversationCursor: 0,
      memoryRevision: 0,
      checkpointRevision: 0,
      text: 'approved work',
      memoryIds: [],
    }

    const result = await sendToBotSession(
      fixture.manager as unknown as HandlerDeps['sessionManager'],
      { ...target, sessionPointerPath },
      'approved work',
      {
        waitForReply: true,
        dispatchIdempotencyKey: key,
        botTurnContext,
        botRoutineRunId: 'run-restart',
        botAttempt: 2,
      },
    )

    expect(result.reply).toBe('reply: approved work')
    expect(fixture.calls).toEqual(['session-1'])
  })

  it('preserves an approved idle dispatch when the provider reply is missing', async () => {
    const fixture = makeSessionManager()
    const root = mkdtempSync(join(tmpdir(), 'kata-bot-runtime-approved-restart-'))
    const sessionPointerPath = join(root, 'channels', 'channel-one', 'members', 'bot-one', 'provider-session')
    mkdirSync(join(root, 'channels', 'channel-one', 'members', 'bot-one'), { recursive: true })
    writeFileSync(sessionPointerPath, 'session-1\n')
    fixture.sessions.set('session-1', {
      id: 'session-1',
      workspaceId: target.workspaceId,
      hidden: true,
      model: target.providerConfig.modelId,
      llmConnection: target.providerConfig.providerId,
      messages: [{ id: 'user-one', role: 'user', content: 'approved work' }],
    })
    const key = 'dispatch.approved-restart'
    const dispatchDir = join(root, 'channels', 'channel-one', 'members', 'bot-one', 'provider-dispatches')
    mkdirSync(dispatchDir, { recursive: true })
    const hash = createHash('sha256').update(key).digest('hex')
    const dispatchPath = join(dispatchDir, `${hash}.json`)
    writeFileSync(dispatchPath, JSON.stringify({ schemaVersion: 1, dispatchIdempotencyKey: key, sessionId: 'session-1', state: 'pending', userMessageId: 'user-one' }))
    const approvalInvocation = {} as ToolInvocation

    await expect(sendToBotSession(
      fixture.manager as unknown as HandlerDeps['sessionManager'],
      { ...target, sessionPointerPath, approvalInvocation },
      'approved work',
      { waitForReply: true, dispatchIdempotencyKey: key, stopOnPendingApproval: true },
    )).rejects.toThrow('uncertain')

    expect(fixture.calls).toEqual([])
    expect(JSON.parse(readFileSync(dispatchPath, 'utf8')).state).toBe('pending')
  })

  it('does not recover an assistant reply from a later provider turn', async () => {
    const fixture = makeSessionManager()
    const root = mkdtempSync(join(tmpdir(), 'kata-bot-runtime-interleaved-'))
    const sessionPointerPath = join(root, 'channels', 'channel-one', 'members', 'bot-one', 'provider-session')
    mkdirSync(join(root, 'channels', 'channel-one', 'members', 'bot-one'), { recursive: true })
    writeFileSync(sessionPointerPath, 'session-1\n')
    fixture.sessions.set('session-1', {
      id: 'session-1',
      workspaceId: target.workspaceId,
      hidden: true,
      model: target.providerConfig.modelId,
      llmConnection: target.providerConfig.providerId,
      messages: [
        { id: 'user-one', role: 'user', content: 'old' },
        { id: 'user-two', role: 'user', content: 'later' },
        { role: 'assistant', content: 'later reply' },
      ],
    })
    const key = 'dispatch.interleaved'
    const dispatchDir = join(root, 'channels', 'channel-one', 'members', 'bot-one', 'provider-dispatches')
    mkdirSync(dispatchDir, { recursive: true })
    const hash = createHash('sha256').update(key).digest('hex')
    writeFileSync(join(dispatchDir, `${hash}.json`), JSON.stringify({ schemaVersion: 1, dispatchIdempotencyKey: key, sessionId: 'session-1', state: 'pending', userMessageId: 'user-one' }))

    await expect(sendToBotSession(
      fixture.manager as unknown as HandlerDeps['sessionManager'],
      { ...target, sessionPointerPath },
      'old',
      { waitForReply: true, dispatchIdempotencyKey: key },
    )).rejects.toThrow('uncertain')

    expect(fixture.calls).toEqual([])
  })

  it('rejects a pending dispatch when its user message changed', async () => {
    const existingMessageIds: Array<string | undefined> = []
    const sessions = new Map<string, { id: string; workspaceId: string; hidden?: boolean; model?: string; llmConnection?: string; messages: Array<{ id?: string; role: string; content: string }>; isProcessing?: boolean }>()
    let created = 0
    let messageCount = 0
    const manager = {
      async createSession(workspaceId: string, options: { name?: string; hidden?: boolean; model?: string; llmConnection?: string }) {
        const id = `session-${++created}`
        const session = { id, workspaceId, hidden: options.hidden, model: options.model, llmConnection: options.llmConnection, messages: [] as Array<{ id?: string; role: string; content: string }> }
        sessions.set(id, session)
        return session
      },
      async getSession(sessionId: string) {
        return sessions.get(sessionId) ?? null
      },
      async deleteSession(sessionId: string) {
        sessions.delete(sessionId)
        return { deleted: true }
      },
      async sendMessage(sessionId: string, message: string, ...args: unknown[]) {
        const session = sessions.get(sessionId)
        if (!session) throw new Error('session not found')
        const existingMessageId = args[3] as string | undefined
        existingMessageIds.push(existingMessageId)
        if (existingMessageId) {
          // Simulate SessionManager retrying the old turn: do not append a new user message.
          const onAck = args[5]
          if (typeof onAck === 'function') (onAck as (messageId: string) => void)(existingMessageId)
          return
        }
        const messageId = `message-${++messageCount}`
        session.messages.push({ id: messageId, role: 'user', content: message })
        session.messages.push({ role: 'assistant', content: `reply: ${message}` })
        const onAck = args[5]
        if (typeof onAck === 'function') (onAck as (messageId: string) => void)(messageId)
      },
    }

    const root = mkdtempSync(join(tmpdir(), 'kata-bot-runtime-stale-pending-'))
    const sessionPointerPath = join(root, 'channels', 'channel-one', 'members', 'bot-one', 'provider-session')
    mkdirSync(join(root, 'channels', 'channel-one', 'members', 'bot-one'), { recursive: true })
    writeFileSync(sessionPointerPath, 'session-1\n')
    sessions.set('session-1', {
      id: 'session-1',
      workspaceId: target.workspaceId,
      hidden: true,
      model: target.providerConfig.modelId,
      llmConnection: target.providerConfig.providerId,
      messages: [
        { id: 'user-old', role: 'user', content: 'old turn' },
      ],
    })
    const key = 'dispatch.stale-pending'
    const dispatchDir = join(root, 'channels', 'channel-one', 'members', 'bot-one', 'provider-dispatches')
    mkdirSync(dispatchDir, { recursive: true })
    const hash = createHash('sha256').update(key).digest('hex')
    const dispatchPath = join(dispatchDir, `${hash}.json`)
    writeFileSync(dispatchPath, JSON.stringify({ schemaVersion: 1, dispatchIdempotencyKey: key, sessionId: 'session-1', state: 'pending', userMessageId: 'user-old' }))

    await expect(sendToBotSession(
      manager as unknown as HandlerDeps['sessionManager'],
      { ...target, sessionPointerPath },
      'new turn',
      { waitForReply: true, dispatchIdempotencyKey: key },
    )).rejects.toThrow('message changed')
    expect(existingMessageIds).toEqual([])
    expect(JSON.parse(readFileSync(dispatchPath, 'utf8')).userMessageId).toBe('user-old')
    expect(JSON.parse(readFileSync(dispatchPath, 'utf8')).state).toBe('pending')
    expect(sessions.get('session-1')?.messages.filter(message => message.role === 'user')).toHaveLength(1)
  })

  it('preserves an unresolved routine dispatch instead of replaying an idle provider turn', async () => {
    const fixture = makeSessionManager()
    const root = mkdtempSync(join(tmpdir(), 'kata-bot-runtime-uncertain-'))
    const sessionPointerPath = join(root, 'channels', 'channel-one', 'members', 'bot-one', 'provider-session')
    mkdirSync(join(root, 'channels', 'channel-one', 'members', 'bot-one'), { recursive: true })
    writeFileSync(sessionPointerPath, 'session-1\n')
    fixture.sessions.set('session-1', {
      id: 'session-1',
      workspaceId: target.workspaceId,
      hidden: true,
      model: target.providerConfig.modelId,
      llmConnection: target.providerConfig.providerId,
      messages: [{ id: 'user-one', role: 'user', content: 'mutate' }],
    })
    const key = 'dispatch.uncertain'
    const dispatchDir = join(root, 'channels', 'channel-one', 'members', 'bot-one', 'provider-dispatches')
    mkdirSync(dispatchDir, { recursive: true })
    const hash = createHash('sha256').update(key).digest('hex')
    const dispatchPath = join(dispatchDir, `${hash}.json`)
    writeFileSync(dispatchPath, JSON.stringify({ schemaVersion: 1, dispatchIdempotencyKey: key, sessionId: 'session-1', state: 'pending', userMessageId: 'user-one' }))

    await expect(sendToBotSession(
      fixture.manager as unknown as HandlerDeps['sessionManager'],
      { ...target, sessionPointerPath },
      'mutate',
      { waitForReply: true, dispatchIdempotencyKey: key, stopOnPendingApproval: true },
    )).rejects.toThrow('uncertain')
    expect(fixture.calls).toEqual([])
    expect(JSON.parse(readFileSync(dispatchPath, 'utf8')).state).toBe('pending')
  })

  it('clears provider dispatch records when the pointed session lookup fails', async () => {
    const fixture = makeSessionManager()
    const root = mkdtempSync(join(tmpdir(), 'kata-bot-runtime-reset-lookup-fail-'))
    const sessionPointerPath = botProviderSessionPath(root, 'bot-one')
    mkdirSync(join(sessionPointerPath, '..'), { recursive: true })
    writeFileSync(sessionPointerPath, 'missing-session\n')
    const dispatchDir = join(sessionPointerPath, '..', 'provider-dispatches')
    mkdirSync(dispatchDir, { recursive: true })
    writeFileSync(join(dispatchDir, 'stale.json'), '{}')
    fixture.manager.getSession = async () => { throw new Error('provider lookup failed') }

    await resetBotProviderSessions(fixture.manager as unknown as HandlerDeps['sessionManager'], root, target.workspaceId, 'bot-one')

    expect(existsSync(sessionPointerPath)).toBe(false)
    expect(existsSync(dispatchDir)).toBe(false)
  })

  it('invalidates provider session pointers when deleteSession fails so the next send creates a new session', async () => {
    const fixture = makeSessionManager()
    const root = mkdtempSync(join(tmpdir(), 'kata-bot-runtime-reset-fail-'))
    const sessionPointerPath = botProviderSessionPath(root, 'bot-one')
    mkdirSync(join(sessionPointerPath, '..'), { recursive: true })
    fixture.sessions.set('stale-session', {
      id: 'stale-session',
      workspaceId: target.workspaceId,
      hidden: true,
      model: target.providerConfig.modelId,
      llmConnection: target.providerConfig.providerId,
      messages: [{ role: 'user', content: 'prior context' }, { role: 'assistant', content: 'prior reply' }],
    })
    writeFileSync(sessionPointerPath, 'stale-session\n')
    fixture.manager.deleteSession = async () => {
      throw new Error('deleteSession failed')
    }

    await resetBotProviderSessions(fixture.manager as unknown as HandlerDeps['sessionManager'], root, target.workspaceId, 'bot-one')
    expect(existsSync(sessionPointerPath)).toBe(false)
    expect(fixture.sessions.has('stale-session')).toBe(true)

    const result = await sendToBotSession(
      fixture.manager as unknown as HandlerDeps['sessionManager'],
      { ...target, sessionPointerPath },
      'after memory mutation',
      { waitForReply: true, dispatchIdempotencyKey: 'after.reset.fail' },
    )
    expect(result.sessionId).toBe('session-1')
    expect(result.reply).toBe('reply: after memory mutation')
    expect(fixture.calls).toEqual(['session-1'])
    expect(readFileSync(sessionPointerPath, 'utf8')).toBe('session-1\n')
  })

  it('reuses a durable dispatch result instead of sending a second provider turn', async () => {
    const fixture = makeSessionManager()
    const root = mkdtempSync(join(tmpdir(), 'kata-bot-runtime-dispatch-'))
    const sessionPointerPath = join(root, 'channels', 'channel-one', 'members', 'bot-one', 'provider-session')
    const completeTarget = { ...target, sessionPointerPath }
    const key = 'dispatch.route_abc.s0'

    const first = await sendToBotSession(
      fixture.manager as unknown as HandlerDeps['sessionManager'],
      completeTarget,
      'hello',
      { waitForReply: true, dispatchIdempotencyKey: key },
    )
    const second = await sendToBotSession(
      fixture.manager as unknown as HandlerDeps['sessionManager'],
      completeTarget,
      'hello',
      { waitForReply: true, dispatchIdempotencyKey: key },
    )

    expect(first.reply).toBe('reply: hello')
    expect(second.reply).toBe('reply: hello')
    expect(second.sessionId).toBe(first.sessionId)
    expect(fixture.calls).toEqual(['session-1'])
    expect(readdirSync(join(root, 'channels', 'channel-one', 'members', 'bot-one', 'provider-dispatches'))).toHaveLength(1)
  })
})
