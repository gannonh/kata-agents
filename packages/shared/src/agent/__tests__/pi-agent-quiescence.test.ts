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

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
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
      await drainMicrotasks()
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
      await drainMicrotasks()
      jest.advanceTimersByTime(100)

      await expect(stopping).rejects.toThrow('stop timed out after SIGKILL')
      expect(child.killSignals).toEqual(['SIGTERM', 'SIGKILL'])
      expect(internals.subprocess).toBe(child)
      agent.destroy()
    } finally {
      jest.useRealTimers()
    }
  })

  it('rejects pending RPCs when teardown detaches without an exit event', async () => {
    jest.useFakeTimers()
    try {
      const agent = new PiAgent(createConfig())
      const child = new FakeChild()
      const internals = installFakeChild(agent, child)
      const pending = new Promise((resolve, reject) => {
        internals.pendingLlmQueries.set('llm-test', { resolve, reject })
      })
      const rejection = pending.then(
        () => { throw new Error('pending RPC unexpectedly resolved') },
        (error) => {
          expect(error).toBeInstanceOf(Error)
          expect((error as Error).message).toContain('Pi subprocess exited')
        },
      )
      const stopping = internals.killSubprocessGracefully(100, false)
      jest.advanceTimersByTime(100)
      await drainMicrotasks()
      jest.advanceTimersByTime(100)
      await drainMicrotasks()
      await stopping
      await rejection
      agent.destroy()
    } finally {
      jest.useRealTimers()
    }
  })

  it('keeps an unconfirmed child tracked across non-strict cleanup calls', () => {
    const agent = new PiAgent(createConfig())
    const child = new FakeChild()
    const internals = installFakeChild(agent, child)
    internals.subprocessExitUnconfirmed = true

    internals.killSubprocess()

    expect(internals.subprocess).toBe(child)
    expect(internals.subprocessExitUnconfirmed).toBe(true)
    internals.handleSubprocessExit(child, null, 'SIGTERM')
    expect(internals.subprocess).toBeNull()
    agent.destroy()
  })

  it('does not let a stale child exit clear a replacement', () => {
    const agent = new PiAgent(createConfig())
    const oldChild = new FakeChild()
    const replacement = new FakeChild()
    const internals = installFakeChild(agent, replacement)
    let overflowResets = 0
    internals.adapter = { resetOverflowState: () => { overflowResets += 1 } }
    internals.callbackPort = 1234

    internals.handleSubprocessExit(oldChild, 0, null)
    expect(internals.subprocess).toBe(replacement)
    expect(overflowResets).toBe(0)
    expect(internals.callbackPort).toBe(1234)

    internals.handleSubprocessExit(replacement, 0, null)
    expect(internals.subprocess).toBeNull()
    expect(overflowResets).toBe(1)
    expect(internals.callbackPort).toBe(0)
    agent.destroy()
  })
})
