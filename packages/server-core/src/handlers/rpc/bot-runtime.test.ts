import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import type { HandlerDeps } from '../handler-deps'
import { sendToBotSession } from './bot-runtime'

function makeSessionManager() {
  const sessions = new Map<string, { id: string; messages: Array<{ role: string; content: string }> }>()
  const calls: string[] = []
  let created = 0

  const manager = {
    async createSession(workspaceId: string, options: { name?: string }) {
      void workspaceId
      void options
      const id = `session-${++created}`
      const session = { id, messages: [] }
      sessions.set(id, session)
      return session
    },
    async getSession(sessionId: string) {
      return sessions.get(sessionId) ?? null
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
