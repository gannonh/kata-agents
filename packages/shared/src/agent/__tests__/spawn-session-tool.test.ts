import { describe, expect, it } from 'bun:test'
import { createSpawnSessionTool } from '../spawn-session-tool.ts'

const failure = {
  code: 'spawn_persist_failed',
  message: 'reserved intent could not be persisted',
  retryable: true,
  details: { boundary: 'intent' },
  committedAt: '2026-08-16T16:00:00.000Z',
}

describe('spawn_session tool contract', () => {
  it('returns the canonical structured failure for Claude-backed tool calls', async () => {
    const tool = createSpawnSessionTool({
      sessionId: 'session-parent',
      getSpawnSessionFn: () => async () => {
        const error = new Error(failure.message) as Error & { failure: typeof failure }
        error.failure = failure
        throw error
      },
    })

    const result = await tool.handler({ prompt: 'delegate' } as any, {} as any)

    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify(failure, null, 2) }],
      isError: true,
    })
  })

  it('returns exactly the canonical four-field success shape', async () => {
    const success = {
      taskId: 'task_1',
      childSessionId: 'session_child_1',
      runtimeState: 'processing' as const,
      version: 5,
    }
    const tool = createSpawnSessionTool({
      sessionId: 'session-parent',
      getSpawnSessionFn: () => async () => success,
    })

    const result = await tool.handler({ prompt: 'delegate' } as any, {} as any)
    const content = result.content[0]
    expect(content?.type).toBe('text')
    if (content?.type !== 'text') throw new Error('spawn_session result did not contain text')
    const parsed = JSON.parse(content.text)

    expect(Object.keys(parsed).sort()).toEqual([
      'childSessionId',
      'runtimeState',
      'taskId',
      'version',
    ])
    expect(parsed).toEqual(success)
  })
})
