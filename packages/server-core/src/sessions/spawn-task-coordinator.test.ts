import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpawnTask } from '@kata-sh/core'
import { SpawnTaskStore, type SpawnTaskStoreOptions } from '@kata-sh/shared/spawn-tasks'
import { SpawnTaskCoordinator } from './spawn-task-coordinator.ts'

const roots: string[] = []

function createStore(
  workspaceRoot: string,
  faults?: SpawnTaskStoreOptions['faults'],
): SpawnTaskStore {
  let sequence = 0
  return new SpawnTaskStore({
    workspaceRoot,
    workspaceId: 'workspace_spawn_test',
    clock: () => '2026-08-16T16:00:00.000Z',
    randomId: () => `id-${++sequence}`,
    faults,
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('SpawnTaskCoordinator', () => {
  it('persists the reserved intent before child publication and dispatches only after sent', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const store = createStore(workspaceRoot)
    const order: string[] = []
    let childPublished = false
    let appendedMessageId: string | undefined

    const coordinator = new SpawnTaskCoordinator({
      store,
      createChild: async ({ task }) => {
        order.push('child')
        const reloaded = new SpawnTaskStore({
          workspaceRoot,
          workspaceId: 'workspace_spawn_test',
        })
        expect(reloaded.get(task.taskId)).toMatchObject({
          taskId: task.taskId,
          childSessionId: task.childSessionId,
          dispatch: { state: 'reserved' },
        })
        childPublished = true
      },
      appendDelegatedPrompt: async ({ task, prompt }) => {
        order.push('append')
        expect(childPublished).toBe(true)
        expect(prompt).toBe('delegate this work')
        expect(store.get(task.taskId)?.dispatch.state).toBe('claimed')
        appendedMessageId = task.dispatch.messageId
      },
      dispatchProvider: ({ task }) => {
        order.push('provider')
        expect(task.dispatch.state).toBe('sent')
        expect(store.get(task.taskId)?.dispatch.state).toBe('sent')
        expect(store.get(task.taskId)?.runtimeState).toBe('processing')
      },
    })

    const result = await coordinator.spawn({
      parentSessionId: 'session_parent',
      delegatedPrompt: 'delegate this work',
      childConfig: { model: 'fixture-model' },
    })

    expect(Object.keys(result).sort()).toEqual([
      'childSessionId',
      'runtimeState',
      'taskId',
      'version',
    ])
    expect(result).toEqual({
      taskId: 'task_id-1',
      childSessionId: 'session_id-2',
      runtimeState: 'processing',
      version: 5,
    })
    expect(appendedMessageId).toBe('message_id-3')
    expect(store.get(result.taskId)?.dispatch.dispatchAttemptId).toBe('attempt_id-4')
    expect(order).toEqual(['child', 'append', 'provider'])
  })

  it('does not publish a child or dispatch when the reserved intent commit fails', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const store = createStore(workspaceRoot, (_point, task) => {
      if (task.dispatch.state === 'reserved') {
        throw new Error('intent commit failed')
      }
    })
    let childCalls = 0
    let providerCalls = 0

    const coordinator = new SpawnTaskCoordinator({
      store,
      createChild: async () => {
        childCalls += 1
      },
      appendDelegatedPrompt: async () => {},
      dispatchProvider: () => {
        providerCalls += 1
      },
    })

    await expect(coordinator.spawn({
      parentSessionId: 'session_parent',
      delegatedPrompt: 'intent before child',
      childConfig: {},
    })).rejects.toMatchObject({
      failure: {
        code: 'spawn_persist_failed',
        details: { boundary: 'intent' },
      },
      task: null,
    })

    expect(childCalls).toBe(0)
    expect(providerCalls).toBe(0)
    expect(store.listAll()).toEqual([])
  })

  it('does not append or dispatch when the durable claim commit fails', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    let injected = false
    const store = createStore(workspaceRoot, (_point, task) => {
      if (!injected && task.dispatch.state === 'claimed') {
        injected = true
        throw new Error('claim commit failed')
      }
    })
    let appendCalls = 0
    let providerCalls = 0

    const coordinator = new SpawnTaskCoordinator({
      store,
      createChild: async () => {},
      appendDelegatedPrompt: async () => {
        appendCalls += 1
      },
      dispatchProvider: () => {
        providerCalls += 1
      },
    })

    await expect(coordinator.spawn({
      parentSessionId: 'session_parent',
      delegatedPrompt: 'claim before dispatch',
      childConfig: {},
    })).rejects.toMatchObject({
      failure: {
        code: 'spawn_persist_failed',
        details: { boundary: 'claim' },
      },
    })

    expect(appendCalls).toBe(0)
    expect(providerCalls).toBe(0)
    expect(store.listAll()[0]).toMatchObject({
      dispatch: { state: 'ready' },
      runtimeState: 'failed',
      failure: { code: 'spawn_persist_failed' },
    })
  })

  it('does not claim, append, or dispatch when the ready commit fails', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    let injected = false
    const store = createStore(workspaceRoot, (_point, task) => {
      if (!injected && task.dispatch.state === 'ready') {
        injected = true
        throw new Error('ready commit failed')
      }
    })
    let appendCalls = 0
    let providerCalls = 0

    const coordinator = new SpawnTaskCoordinator({
      store,
      createChild: async () => {},
      appendDelegatedPrompt: async () => {
        appendCalls += 1
      },
      dispatchProvider: () => {
        providerCalls += 1
      },
    })

    await expect(coordinator.spawn({
      parentSessionId: 'session_parent',
      delegatedPrompt: 'ready before claim',
      childConfig: {},
    })).rejects.toMatchObject({
      failure: {
        code: 'spawn_persist_failed',
        details: { boundary: 'ready' },
      },
    })

    expect(appendCalls).toBe(0)
    expect(providerCalls).toBe(0)
    expect(store.listAll()[0]).toMatchObject({
      dispatch: { state: 'reserved' },
      runtimeState: 'failed',
      failure: { code: 'spawn_persist_failed' },
    })
  })

  it('does not invoke the provider when the sent commit fails after append', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    let injected = false
    const store = createStore(workspaceRoot, (_point, task) => {
      if (!injected && task.dispatch.state === 'sent') {
        injected = true
        throw new Error('sent commit failed')
      }
    })
    let appendCalls = 0
    let providerCalls = 0

    const coordinator = new SpawnTaskCoordinator({
      store,
      createChild: async () => {},
      appendDelegatedPrompt: async ({ task }) => {
        appendCalls += 1
        expect(task.dispatch.state).toBe('claimed')
      },
      dispatchProvider: () => {
        providerCalls += 1
      },
    })

    await expect(coordinator.spawn({
      parentSessionId: 'session_parent',
      delegatedPrompt: 'sent before provider',
      childConfig: {},
    })).rejects.toMatchObject({
      failure: {
        code: 'spawn_persist_failed',
        details: { boundary: 'sent' },
      },
    })

    expect(appendCalls).toBe(1)
    expect(providerCalls).toBe(0)
    expect(store.listAll()[0]).toMatchObject({
      dispatch: { state: 'claimed' },
      runtimeState: 'failed',
      failure: { code: 'spawn_persist_failed' },
    })
  })

  it('returns a canonical persist failure without dispatching after prompt append fails', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const store = createStore(workspaceRoot)
    let providerCalled = false

    const coordinator = new SpawnTaskCoordinator({
      store,
      createChild: async () => {},
      appendDelegatedPrompt: async () => {
        throw new Error('message flush failed')
      },
      dispatchProvider: () => {
        providerCalled = true
      },
    })

    const spawn = coordinator.spawn({
      parentSessionId: 'session_parent',
      delegatedPrompt: 'must not dispatch',
      childConfig: {},
    })

    await expect(spawn).rejects.toMatchObject({
      name: 'SpawnTaskCreationError',
      failure: {
        code: 'spawn_persist_failed',
        retryable: true,
        details: { boundary: 'message_append' },
      },
    })
    expect(providerCalled).toBe(false)

    const task = store.listAll()[0]
    expect(task).toMatchObject({
      dispatch: { state: 'claimed' },
      runtimeState: 'failed',
      failure: {
        code: 'spawn_persist_failed',
        details: { boundary: 'message_append' },
      },
    })
  })

  it('retains a committed reserved task when child publication fails', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const store = createStore(workspaceRoot)
    let providerCalled = false

    const coordinator = new SpawnTaskCoordinator({
      store,
      createChild: async () => {
        throw new Error('child persistence failed')
      },
      appendDelegatedPrompt: async () => {
        throw new Error('append must not run')
      },
      dispatchProvider: () => {
        providerCalled = true
      },
    })

    await expect(coordinator.spawn({
      parentSessionId: 'session_parent',
      delegatedPrompt: 'child must be durable first',
      childConfig: {},
    })).rejects.toMatchObject({
      failure: {
        code: 'spawn_persist_failed',
        details: { boundary: 'child' },
      },
      task: {
        dispatch: { state: 'reserved' },
        runtimeState: 'failed',
      },
    })
    expect(providerCalled).toBe(false)
    expect(store.listAll()).toHaveLength(1)
  })

  it('commits a synchronous provider-call failure without dispatching twice', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const store = createStore(workspaceRoot)
    let providerCalls = 0

    const coordinator = new SpawnTaskCoordinator({
      store,
      createChild: async () => {},
      appendDelegatedPrompt: async () => {},
      dispatchProvider: () => {
        providerCalls += 1
        throw new Error('provider call failed before turn')
      },
    })

    await expect(coordinator.spawn({
      parentSessionId: 'session_parent',
      delegatedPrompt: 'provider boundary',
      childConfig: {},
    })).rejects.toMatchObject({
      failure: {
        code: 'spawn_persist_failed',
        details: { boundary: 'provider' },
      },
      task: {
        dispatch: { state: 'sent' },
        runtimeState: 'failed',
      },
    })
    expect(providerCalls).toBe(1)
  })

  it('commits a provider-call failure after the initial dispatch has been claimed once', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const store = createStore(workspaceRoot)
    let rejectProvider!: (error: Error) => void
    let providerCalls = 0
    let observedFailure: SpawnTask | undefined

    const coordinator = new SpawnTaskCoordinator({
      store,
      createChild: async () => {},
      appendDelegatedPrompt: async ({ task }) => {
        expect(task.dispatch.messageId).toBe('message_id-3')
      },
      dispatchProvider: () => {
        providerCalls += 1
        return new Promise<void>((_resolve, reject) => {
          rejectProvider = reject
        })
      },
      onAsyncDispatchFailure: (_error, task) => {
        observedFailure = task
      },
    })

    const result = await coordinator.spawn({
      parentSessionId: 'session_parent',
      delegatedPrompt: 'provider may fail',
      childConfig: {},
    })
    expect(result.runtimeState).toBe('processing')
    expect(providerCalls).toBe(1)

    rejectProvider(new Error('provider unavailable'))
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(observedFailure).toMatchObject({
      dispatch: { state: 'sent' },
      runtimeState: 'failed',
      failure: {
        code: 'spawn_persist_failed',
        details: { boundary: 'provider' },
      },
    })
    expect(store.listAll()).toHaveLength(1)
    expect(providerCalls).toBe(1)
  })
})
