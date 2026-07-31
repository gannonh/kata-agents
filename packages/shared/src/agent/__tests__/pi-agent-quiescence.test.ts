import { EventEmitter } from 'node:events'
import { describe, expect, it, jest } from 'bun:test'
import { PiAgent } from '../pi-agent.ts'
import { AbortReason, type BackendConfig } from '../backend/types.ts'

class FakeChild extends EventEmitter {
  pid = 42
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killSignals: Array<NodeJS.Signals | number | undefined> = []
  onKill: ((signal: NodeJS.Signals | number | undefined) => void) | null = null

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal)
    this.onKill?.(signal)
    return true
  }
}

function createConfig(): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: '/tmp/kata-agent-test',
    } as any,
    session: {
      id: 'session-test',
      workspaceRootPath: '/tmp/kata-agent-test',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
  }
}

function installFakeChild(agent: PiAgent, child: FakeChild): any {
  const internals = agent as any
  internals.subprocess = child
  internals.readline = null
  internals.send = () => {}
  internals.adapter = { resetOverflowState: () => {} }
  return internals
}

describe('PiAgent teardown quiescence', () => {
  it('resolves only after the exact persistent child emits exit', async () => {
    const agent = new PiAgent(createConfig())
    const child = new FakeChild()
    installFakeChild(agent, child)
    child.onKill = (signal) => {
      if (signal === 'SIGTERM') {
        queueMicrotask(() => {
          child.exitCode = 0
          child.emit('exit', 0, null)
        })
      }
    }

    await agent.quiesceForTeardown(AbortReason.UserStop)

    expect(child.killSignals).toEqual(['SIGTERM'])
    expect((agent as any).subprocess).toBeNull()
    agent.destroy()
  })

  it('escalates to SIGKILL when SIGTERM does not produce exit', async () => {
    jest.useFakeTimers()
    try {
      const agent = new PiAgent(createConfig())
      const child = new FakeChild()
      const internals = installFakeChild(agent, child)
      child.onKill = (signal) => {
        if (signal === 'SIGKILL') {
          child.exitCode = null
          child.signalCode = 'SIGKILL'
          child.emit('exit', null, 'SIGKILL')
        }
      }

      const stopping = internals.killSubprocessGracefully(100, true)
      jest.advanceTimersByTime(100)
      await Promise.resolve()
      await stopping

      expect(child.killSignals).toEqual(['SIGTERM', 'SIGKILL'])
      agent.destroy()
    } finally {
      jest.useRealTimers()
    }
  })

  it('rejects strict teardown when exit remains unconfirmed after SIGKILL', async () => {
    jest.useFakeTimers()
    try {
      const agent = new PiAgent(createConfig())
      const child = new FakeChild()
      const internals = installFakeChild(agent, child)
      const stopping = internals.killSubprocessGracefully(100, true)

      jest.advanceTimersByTime(100)
      await Promise.resolve()
      jest.advanceTimersByTime(100)

      await expect(stopping).rejects.toThrow('stop timed out after SIGKILL')
      expect(child.killSignals).toEqual(['SIGTERM', 'SIGKILL'])
      agent.destroy()
    } finally {
      jest.useRealTimers()
    }
  })

  it('does not let a stale child exit clear a replacement', () => {
    const agent = new PiAgent(createConfig())
    const oldChild = new FakeChild()
    const replacement = new FakeChild()
    const internals = installFakeChild(agent, replacement)

    internals.handleSubprocessExit(oldChild, 0, null)
    expect(internals.subprocess).toBe(replacement)

    internals.handleSubprocessExit(replacement, 0, null)
    expect(internals.subprocess).toBeNull()
    agent.destroy()
  })
})
