import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import type { HandlerDeps } from '../handler-deps'
import { resetBotProviderSessions, sendToBotSession } from './bot-runtime'
import { botProviderSessionPath } from '@kata-sh/shared/bots'
import { channelProviderSessionPath } from '@kata-sh/shared/channels'

function makeSessionManager() {
  const sessions = new Map<string, { id: string; hidden?: boolean; messages: Array<{ role: string; content: string }> }>()
  const calls: string[] = []
  let created = 0

  const manager = {
    async createSession(workspaceId: string, options: { name?: string; hidden?: boolean }) {
      void workspaceId
      void options
      const id = `session-${++created}`
      const session = { id, hidden: options.hidden, messages: [] }
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
      calls.push(sessionId)
      session.messages.push({ role: 'user', content: message })
      session.messages.push({ role: 'assistant', content: `reply: ${message}` })
      const onAck = args[5]
      if (typeof onAck === 'function') (onAck as (messageId: string) => void)('message-1')
    },
  }

  return { manager, sessions, calls, get created() { return created } }
}

const target = {
  workspaceId: 'workspace-one',
  name: 'Research Bot',
  permissionMode: 'ask' as const,
  providerConfig: { providerId: 'openai-codex', modelId: 'gpt-5-codex' },
}

describe('sendToBotSession', () => {
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
    const pointers = [direct, channel, publicPointer]
    for (const pointer of pointers) {
      mkdirSync(join(pointer, '..'), { recursive: true })
    }
    fixture.sessions.set('hidden-direct', { id: 'hidden-direct', hidden: true, messages: [] })
    fixture.sessions.set('hidden-channel', { id: 'hidden-channel', hidden: true, messages: [] })
    fixture.sessions.set('public', { id: 'public', hidden: false, messages: [] })
    writeFileSync(direct, 'hidden-direct\n')
    writeFileSync(channel, 'hidden-channel\n')
    writeFileSync(publicPointer, 'public\n')
    await resetBotProviderSessions(fixture.manager as unknown as HandlerDeps['sessionManager'], root, 'bot-one')
    expect(fixture.sessions.has('hidden-direct')).toBe(false)
    expect(fixture.sessions.has('hidden-channel')).toBe(false)
    expect(fixture.sessions.has('public')).toBe(true)
    expect(existsSync(publicPointer)).toBe(true)
  })

  it('recovers a pending dispatch from the hidden provider transcript', async () => {
    const fixture = makeSessionManager()
    const root = mkdtempSync(join(tmpdir(), 'kata-bot-runtime-pending-'))
    const sessionPointerPath = join(root, 'channels', 'channel-one', 'members', 'bot-one', 'provider-session')
    mkdirSync(join(root, 'channels', 'channel-one', 'members', 'bot-one'), { recursive: true })
    writeFileSync(sessionPointerPath, 'session-1\\n')
    fixture.sessions.set('session-1', {
      id: 'session-1',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'recovered reply' },
      ],
    })
    const key = 'dispatch.pending'
    const dispatchDir = join(root, 'channels', 'channel-one', 'members', 'bot-one', 'provider-dispatches')
    mkdirSync(dispatchDir, { recursive: true })
    const hash = createHash('sha256').update(key).digest('hex')
    writeFileSync(join(dispatchDir, `${hash}.json`), JSON.stringify({ schemaVersion: 1, dispatchIdempotencyKey: key, sessionId: 'session-1', state: 'pending', userMessageId: 'missing-id' }))
    const result = await sendToBotSession(fixture.manager as unknown as HandlerDeps['sessionManager'], { ...target, sessionPointerPath }, 'hello', { waitForReply: true, dispatchIdempotencyKey: key })
    expect(result.reply).toBe('recovered reply')
    expect(fixture.calls).toEqual([])
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
      'hello again',
      { waitForReply: true, dispatchIdempotencyKey: key },
    )

    expect(first.reply).toBe('reply: hello')
    expect(second.reply).toBe('reply: hello')
    expect(second.sessionId).toBe(first.sessionId)
    expect(fixture.calls).toEqual(['session-1'])
    expect(readdirSync(join(root, 'channels', 'channel-one', 'members', 'bot-one', 'provider-dispatches'))).toHaveLength(1)
  })
})
