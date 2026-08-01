import { describe, expect, it } from 'bun:test'
import type { AgentEvent } from '@kata-sh/core/types'
import type { FileAttachment } from '../../utils/files.ts'
import { ClaudeAgent } from '../claude-agent.ts'
import { AbortReason, type ChatOptions } from '../backend/types.ts'
import { createMockBackendConfig } from './test-utils.ts'

class BlockingClaudeAgent extends ClaudeAgent {
  private releaseChatPromise!: () => void
  private resolveChatStarted!: () => void
  readonly chatStarted: Promise<void>

  constructor() {
    super(createMockBackendConfig())
    this.chatStarted = new Promise<void>((resolve) => {
      this.resolveChatStarted = resolve
    })
  }

  protected override async *chatImpl(
    _userMessage: string,
    _attachments?: FileAttachment[],
    _options?: ChatOptions,
  ): AsyncGenerator<AgentEvent> {
    this.resolveChatStarted()
    await new Promise<void>((resolve) => {
      this.releaseChatPromise = resolve
    })
    yield { type: 'complete' }
  }

  releaseChat(): void {
    this.releaseChatPromise()
  }
}

describe('ClaudeAgent teardown quiescence', () => {
  it('waits for a real chat generator to close after abort', async () => {
    const agent = new BlockingClaudeAgent()
    const stream = agent.chat('held turn')
    const firstNext = stream.next()
    await agent.chatStarted

    let settled = false
    const teardown = agent.quiesceForTeardown(AbortReason.UserStop).then(() => {
      settled = true
    })

    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)

    agent.releaseChat()
    await firstNext
    await stream.next()
    await teardown
    expect(settled).toBe(true)
    agent.destroy()
  })
})
