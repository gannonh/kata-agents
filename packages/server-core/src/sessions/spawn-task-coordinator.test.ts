import { afterEach, describe, expect, it } from 'bun:test'
import { SPAWN_TASK_LIMITS } from '@kata-sh/core'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  it('commits provider_error for a truly synchronous provider callback throw', async () => {
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
        throw new Error('provider callback failed before turn')
      },
    })

    await expect(coordinator.spawn({
      parentSessionId: 'session_parent',
      delegatedPrompt: 'provider callback boundary',
      childConfig: {},
    })).rejects.toMatchObject({
      failure: {
        code: 'provider_error',
        details: { boundary: 'provider' },
      },
      task: {
        dispatch: { state: 'sent' },
        runtimeState: 'failed',
        failure: {
          code: 'provider_error',
          details: { boundary: 'provider' },
        },
      },
    })
    expect(providerCalls).toBe(1)
  })

  it('finalizes a child result before notifying the versioned task update seam', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const store = createStore(workspaceRoot)
    const reserved = store.reserve({
      parentSessionId: 'session_parent',
      delegatedPrompt: 'Produce a result.',
      childConfig: { model: 'fixture' },
    })
    const processing = store.transition(reserved.taskId, {
      runtimeState: 'processing',
      at: '2026-08-16T16:00:00.000Z',
    })
    const updates: Array<{ taskId: string; version: number }> = []

    const coordinator = new SpawnTaskCoordinator({
      store,
      createChild: async () => {},
      appendDelegatedPrompt: async () => {},
      dispatchProvider: () => {},
      onTaskUpdated: (change) => {
        const reloaded = new SpawnTaskStore({
          workspaceRoot,
          workspaceId: 'workspace_spawn_test',
        })
        expect(reloaded.get(change.taskId)).toMatchObject({
          runtimeState: 'completed',
          version: change.version,
          result: {
            byteLength: Buffer.byteLength('authoritative result', 'utf8'),
            sourceMessageId: 'message_source',
          },
        })
        updates.push(change)
      },
    })

    const completed = await coordinator.finalizeResultForChildSession(
      processing.childSessionId,
      'authoritative result',
      'message_source',
    )

    expect(completed).toMatchObject({
      taskId: processing.taskId,
      childSessionId: processing.childSessionId,
      runtimeState: 'completed',
      result: {
        sourceMessageId: 'message_source',
      },
    })
    expect(updates).toEqual([{ taskId: processing.taskId, version: completed!.version }])
    expect(Object.keys(updates[0]!).sort()).toEqual(['taskId', 'version'])
  })

  it('consumes rejected task update handlers without changing durable finalization', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const store = createStore(workspaceRoot)
    const reserved = store.reserve({
      parentSessionId: 'session_parent',
      delegatedPrompt: 'Reject the invalidation callback.',
      childConfig: {},
    })
    const processing = store.transition(reserved.taskId, {
      runtimeState: 'processing',
      at: '2026-08-16T16:00:00.000Z',
    })
    const unhandled: unknown[] = []
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandledRejection)

    try {
      const coordinator = new SpawnTaskCoordinator({
        store,
        createChild: async () => {},
        appendDelegatedPrompt: async () => {},
        dispatchProvider: () => {},
        onTaskUpdated: async () => {
          throw new Error('invalidation callback failed')
        },
      })

      const completed = await coordinator.finalizeResultForChildSession(
        processing.childSessionId,
        'still durable',
      )
      await new Promise<void>((resolve) => setImmediate(resolve))

      expect(completed?.runtimeState).toBe('completed')
      expect(store.get(processing.taskId)?.runtimeState).toBe('completed')
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }
  })

  it('finalizes empty output as a zero-byte task-owned result', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const store = createStore(workspaceRoot)
    const reserved = store.reserve({
      parentSessionId: 'session_parent',
      delegatedPrompt: 'Produce no output.',
      childConfig: {},
    })
    const processing = store.transition(reserved.taskId, {
      runtimeState: 'processing',
      at: '2026-08-16T16:00:00.000Z',
    })
    const coordinator = new SpawnTaskCoordinator({
      store,
      createChild: async () => {},
      appendDelegatedPrompt: async () => {},
      dispatchProvider: () => {},
    })

    const completed = await coordinator.finalizeResultForChildSession(
      processing.childSessionId,
      '',
      'message_empty',
    )

    expect(completed).toMatchObject({
      runtimeState: 'completed',
      result: {
        byteLength: 0,
        preview: '',
        sourceMessageId: 'message_empty',
      },
    })
  })

  it('finalizes oversized output with the store-owned result_too_large failure', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const store = createStore(workspaceRoot)
    const reserved = store.reserve({
      parentSessionId: 'session_parent',
      delegatedPrompt: 'Produce a bounded result.',
      childConfig: {},
    })
    const processing = store.transition(reserved.taskId, {
      runtimeState: 'processing',
      at: '2026-08-16T16:00:00.000Z',
    })
    const updates: Array<{ taskId: string; version: number }> = []
    const coordinator = new SpawnTaskCoordinator({
      store,
      createChild: async () => {},
      appendDelegatedPrompt: async () => {},
      dispatchProvider: () => {},
      onTaskUpdated: (change) => {
        updates.push(change)
      },
    })

    const failed = await coordinator.finalizeResultForChildSession(
      processing.childSessionId,
      'x'.repeat(SPAWN_TASK_LIMITS.resultBytes + 1),
    )

    expect(failed).toMatchObject({
      runtimeState: 'failed',
      failure: {
        code: 'result_too_large',
        retryable: false,
      },
    })
    expect(updates).toEqual([{ taskId: processing.taskId, version: failed!.version }])
  })

  it('commits result_persist_failed after an injected result artifact persistence fault', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const initial = createStore(workspaceRoot)
    const reserved = initial.reserve({
      parentSessionId: 'session_parent',
      delegatedPrompt: 'Persist the result.',
      childConfig: {},
    })
    const processing = initial.transition(reserved.taskId, {
      runtimeState: 'processing',
      at: '2026-08-16T16:00:00.000Z',
    })
    const faulting = new SpawnTaskStore({
      workspaceRoot,
      workspaceId: 'workspace_spawn_test',
      faults: (point) => {
        if (point === 'before-artifact-write') throw new Error('result artifact write failed')
      },
    })
    const updates: Array<{ taskId: string; version: number }> = []
    const coordinator = new SpawnTaskCoordinator({
      store: faulting,
      createChild: async () => {},
      appendDelegatedPrompt: async () => {},
      dispatchProvider: () => {},
      onTaskUpdated: (change) => {
        const reloaded = new SpawnTaskStore({
          workspaceRoot,
          workspaceId: 'workspace_spawn_test',
        })
        expect(reloaded.get(change.taskId)?.failure?.code).toBe('result_persist_failed')
        updates.push(change)
      },
    })

    const failed = await coordinator.finalizeResultForChildSession(
      processing.childSessionId,
      'result cannot be published',
    )

    expect(failed).toMatchObject({
      runtimeState: 'failed',
      failure: { code: 'result_persist_failed' },
    })
    expect(updates).toEqual([{ taskId: processing.taskId, version: failed!.version }])
  })

  it('reconciles a published artifact after terminal commit throws before notifying', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const initial = createStore(workspaceRoot)
    const reserved = initial.reserve({
      parentSessionId: 'session_parent',
      delegatedPrompt: 'Reconcile after publication.',
      childConfig: {},
    })
    const processing = initial.transition(reserved.taskId, {
      runtimeState: 'processing',
      at: '2026-08-16T16:00:00.000Z',
    })
    let injected = true
    const faulting = new SpawnTaskStore({
      workspaceRoot,
      workspaceId: 'workspace_spawn_test',
      faults: (point, task) => {
        if (injected && point === 'before-current-publish' && task.runtimeState === 'completed') {
          injected = false
          throw new Error('terminal publication interrupted')
        }
      },
    })
    const updates: Array<{ taskId: string; version: number }> = []
    const coordinator = new SpawnTaskCoordinator({
      store: faulting,
      createChild: async () => {},
      appendDelegatedPrompt: async () => {},
      dispatchProvider: () => {},
      onTaskUpdated: (change) => {
        const reloaded = new SpawnTaskStore({ workspaceRoot, workspaceId: 'workspace_spawn_test' })
        expect(reloaded.get(change.taskId)).toMatchObject({
          runtimeState: 'completed',
          version: change.version,
          result: { preview: 'published once' },
        })
        updates.push(change)
      },
    })

    const completed = await coordinator.finalizeResultForChildSession(
      processing.childSessionId,
      'published once',
    )

    expect(completed).toMatchObject({ runtimeState: 'completed', result: { preview: 'published once' } })
    expect(updates).toEqual([{ taskId: processing.taskId, version: completed!.version }])
    expect(new SpawnTaskStore({ workspaceRoot, workspaceId: 'workspace_spawn_test' }).get(processing.taskId)).toEqual(completed)
  })

  it('notifies once after startup finalizes a verified nonterminal artifact', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const initial = createStore(workspaceRoot)
    const reserved = initial.reserve({
      parentSessionId: 'session_parent',
      delegatedPrompt: 'Recover a published artifact.',
      childConfig: {},
    })
    const processing = initial.transition(reserved.taskId, {
      runtimeState: 'processing',
      at: '2026-08-16T16:00:00.000Z',
    })
    const interrupted = new SpawnTaskStore({
      workspaceRoot,
      workspaceId: 'workspace_spawn_test',
      faults: (point, task) => {
        if (point === 'before-current-publish' && task.runtimeState === 'completed') {
          throw new Error('terminal publication interrupted')
        }
      },
    })
    expect(() => interrupted.commitResult(processing.taskId, 'recovered output', {
      committedAt: '2026-08-16T16:00:01.000Z',
    })).toThrow('terminal publication interrupted')

    const recovered = new SpawnTaskStore({
      workspaceRoot,
      workspaceId: 'workspace_spawn_test',
    })
    const updates: Array<{ taskId: string; version: number }> = []
    const coordinator = new SpawnTaskCoordinator({
      store: recovered,
      createChild: async () => {},
      appendDelegatedPrompt: async () => {},
      dispatchProvider: () => {},
      onTaskUpdated: (change) => {
        const reloaded = new SpawnTaskStore({
          workspaceRoot,
          workspaceId: 'workspace_spawn_test',
        })
        expect(reloaded.get(change.taskId)).toMatchObject({
          runtimeState: 'completed',
          version: change.version,
        })
        updates.push(change)
      },
    })

    await coordinator.reconcileStartup()
    await coordinator.reconcileStartup()

    const completed = recovered.get(processing.taskId)!
    expect(completed.runtimeState).toBe('completed')
    expect(updates).toEqual([{ taskId: processing.taskId, version: completed.version }])
  })

  it('preserves completed state while notifying integrity marking and repair', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const initial = createStore(workspaceRoot)
    const reserved = initial.reserve({
      parentSessionId: 'session_parent',
      delegatedPrompt: 'Repair a result artifact.',
      childConfig: {},
    })
    const processing = initial.transition(reserved.taskId, {
      runtimeState: 'processing',
      at: '2026-08-16T16:00:00.000Z',
    })
    const completed = initial.commitResult(processing.taskId, 'repair me', {
      committedAt: '2026-08-16T16:00:01.000Z',
    })
    const generationPath = readFileSync(join(workspaceRoot, 'spawn-tasks', 'tasks', completed.taskId, 'CURRENT'), 'utf8').trim()
    writeFileSync(join(workspaceRoot, 'spawn-tasks', 'tasks', completed.taskId, 'generations', generationPath, 'result.md'), 'corrupt', 'utf8')

    const recovered = new SpawnTaskStore({
      workspaceRoot,
      workspaceId: 'workspace_spawn_test',
    })
    const updates: Array<{ taskId: string; version: number }> = []
    const coordinator = new SpawnTaskCoordinator({
      store: recovered,
      createChild: async () => {},
      appendDelegatedPrompt: async () => {},
      dispatchProvider: () => {},
      onTaskUpdated: (change) => {
        const reloaded = new SpawnTaskStore({
          workspaceRoot,
          workspaceId: 'workspace_spawn_test',
        })
        expect(reloaded.get(change.taskId)?.version).toBe(change.version)
        updates.push(change)
      },
    })

    await coordinator.reconcileStartup()
    const marked = recovered.get(completed.taskId)!
    expect(marked.runtimeState).toBe('completed')
    expect(marked.integrityError?.code).toBe('result_persist_failed')

    const repaired = await coordinator.repairResultForChildSession(processing.childSessionId, 'repair me')
    expect(repaired).toMatchObject({
      runtimeState: 'completed',
      integrityError: undefined,
    })
    expect(updates).toEqual([
      { taskId: completed.taskId, version: marked.version },
      { taskId: completed.taskId, version: repaired!.version },
    ])
  })

  it('notifies integrity marking for a missing completed artifact without changing outcome', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const initial = createStore(workspaceRoot)
    const reserved = initial.reserve({
      parentSessionId: 'session_parent',
      delegatedPrompt: 'Detect a missing result artifact.',
      childConfig: {},
    })
    const processing = initial.transition(reserved.taskId, {
      runtimeState: 'processing',
      at: '2026-08-16T16:00:00.000Z',
    })
    const completed = initial.commitResult(processing.taskId, 'missing later', {
      committedAt: '2026-08-16T16:00:01.000Z',
    })
    const generation = readFileSync(join(workspaceRoot, 'spawn-tasks', 'tasks', completed.taskId, 'CURRENT'), 'utf8').trim()
    rmSync(join(workspaceRoot, 'spawn-tasks', 'tasks', completed.taskId, 'generations', generation, 'result.md'))

    const recovered = new SpawnTaskStore({
      workspaceRoot,
      workspaceId: 'workspace_spawn_test',
    })
    const updates: Array<{ taskId: string; version: number }> = []
    const coordinator = new SpawnTaskCoordinator({
      store: recovered,
      createChild: async () => {},
      appendDelegatedPrompt: async () => {},
      dispatchProvider: () => {},
      onTaskUpdated: (change) => {
        updates.push(change)
      },
    })
    await coordinator.waitForStartupNotification()

    const marked = recovered.get(completed.taskId)!
    expect(marked).toMatchObject({
      runtimeState: 'completed',
      result: completed.result,
      integrityError: { code: 'result_persist_failed' },
    })
    expect(updates).toEqual([{ taskId: completed.taskId, version: marked.version }])
  })

  it('keeps the first terminal outcome and suppresses duplicate task updates', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const store = createStore(workspaceRoot)
    const reserved = store.reserve({
      parentSessionId: 'session_parent',
      delegatedPrompt: 'First terminal outcome wins.',
      childConfig: {},
    })
    const processing = store.transition(reserved.taskId, {
      runtimeState: 'processing',
      at: '2026-08-16T16:00:00.000Z',
    })
    const updates: Array<{ taskId: string; version: number }> = []
    const coordinator = new SpawnTaskCoordinator({
      store,
      createChild: async () => {},
      appendDelegatedPrompt: async () => {},
      dispatchProvider: () => {},
      onTaskUpdated: (change) => {
        updates.push(change)
      },
    })

    const failed = await coordinator.finalizeProviderFailureForChildSession(
      processing.childSessionId,
      new Error('first outcome'),
    )
    const lateCompletion = await coordinator.finalizeResultForChildSession(
      processing.childSessionId,
      'late output',
      'late_message',
    )
    const lateFailure = await coordinator.finalizeToolFailureForChildSession(
      processing.childSessionId,
      'late tool failure',
    )

    expect(failed).toMatchObject({ runtimeState: 'failed', failure: { code: 'provider_error' } })
    expect(lateCompletion).toEqual(failed)
    expect(lateFailure).toEqual(failed)
    expect(updates).toEqual([{ taskId: processing.taskId, version: failed!.version }])
  })

  it('returns while the provider turn is pending and finalizes its rejection later', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const store = createStore(workspaceRoot)
    const order: string[] = []
    let rejectProvider!: (error: Error) => void
    let providerTurn!: Promise<void>
    let providerCalls = 0

    const coordinator = new SpawnTaskCoordinator({
      store,
      createChild: async () => {
        order.push('child')
      },
      appendDelegatedPrompt: async ({ task }) => {
        order.push('append')
        expect(task.dispatch.state).toBe('claimed')
      },
      dispatchProvider: ({ task }) => {
        order.push('provider')
        providerCalls += 1
        expect(task.dispatch.state).toBe('sent')
        expect(store.get(task.taskId)).toMatchObject({
          dispatch: { state: 'sent' },
          runtimeState: 'processing',
        })
        providerTurn = new Promise<void>((_resolve, reject) => {
          rejectProvider = reject
        })
        // The test owns this rejection handler so the intentionally pending
        // provider turn does not become an unhandled test-process rejection.
        providerTurn.catch(() => {})
        return providerTurn
      },
    })

    const result = await coordinator.spawn({
      parentSessionId: 'session_parent',
      delegatedPrompt: 'provider may fail later',
      childConfig: {},
    })

    expect(result.runtimeState).toBe('processing')
    expect(order).toEqual(['child', 'append', 'provider'])
    expect(providerCalls).toBe(1)
    expect(store.get(result.taskId)).toMatchObject({
      dispatch: { state: 'sent' },
      runtimeState: 'processing',
    })

    rejectProvider(new Error('provider turn failed'))
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(store.get(result.taskId)).toMatchObject({
      dispatch: { state: 'sent' },
      runtimeState: 'failed',
      failure: {
        code: 'provider_error',
        message: 'provider turn failed',
      },
    })
  })
})
