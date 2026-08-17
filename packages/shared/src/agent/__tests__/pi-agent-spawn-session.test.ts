import { afterEach, describe, expect, it } from 'bun:test'
import { PiAgent } from '../pi-agent.ts'
import type { BackendConfig } from '../backend/types.ts'

const agents: PiAgent[] = []

afterEach(() => {
  for (const agent of agents.splice(0)) agent.destroy()
})

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-spawn-test',
      name: 'Spawn test workspace',
      rootPath: '/tmp/kata-agent-spawn-test',
    } as any,
    session: {
      id: 'session-parent',
      workspaceRootPath: '/tmp/kata-agent-spawn-test',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
  }
}

describe('PiAgent spawn_session failures', () => {
  it('preserves the canonical structured spawn failure', async () => {
    const agent = new PiAgent(createConfig())
    agents.push(agent)
    const failure = {
      code: 'spawn_persist_failed',
      message: 'reserved intent could not be persisted',
      retryable: true,
      details: { boundary: 'intent' },
      committedAt: '2026-08-16T16:00:00.000Z',
    }
    agent.onSpawnSession = async () => {
      const error = new Error(failure.message) as Error & { failure: typeof failure }
      error.failure = failure
      throw error
    }

    const result = await (agent as any).executeSessionTool('spawn_session', { prompt: 'delegate' })

    expect(result).toEqual({
      content: JSON.stringify(failure, null, 2),
      isError: true,
    })
  })
})
