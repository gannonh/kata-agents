import { describe, expect, it, mock } from 'bun:test'
import { ClaudeAgent } from '../claude-agent.ts'
import { AbortReason } from '../backend/types.ts'

describe('ClaudeAgent teardown quiescence', () => {
  it('does not resolve when forceAbort only clears currentQuery', async () => {
    const agent = Object.create(ClaudeAgent.prototype) as any
    let releaseChat!: () => void
    agent.activeChatCount = 1
    agent.idleChatPromise = new Promise<void>((resolve) => { releaseChat = resolve })
    agent.resolveIdleChat = releaseChat
    agent.pendingSteerMessage = 'queued steer'
    agent.lastAbortReason = null
    agent.currentQuery = { interrupt: mock(async () => {}) }
    agent.currentQueryAbortController = { abort: mock(() => {}) }

    let settled = false
    const teardown = agent.quiesceForTeardown(AbortReason.UserStop).then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(agent.currentQuery).toBeNull()
    expect(settled).toBe(false)

    releaseChat()
    await teardown
    expect(settled).toBe(true)
  })
})
