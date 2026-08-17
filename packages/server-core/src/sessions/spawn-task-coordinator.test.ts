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
  it('recovers a reserved task by creating the reserved child before dispatch', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const store = createStore(workspaceRoot)
    const reserved = store.reserve({
      parentSessionId: 'session_parent',
      delegatedPrompt: 'recover this reserved task',
      childConfig: { model: 'fixture' },
    })
    const order: string[] = []
    let createdChildId: string | undefined
    let childExists = false
    let providerCalls = 0
    const updates: Array<{ taskId: string; version: number }> = []
    const coordinator = new SpawnTaskCoordinator({
      store,
      createChild: async ({ task }) => {
        order.push('child')
        createdChildId = task.childSessionId
        expect(store.get(task.taskId)?.dispatch.state).toBe('reserved')
        childExists = true
      },
      appendDelegatedPrompt: async ({ task }) => {
        order.push('append')
        expect(childExists).toBe(true)
        expect(store.get(task.taskId)?.dispatch.state).toBe('claimed')
      },
      dispatchProvider: ({ task }) => {
        order.push('provider')
        providerCalls += 1
        expect(task.dispatch.state).toBe('sent')
        expect(store.get(task.taskId)?.runtimeState).toBe('processing')
      },
      onTaskUpdated: (change) => {
        updates.push(change)
      },
    })

    await coordinator.reconcileStartup({
      parentExists: () => true,
      findChild: () => ({ exists: childExists, matches: childExists }),
      listChildren: () => [],
    })

    expect(createdChildId).toBe(reserved.childSessionId)
    expect(order).toEqual(['child', 'append', 'provider'])
    expect(providerCalls).toBe(1)
    expect(store.get(reserved.taskId)).toMatchObject({
      runtimeState: 'processing',
      dispatch: { state: 'sent', messageId: reserved.dispatch.messageId },
    })
    expect(updates.length).toBeGreaterThanOrEqual(3)
    expect(updates.every((change) => Object.keys(change).sort().join(',') === 'taskId,version')).toBe(true)
  })

  it('marks a reserved task with its existing child ready without recreating it', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const store = createStore(workspaceRoot)
    const reserved = store.reserve({
      parentSessionId: 'session_parent',
      delegatedPrompt: 'existing reserved child',
      childConfig: {},
    })
    let createCalls = 0
    let providerCalls = 0
    const coordinator = new SpawnTaskCoordinator({
      store,
      createChild: async () => {
        createCalls += 1
      },
      appendDelegatedPrompt: async ({ task }) => {
        expect(store.get(task.taskId)?.dispatch.state).toBe('claimed')
      },
      dispatchProvider: () => {
        providerCalls += 1
      },
    })

    await coordinator.reconcileStartup({
      parentExists: () => true,
      findChild: () => ({ exists: true, matches: true }),
    })

    expect(createCalls).toBe(0)
    expect(providerCalls).toBe(1)
    expect(store.get(reserved.taskId)).toMatchObject({
      runtimeState: 'processing',
      dispatch: { state: 'sent' },
    })
  })

  it('recovers a ready task with the original attachments', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const store = createStore(workspaceRoot)
    const attachment = {
      type: 'text' as const,
      path: join(workspaceRoot, 'note.txt'),
      name: 'note.txt',
      mimeType: 'text/plain',
      size: 4,
      text: 'note',
    }
    const reserved = store.reserve({
      parentSessionId: 'session_parent',
      delegatedPrompt: 'summarize the attachment',
      childConfig: {
        attachments: [{ path: attachment.path, name: attachment.name }],
      },
    })
    store.updateDispatch(reserved.taskId, 'ready', '2026-08-16T16:00:01.000Z')
    let appendedAttachments: unknown
    let dispatchedAttachments: unknown
    let providerCalls = 0
    const coordinator = new SpawnTaskCoordinator({
      store,
      createChild: async () => {},
      appendDelegatedPrompt: async ({ attachments }) => {
        appendedAttachments = attachments
      },
      dispatchProvider: ({ attachments }) => {
        dispatchedAttachments = attachments
        providerCalls += 1
      },
    })

    await coordinator.reconcileStartup({
      parentExists: () => true,
      findChild: () => ({ exists: true, matches: true }),
      resolveAttachments: () => [attachment],
    })

    expect(appendedAttachments).toEqual([attachment])
    expect(dispatchedAttachments).toEqual([attachment])
    expect(providerCalls).toBe(1)
    expect(store.get(reserved.taskId)).toMatchObject({
      runtimeState: 'processing',
      dispatch: { state: 'sent' },
    })
  })

  it('fails ready recovery when attachments cannot be restored', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const store = createStore(workspaceRoot)
    const reserved = store.reserve({
      parentSessionId: 'session_parent',
      delegatedPrompt: 'summarize the missing attachment',
      childConfig: {
        attachments: [{ path: '/missing/note.txt', name: 'note.txt' }],
      },
    })
    const ready = store.updateDispatch(reserved.taskId, 'ready', '2026-08-16T16:00:01.000Z')
    let providerCalls = 0
    const coordinator = new SpawnTaskCoordinator({
      store,
      createChild: async () => {},
      appendDelegatedPrompt: async () => {},
      dispatchProvider: () => {
        providerCalls += 1
      },
    })

    await coordinator.reconcileStartup({
      parentExists: () => true,
      findChild: () => ({ exists: true, matches: true }),
      resolveAttachments: () => {
        throw new Error('attachment missing')
      },
    })

    expect(providerCalls).toBe(0)
    expect(store.get(ready.taskId)).toMatchObject({
      runtimeState: 'failed',
      failure: {
        code: 'spawn_persist_failed',
        details: { boundary: 'attachments' },
      },
    })
  })

  it('interrupts claimed work after restart without replaying the provider call', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const store = createStore(workspaceRoot)
    const reserved = store.reserve({
      parentSessionId: 'session_parent',
      delegatedPrompt: 'never replay this task',
      childConfig: {},
    })
    const ready = store.updateDispatch(reserved.taskId, 'ready', '2026-08-16T16:00:01.000Z')
    const claimed = store.updateDispatch(ready.taskId, 'claimed', '2026-08-16T16:00:02.000Z')
    const updates: Array<{ taskId: string; version: number }> = []
    let providerCalls = 0
    const coordinator = new SpawnTaskCoordinator({
      store,
      createChild: async () => {},
      appendDelegatedPrompt: async () => {
        throw new Error('claimed work must not append again')
      },
      dispatchProvider: () => {
        providerCalls += 1
      },
      onTaskUpdated: (change) => {
        updates.push(change)
        expect(store.get(change.taskId)?.runtimeState).toBe('failed')
      },
    })

    await coordinator.reconcileStartup({
      parentExists: () => true,
      findChild: () => ({ exists: true, matches: true }),
    })

    expect(providerCalls).toBe(0)
    expect(store.get(claimed.taskId)).toMatchObject({
      runtimeState: 'failed',
      failure: {
        code: 'dispatch_interrupted',
        retryable: true,
      },
    })
    expect(updates).toEqual([{ taskId: claimed.taskId, version: claimed.version + 1 }])
  })

  it('lets two managers share one durable claim without replaying or interrupting it', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const initial = createStore(workspaceRoot)
    const reserved = initial.reserve({
      parentSessionId: 'session_parent',
      delegatedPrompt: 'one manager owns this task',
      childConfig: {},
    })
    const ready = initial.updateDispatch(reserved.taskId, 'ready', '2026-08-16T16:00:01.000Z')
    const managerOneStore = createStore(workspaceRoot)
    const managerTwoStore = createStore(workspaceRoot)
    let releaseAppend!: () => void
    const appendReleased = new Promise<void>((resolve) => {
      releaseAppend = resolve
    })
    let providerCalls = 0
    const managerOne = new SpawnTaskCoordinator({
      store: managerOneStore,
      createChild: async () => {},
      appendDelegatedPrompt: async () => {
        await appendReleased
      },
      dispatchProvider: () => {
        providerCalls += 1
      },
    })
    const managerTwo = new SpawnTaskCoordinator({
      store: managerTwoStore,
      createChild: async () => {},
      appendDelegatedPrompt: async () => {
        throw new Error('second manager must not append')
      },
      dispatchProvider: () => {
        providerCalls += 1
      },
    })

    const firstRecovery = managerOne.reconcileStartup({
      parentExists: () => true,
      findChild: () => ({ exists: true, matches: true }),
    })
    for (let attempt = 0; attempt < 20 && managerOneStore.get(ready.taskId)?.dispatch.state !== 'claimed'; attempt++) {
      await Promise.resolve()
    }
    expect(managerOneStore.get(ready.taskId)?.dispatch.state).toBe('claimed')

    await managerTwo.reconcileStartup({
      parentExists: () => true,
      findChild: () => ({ exists: true, matches: true }),
    })
    releaseAppend()
    await firstRecovery

    expect(providerCalls).toBe(1)
    expect(new SpawnTaskStore({ workspaceRoot, workspaceId: 'workspace_spawn_test' }).get(ready.taskId)).toMatchObject({
      runtimeState: 'processing',
      dispatch: { state: 'sent' },
    })
  })

  it('retries recovery after a claim publication fault without replaying a provider call', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const initial = createStore(workspaceRoot)
    const reserved = initial.reserve({ parentSessionId: 'session_parent', delegatedPrompt: 'retry claim recovery', childConfig: {} })
    const ready = initial.updateDispatch(reserved.taskId, 'ready', '2026-08-16T16:00:01.000Z')
    let injected = true
    const faulting = new SpawnTaskStore({
      workspaceRoot,
      workspaceId: 'workspace_spawn_test',
      faults: (point, task) => {
        if (point === 'before-current-publish' && task.dispatch.state === 'claimed' && injected) {
          injected = false
          throw new Error('claim publication interrupted')
        }
      },
    })
    let appendCalls = 0
    let providerCalls = 0
    const coordinator = new SpawnTaskCoordinator({
      store: faulting,
      createChild: async () => {},
      appendDelegatedPrompt: async () => {
        appendCalls += 1
      },
      dispatchProvider: () => {
        providerCalls += 1
      },
    })

    await coordinator.reconcileStartup({
      parentExists: () => true,
      findChild: () => ({ exists: true, matches: true }),
    })
    expect(faulting.get(ready.taskId)).toMatchObject({ dispatch: { state: 'ready' } })
    expect(appendCalls).toBe(0)
    expect(providerCalls).toBe(0)

    await coordinator.reconcileStartup({
      parentExists: () => true,
      findChild: () => ({ exists: true, matches: true }),
    })
    expect(faulting.get(ready.taskId)).toMatchObject({ runtimeState: 'processing', dispatch: { state: 'sent' } })
    expect(appendCalls).toBe(1)
    expect(providerCalls).toBe(1)
  })

  it('keeps recovery durable when task-update notification fails', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const initial = createStore(workspaceRoot)
    const reserved = initial.reserve({ parentSessionId: 'session_parent', delegatedPrompt: 'notification fault', childConfig: {} })
    initial.updateDispatch(reserved.taskId, 'ready', '2026-08-16T16:00:01.000Z')
    const store = createStore(workspaceRoot)
    let providerCalls = 0
    const coordinator = new SpawnTaskCoordinator({
      store,
      createChild: async () => {},
      appendDelegatedPrompt: async () => {},
      dispatchProvider: () => {
        providerCalls += 1
      },
      onTaskUpdated: async () => {
        throw new Error('notification unavailable')
      },
    })

    await coordinator.reconcileStartup({
      parentExists: () => true,
      findChild: () => ({ exists: true, matches: true }),
    })

    expect(providerCalls).toBe(1)
    expect(store.get(reserved.taskId)).toMatchObject({ runtimeState: 'processing', dispatch: { state: 'sent' } })
  })

  it('normalizes a synchronous recovery provider fault without replay', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const initial = createStore(workspaceRoot)
    const reserved = initial.reserve({ parentSessionId: 'session_parent', delegatedPrompt: 'provider fault', childConfig: {} })
    const ready = initial.updateDispatch(reserved.taskId, 'ready', '2026-08-16T16:00:01.000Z')
    const faulting = createStore(workspaceRoot)
    let providerCalls = 0
    const coordinator = new SpawnTaskCoordinator({
      store: faulting,
      createChild: async () => {},
      appendDelegatedPrompt: async () => {},
      dispatchProvider: () => {
        providerCalls += 1
        throw new Error('recovery provider unavailable')
      },
    })

    await coordinator.reconcileStartup({
      parentExists: () => true,
      findChild: () => ({ exists: true, matches: true }),
    })

    expect(providerCalls).toBe(1)
    expect(faulting.get(ready.taskId)).toMatchObject({
      runtimeState: 'failed',
      dispatch: { state: 'sent' },
      failure: { code: 'provider_error', details: { boundary: 'provider' } },
    })
  })

  it('records a bounded recovery failure when the sent commit is interrupted', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const initial = createStore(workspaceRoot)
    const reserved = initial.reserve({ parentSessionId: 'session_parent', delegatedPrompt: 'sent commit fault', childConfig: {} })
    const ready = initial.updateDispatch(reserved.taskId, 'ready', '2026-08-16T16:00:01.000Z')
    let injected = true
    const faulting = new SpawnTaskStore({
      workspaceRoot,
      workspaceId: 'workspace_spawn_test',
      faults: (point, task) => {
        if (point === 'before-current-publish' && task.dispatch.state === 'sent' && injected) {
          injected = false
          throw new Error('sent publication interrupted')
        }
      },
    })
    let providerCalls = 0
    const coordinator = new SpawnTaskCoordinator({
      store: faulting,
      createChild: async () => {},
      appendDelegatedPrompt: async () => {},
      dispatchProvider: () => {
        providerCalls += 1
      },
    })

    await coordinator.reconcileStartup({
      parentExists: () => true,
      findChild: () => ({ exists: true, matches: true }),
    })

    expect(providerCalls).toBe(0)
    expect(faulting.get(ready.taskId)).toMatchObject({
      runtimeState: 'failed',
      dispatch: { state: 'claimed' },
      failure: { code: 'spawn_persist_failed', details: { boundary: 'sent' } },
    })
  })

  it('clears active dispatch after a post-claim failure publication fault', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    let failurePublicationFault = true
    const store = createStore(workspaceRoot, (point, task) => {
      if (point === 'before-current-publish' && task.runtimeState === 'failed' && failurePublicationFault) {
        failurePublicationFault = false
        throw new Error('failure publication interrupted')
      }
    })
    const updates: Array<{ taskId: string; version: number }> = []
    let providerCalls = 0
    const coordinator = new SpawnTaskCoordinator({
      store,
      createChild: async () => {},
      appendDelegatedPrompt: async () => {
        throw new Error('append failed after claim')
      },
      dispatchProvider: () => {
        providerCalls += 1
      },
      onTaskUpdated: (change) => {
        updates.push(change)
      },
    })

    await expect(coordinator.spawn({
      parentSessionId: 'session_parent',
      delegatedPrompt: 'do not hide this failed claim',
      childConfig: {},
    })).rejects.toThrow('append failed after claim')

    const afterFailure = store.listAll()[0]
    expect(afterFailure?.dispatch.state).toBe('claimed')
    expect(afterFailure?.runtimeState).toBe('queued')

    await coordinator.reconcileStartup({
      parentExists: () => true,
      findChild: () => ({ exists: true, matches: true }),
    })

    const interrupted = store.get(afterFailure!.taskId)!
    expect(interrupted).toMatchObject({
      runtimeState: 'failed',
      failure: {
        code: 'dispatch_interrupted',
        retryable: true,
      },
    })
    expect(providerCalls).toBe(0)
    expect(updates.at(-1)).toEqual({ taskId: interrupted.taskId, version: interrupted.version })
  })

  it('clears active recovery claims after failure publication faults', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const initial = createStore(workspaceRoot)
    const reserved = initial.reserve({
      parentSessionId: 'session_parent',
      delegatedPrompt: 'recover without hiding the failed claim',
      childConfig: {},
    })
    const ready = initial.updateDispatch(reserved.taskId, 'ready', '2026-08-16T16:00:01.000Z')
    let failurePublicationFault = true
    const store = new SpawnTaskStore({
      workspaceRoot,
      workspaceId: 'workspace_spawn_test',
      faults: (point, task) => {
        if (point === 'before-current-publish' && task.runtimeState === 'failed' && failurePublicationFault) {
          failurePublicationFault = false
          throw new Error('recovery failure publication interrupted')
        }
      },
    })
    const updates: Array<{ taskId: string; version: number }> = []
    let providerCalls = 0
    const coordinator = new SpawnTaskCoordinator({
      store,
      createChild: async () => {},
      appendDelegatedPrompt: async () => {
        throw new Error('recovery append failed after claim')
      },
      dispatchProvider: () => {
        providerCalls += 1
      },
      onTaskUpdated: (change) => {
        updates.push(change)
      },
    })

    await coordinator.reconcileStartup({
      parentExists: () => true,
      findChild: () => ({ exists: true, matches: true }),
    })

    const afterFailure = store.get(ready.taskId)!
    expect(afterFailure).toMatchObject({
      runtimeState: 'queued',
      dispatch: { state: 'claimed' },
    })

    await coordinator.reconcileStartup({
      parentExists: () => true,
      findChild: () => ({ exists: true, matches: true }),
    })

    const interrupted = store.get(ready.taskId)!
    expect(interrupted).toMatchObject({
      runtimeState: 'failed',
      failure: {
        code: 'dispatch_interrupted',
        retryable: true,
      },
    })
    expect(providerCalls).toBe(0)
    expect(updates.at(-1)).toEqual({ taskId: interrupted.taskId, version: interrupted.version })
  })

  it('keeps concurrent children independent through recovery and terminal outcomes', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const store = createStore(workspaceRoot)
    const first = store.reserve({ parentSessionId: 'session_parent', delegatedPrompt: 'first child', childConfig: { model: 'one' } })
    const second = store.reserve({ parentSessionId: 'session_parent', delegatedPrompt: 'second child', childConfig: { model: 'two' } })
    const dispatched: string[] = []
    const coordinator = new SpawnTaskCoordinator({
      store,
      createChild: async () => {},
      appendDelegatedPrompt: async () => {},
      dispatchProvider: ({ task }) => {
        dispatched.push(task.taskId)
      },
    })

    await coordinator.reconcileStartup({
      parentExists: () => true,
      findChild: () => ({ exists: true, matches: true }),
    })
    const firstProcessing = store.get(first.taskId)!
    const secondProcessing = store.get(second.taskId)!
    expect(dispatched.sort()).toEqual([first.taskId, second.taskId].sort())
    expect(first.dispatch.messageId).not.toBe(second.dispatch.messageId)
    expect(first.dispatch.dispatchAttemptId).not.toBe(second.dispatch.dispatchAttemptId)

    const completed = await coordinator.finalizeResultForChildSession(first.childSessionId, 'first result')
    const cancelled = await coordinator.cancelChildSession(second.childSessionId, 'second cancelled')

    expect(completed).toMatchObject({ runtimeState: 'completed', result: { preview: 'first result' } })
    expect(cancelled).toMatchObject({ status: 'cancelled', task: { runtimeState: 'cancelled' } })
    expect(store.get(firstProcessing.taskId)?.runtimeState).toBe('completed')
    expect(store.get(secondProcessing.taskId)?.runtimeState).toBe('cancelled')
    expect(store.get(firstProcessing.taskId)?.version).toBeGreaterThan(firstProcessing.version)
    expect(store.get(secondProcessing.taskId)?.version).toBeGreaterThan(secondProcessing.version)
  })

  it('interrupts sent and processing work after restart and audits later events', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const store = createStore(workspaceRoot)
    const reserved = store.reserve({ parentSessionId: 'session_parent', delegatedPrompt: 'sent before stop', childConfig: {} })
    const ready = store.updateDispatch(reserved.taskId, 'ready', '2026-08-16T16:00:01.000Z')
    const claimed = store.updateDispatch(ready.taskId, 'claimed', '2026-08-16T16:00:02.000Z')
    const sent = store.updateDispatch(claimed.taskId, 'sent', '2026-08-16T16:00:03.000Z')
    const processing = store.transition(sent.taskId, { runtimeState: 'processing', at: '2026-08-16T16:00:04.000Z' })
    const audits: string[] = []
    let providerCalls = 0
    const coordinator = new SpawnTaskCoordinator({
      store,
      createChild: async () => {},
      appendDelegatedPrompt: async () => {
        throw new Error('sent work must not append again')
      },
      dispatchProvider: () => {
        providerCalls += 1
      },
      onLateEvent: ({ eventKind, currentState }) => {
        audits.push(`${currentState}:${eventKind}`)
      },
    })

    await coordinator.reconcileStartup({
      parentExists: () => true,
      findChild: () => ({ exists: true, matches: true }),
    })

    expect(providerCalls).toBe(0)
    expect(store.get(processing.taskId)).toMatchObject({
      runtimeState: 'failed',
      failure: { code: 'dispatch_interrupted', retryable: true },
    })
    expect(coordinator.recordLateEventForChildSession(processing.childSessionId, 'complete')).toBe(true)
    expect(audits).toEqual(['failed:complete'])
    await coordinator.reconcileStartup({
      parentExists: () => true,
      findChild: () => ({ exists: true, matches: true }),
    })
    expect(audits).toEqual(['failed:complete'])
  })

  it('reconstructs a failed task from a surviving child back-reference without dispatch', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const store = createStore(workspaceRoot)
    const updates: Array<{ taskId: string; version: number }> = []
    let providerCalls = 0
    const reference = {
      taskId: 'task_missing_record',
      parentSessionId: 'session_parent',
      childSessionId: 'session_orphan_child',
      delegatedPrompt: 'preserve this child history',
      childConfig: { model: 'fixture' },
      messageId: 'message_missing_record',
      dispatchAttemptId: 'attempt_missing_record',
    }
    const coordinator = new SpawnTaskCoordinator({
      store,
      createChild: async () => {
        throw new Error('reconstruction must not create a child')
      },
      appendDelegatedPrompt: async () => {
        throw new Error('reconstruction must not append')
      },
      dispatchProvider: () => {
        providerCalls += 1
      },
      onTaskUpdated: (change) => {
        updates.push(change)
      },
    })

    await coordinator.reconcileStartup({
      parentExists: () => true,
      findChild: () => ({ exists: true, matches: true, reference }),
      listChildren: () => [reference],
    })

    expect(providerCalls).toBe(0)
    expect(store.get(reference.taskId)).toMatchObject({
      taskId: reference.taskId,
      childSessionId: reference.childSessionId,
      runtimeState: 'failed',
      delegatedPrompt: reference.delegatedPrompt,
      failure: {
        code: 'spawn_persist_failed',
        details: { boundary: 'recovery' },
      },
    })
    expect(updates).toEqual([{ taskId: reference.taskId, version: 1 }])
  })

  it('cancels pre-dispatch recovery after parent deletion without creating or dispatching', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const store = createStore(workspaceRoot)
    const reserved = store.reserve({ parentSessionId: 'session_deleted_parent', delegatedPrompt: 'reserved', childConfig: {} })
    const readyBase = store.reserve({ parentSessionId: 'session_deleted_parent', delegatedPrompt: 'ready', childConfig: {} })
    const ready = store.updateDispatch(readyBase.taskId, 'ready', '2026-08-16T16:00:01.000Z')
    const claimedBase = store.reserve({ parentSessionId: 'session_deleted_parent', delegatedPrompt: 'claimed', childConfig: {} })
    const claimedReady = store.updateDispatch(claimedBase.taskId, 'ready', '2026-08-16T16:00:01.000Z')
    const claimed = store.updateDispatch(claimedReady.taskId, 'claimed', '2026-08-16T16:00:02.000Z')
    const existingChildBase = store.reserve({ parentSessionId: 'session_deleted_parent', delegatedPrompt: 'existing child', childConfig: {} })
    const existingChild = store.updateDispatch(existingChildBase.taskId, 'ready', '2026-08-16T16:00:01.000Z')
    const parentTaskIds = [reserved.taskId, ready.taskId, claimed.taskId, existingChild.taskId]
    let createCalls = 0
    let providerCalls = 0
    const coordinator = new SpawnTaskCoordinator({
      store,
      createChild: async () => {
        createCalls += 1
      },
      appendDelegatedPrompt: async () => {
        throw new Error('deleted parent must not append')
      },
      dispatchProvider: () => {
        providerCalls += 1
      },
    })

    await coordinator.reconcileStartup({
      parentExists: () => false,
      findChild: (task) => ({
        exists: task.taskId === existingChild.taskId,
        matches: task.taskId === existingChild.taskId,
      }),
    })

    expect(createCalls).toBe(0)
    expect(providerCalls).toBe(0)
    for (const taskId of parentTaskIds) {
      expect(store.get(taskId)).toMatchObject({
        runtimeState: 'cancelled',
        cancellation: { reason: 'parent_deleted' },
        parentDeletedAt: expect.any(String),
      })
    }
  })

  it('transitions a child through permission awaiting-input and resume', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const store = createStore(workspaceRoot)
    const reserved = store.reserve({
      parentSessionId: 'session_parent',
      delegatedPrompt: 'await permission',
      childConfig: {},
    })
    const processing = store.transition(reserved.taskId, {
      runtimeState: 'processing',
      at: '2026-08-16T16:00:00.000Z',
    })
    const updates: string[] = []
    const coordinator = new SpawnTaskCoordinator({
      store,
      createChild: async () => {},
      appendDelegatedPrompt: async () => {},
      dispatchProvider: () => {},
      onTaskUpdated: ({ taskId }) => {
        updates.push(taskId)
      },
    })

    const awaiting = await coordinator.awaitInputForChildSession(processing.childSessionId, {
      kind: 'permission',
      requestId: 'permission_request_1',
      promptSummary: 'Allow the Bash tool to run?',
      createdAt: '2026-08-16T16:01:00.000Z',
    })
    expect(awaiting).toMatchObject({
      runtimeState: 'awaiting-input',
      awaitingInput: {
        kind: 'permission',
        requestId: 'permission_request_1',
        promptSummary: 'Allow the Bash tool to run?',
      },
    })

    const resumed = await coordinator.resumeAwaitingInputForChildSession(
      processing.childSessionId,
      'permission_request_1',
    )
    expect(resumed).toMatchObject({ runtimeState: 'processing' })
    expect(resumed?.awaitingInput).toBeUndefined()
    expect(updates).toEqual([processing.taskId, processing.taskId])
  })

  it('interrupts authentication awaiting-input with the original kind', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const store = createStore(workspaceRoot)
    const reserved = store.reserve({
      parentSessionId: 'session_parent',
      delegatedPrompt: 'await authentication',
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

    await coordinator.awaitInputForChildSession(processing.childSessionId, {
      kind: 'authentication',
      requestId: 'auth_request_1',
      promptSummary: 'Authenticate with the configured source.',
      createdAt: '2026-08-16T16:01:00.000Z',
    })
    const failed = await coordinator.interruptAwaitingInputForChildSession(
      processing.childSessionId,
      'Authentication flow ended before resume.',
    )

    expect(failed).toMatchObject({
      runtimeState: 'failed',
      failure: {
        code: 'input_interrupted',
        retryable: true,
        details: { kind: 'authentication' },
      },
    })
    expect(updates).toHaveLength(2)
    expect(updates[1]?.version).toBe(failed!.version)
  })

  it('notifies startup interruption for persisted permission and authentication waits', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const initial = createStore(workspaceRoot)
    const taskIds: string[] = []
    for (const [index, kind] of (['permission', 'authentication'] as const).entries()) {
      const reserved = initial.reserve({
        parentSessionId: 'session_parent',
        delegatedPrompt: `await ${kind}`,
        childConfig: {},
      })
      const processing = initial.transition(reserved.taskId, {
        runtimeState: 'processing',
        at: '2026-08-16T16:00:00.000Z',
      })
      await new SpawnTaskCoordinator({
        store: initial,
        createChild: async () => {},
        appendDelegatedPrompt: async () => {},
        dispatchProvider: () => {},
      }).awaitInputForChildSession(processing.childSessionId, {
        kind,
        requestId: `${kind}_request_${index}`,
        promptSummary: `${kind} input`,
        createdAt: '2026-08-16T16:01:00.000Z',
      })
      taskIds.push(processing.taskId)
    }

    const restarted = createStore(workspaceRoot)
    const updates: string[] = []
    const coordinator = new SpawnTaskCoordinator({
      store: restarted,
      createChild: async () => {},
      appendDelegatedPrompt: async () => {},
      dispatchProvider: () => {},
      onTaskUpdated: ({ taskId }) => {
        expect(restarted.get(taskId)).toMatchObject({
          runtimeState: 'failed',
          failure: { code: 'input_interrupted' },
        })
        updates.push(taskId)
      },
    })
    await coordinator.waitForStartupNotification()

    expect(updates.sort()).toEqual(taskIds.sort())
    for (const taskId of taskIds) {
      expect(restarted.get(taskId)?.failure?.code).toBe('input_interrupted')
    }
  })

  it('cancels an active child after durable request and abort', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const store = createStore(workspaceRoot)
    const reserved = store.reserve({
      parentSessionId: 'session_parent',
      delegatedPrompt: 'cancel this work',
      childConfig: {},
    })
    const processing = store.transition(reserved.taskId, {
      runtimeState: 'processing',
      at: '2026-08-16T16:00:00.000Z',
    })
    let abortCalls = 0
    const coordinator = new SpawnTaskCoordinator({
      store,
      createChild: async () => {},
      appendDelegatedPrompt: async () => {},
      dispatchProvider: () => {},
    })

    const result = await coordinator.cancelChildSession(processing.childSessionId, 'user_requested', {
      abort: () => {
        abortCalls += 1
      },
    })

    expect(result.status).toBe('cancelled')
    expect(result.task).toMatchObject({
      runtimeState: 'cancelled',
      cancellation: { reason: 'user_requested' },
    })
    expect(abortCalls).toBe(1)
  })

  it('cancels active child deletion and preserves terminal results', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const store = createStore(workspaceRoot)
    const activeReserved = store.reserve({ parentSessionId: 'session_parent', delegatedPrompt: 'active child', childConfig: {} })
    const active = store.transition(activeReserved.taskId, { runtimeState: 'processing', at: '2026-08-16T16:00:00.000Z' })
    const terminalReserved = store.reserve({ parentSessionId: 'session_parent', delegatedPrompt: 'terminal child', childConfig: {} })
    const terminalProcessing = store.transition(terminalReserved.taskId, { runtimeState: 'processing', at: '2026-08-16T16:00:00.000Z' })
    const terminal = store.commitResult(terminalProcessing.taskId, 'survives deletion', { committedAt: '2026-08-16T16:00:01.000Z' })
    const coordinator = new SpawnTaskCoordinator({
      store,
      createChild: async () => {},
      appendDelegatedPrompt: async () => {},
      dispatchProvider: () => {},
    })
    let cleanupCalls = 0

    const activeDeleted = await coordinator.markChildDeleted(active.childSessionId, {
      abort: () => {
        throw new Error('child abort failed')
      },
      cleanup: () => {
        cleanupCalls += 1
      },
    })
    const terminalDeleted = await coordinator.markChildDeleted(terminal.childSessionId)

    expect(activeDeleted).toMatchObject({
      runtimeState: 'failed',
      failure: { code: 'cancel_failed' },
      childDeletedAt: expect.any(String),
    })
    expect(cleanupCalls).toBe(1)
    expect(terminalDeleted).toMatchObject({
      runtimeState: 'completed',
      childDeletedAt: expect.any(String),
      result: { byteLength: Buffer.byteLength('survives deletion', 'utf8') },
    })
    expect(store.get(terminal.taskId)?.result).toBeDefined()
  })

  it('returns already_terminal without mutating or notifying terminal cancellation', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const store = createStore(workspaceRoot)
    const reserved = store.reserve({
      parentSessionId: 'session_parent',
      delegatedPrompt: 'already done',
      childConfig: {},
    })
    const processing = store.transition(reserved.taskId, {
      runtimeState: 'processing',
      at: '2026-08-16T16:00:00.000Z',
    })
    const completed = store.commitResult(processing.taskId, 'done', { committedAt: '2026-08-16T16:01:00.000Z' })
    let updates = 0
    const coordinator = new SpawnTaskCoordinator({
      store,
      createChild: async () => {},
      appendDelegatedPrompt: async () => {},
      dispatchProvider: () => {},
      onTaskUpdated: () => {
        updates += 1
      },
    })

    const result = await coordinator.cancelChildSession(completed.childSessionId, 'too late')

    expect(result).toEqual({ status: 'already_terminal', task: completed })
    expect(store.get(completed.taskId)).toEqual(completed)
    expect(updates).toBe(0)
  })

  it('stops pre-dispatch spawn after parent deletion and preserves published child', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const store = createStore(workspaceRoot)
    let coordinator!: SpawnTaskCoordinator
    let childCalls = 0
    let appendCalls = 0
    let providerCalls = 0
    coordinator = new SpawnTaskCoordinator({
      store,
      createChild: async () => {
        childCalls += 1
        await coordinator.markParentDeleted('session_parent')
      },
      appendDelegatedPrompt: async () => {
        appendCalls += 1
      },
      dispatchProvider: () => {
        providerCalls += 1
      },
    })

    const result = await coordinator.spawn({
      parentSessionId: 'session_parent',
      delegatedPrompt: 'parent can be deleted during publication',
      childConfig: {},
    })

    expect(result.runtimeState).toBe('cancelled')
    expect(childCalls).toBe(1)
    expect(appendCalls).toBe(0)
    expect(providerCalls).toBe(0)
    expect(store.get(result.taskId)).toMatchObject({
      runtimeState: 'cancelled',
      cancellation: { reason: 'parent_deleted' },
      parentDeletedAt: expect.any(String),
    })
  })

  it('rejects new spawn work after a parent deletion tombstone', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const store = createStore(workspaceRoot)
    let childCalls = 0
    const coordinator = new SpawnTaskCoordinator({
      store,
      createChild: async () => {
        childCalls += 1
      },
      appendDelegatedPrompt: async () => {},
      dispatchProvider: () => {},
    })

    await coordinator.markParentDeleted('session_parent')
    const result = await coordinator.spawn({
      parentSessionId: 'session_parent',
      delegatedPrompt: 'must not spawn after deletion',
      childConfig: {},
    })

    expect(result.runtimeState).toBe('cancelled')
    expect(childCalls).toBe(0)
    expect(store.get(result.taskId)).toMatchObject({
      runtimeState: 'cancelled',
      cancellation: { reason: 'parent_deleted' },
      parentDeletedAt: expect.any(String),
    })
  })

  it('rechecks durable parent deletion before a stale coordinator dispatches', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const managerOneStore = createStore(workspaceRoot)
    const managerTwoStore = createStore(workspaceRoot)
    const managerOne = new SpawnTaskCoordinator({
      store: managerOneStore,
      createChild: async () => {},
      appendDelegatedPrompt: async () => {},
      dispatchProvider: () => {},
    })
    let childCalls = 0
    let providerCalls = 0
    const managerTwo = new SpawnTaskCoordinator({
      store: managerTwoStore,
      createChild: async () => {
        childCalls += 1
      },
      appendDelegatedPrompt: async () => {},
      dispatchProvider: () => {
        providerCalls += 1
      },
    })

    await managerOne.markParentDeleted('session_deleted_before_manager_two_spawn')
    const result = await managerTwo.spawn({
      parentSessionId: 'session_deleted_before_manager_two_spawn',
      delegatedPrompt: 'must not dispatch after another manager deletes parent',
      childConfig: {},
    })

    expect(childCalls).toBe(0)
    expect(providerCalls).toBe(0)
    expect(result.runtimeState).toBe('cancelled')
    expect(managerTwoStore.get(result.taskId)).toMatchObject({
      runtimeState: 'cancelled',
      cancellation: { reason: 'parent_deleted' },
    })
  })

  it('persists an empty parent deletion boundary across coordinator restart', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const initial = createStore(workspaceRoot)
    const first = new SpawnTaskCoordinator({
      store: initial,
      createChild: async () => {},
      appendDelegatedPrompt: async () => {},
      dispatchProvider: () => {},
    })
    await first.markParentDeleted('session_never_spawned')

    const restartedStore = createStore(workspaceRoot)
    expect(restartedStore.isParentDeleted('session_never_spawned')).toBe(true)
    let childCalls = 0
    const restarted = new SpawnTaskCoordinator({
      store: restartedStore,
      createChild: async () => {
        childCalls += 1
      },
      appendDelegatedPrompt: async () => {},
      dispatchProvider: () => {},
    })
    const result = await restarted.spawn({
      parentSessionId: 'session_never_spawned',
      delegatedPrompt: 'must stay cancelled',
      childConfig: {},
    })

    expect(childCalls).toBe(0)
    expect(result.runtimeState).toBe('cancelled')
    expect(restartedStore.get(result.taskId)).toMatchObject({
      runtimeState: 'cancelled',
      cancellation: { reason: 'parent_deleted' },
    })
  })

  it('restores the parent deletion boundary after coordinator restart', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const initial = createStore(workspaceRoot)
    const existing = initial.reserve({ parentSessionId: 'session_parent', delegatedPrompt: 'existing', childConfig: {} })
    const initialCoordinator = new SpawnTaskCoordinator({
      store: initial,
      createChild: async () => {},
      appendDelegatedPrompt: async () => {},
      dispatchProvider: () => {},
    })
    await initialCoordinator.markParentDeleted('session_parent')
    expect(initial.get(existing.taskId)?.parentDeletedAt).toBeDefined()

    const restarted = createStore(workspaceRoot)
    let childCalls = 0
    const restartedCoordinator = new SpawnTaskCoordinator({
      store: restarted,
      createChild: async () => {
        childCalls += 1
      },
      appendDelegatedPrompt: async () => {},
      dispatchProvider: () => {},
    })
    const result = await restartedCoordinator.spawn({
      parentSessionId: 'session_parent',
      delegatedPrompt: 'must remain blocked after restart',
      childConfig: {},
    })

    expect(result.runtimeState).toBe('cancelled')
    expect(childCalls).toBe(0)
    expect(restarted.get(result.taskId)).toMatchObject({
      runtimeState: 'cancelled',
      cancellation: { reason: 'parent_deleted' },
    })
  })

  it('marks parent deletion and cancels only pre-dispatch work', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const store = createStore(workspaceRoot)
    const parentSessionId = 'session_deleted_parent'
    const reserve = (prompt: string) => store.reserve({ parentSessionId, delegatedPrompt: prompt, childConfig: {} })
    const reserved = reserve('reserved')
    const readyBase = reserve('ready')
    const ready = store.updateDispatch(readyBase.taskId, 'ready', '2026-08-16T16:00:01.000Z')
    const claimedBase = reserve('claimed')
    const claimedReady = store.updateDispatch(claimedBase.taskId, 'ready', '2026-08-16T16:00:01.000Z')
    const claimed = store.updateDispatch(claimedReady.taskId, 'claimed', '2026-08-16T16:00:02.000Z')
    const sentBase = reserve('sent')
    const sentReady = store.updateDispatch(sentBase.taskId, 'ready', '2026-08-16T16:00:01.000Z')
    const sentClaimed = store.updateDispatch(sentReady.taskId, 'claimed', '2026-08-16T16:00:02.000Z')
    const sent = store.updateDispatch(sentClaimed.taskId, 'sent', '2026-08-16T16:00:03.000Z')
    const processing = store.transition(sent.taskId, { runtimeState: 'processing', at: '2026-08-16T16:00:04.000Z' })
    const terminalBase = reserve('terminal')
    const terminalProcessing = store.transition(terminalBase.taskId, {
      runtimeState: 'processing',
      at: '2026-08-16T16:00:03.000Z',
    })
    const terminal = store.commitResult(terminalProcessing.taskId, 'retained', { committedAt: '2026-08-16T16:00:04.000Z' })
    const coordinator = new SpawnTaskCoordinator({
      store,
      createChild: async () => {},
      appendDelegatedPrompt: async () => {},
      dispatchProvider: () => {},
    })

    const changed = await coordinator.markParentDeleted(parentSessionId)

    expect(changed).toHaveLength(5)
    expect(store.get(reserved.taskId)).toMatchObject({
      runtimeState: 'cancelled',
      cancellation: { reason: 'parent_deleted' },
      parentDeletedAt: expect.any(String),
    })
    expect(store.get(ready.taskId)).toMatchObject({ runtimeState: 'cancelled', cancellation: { reason: 'parent_deleted' } })
    expect(store.get(claimed.taskId)).toMatchObject({ runtimeState: 'cancelled', cancellation: { reason: 'parent_deleted' } })
    expect(store.get(processing.taskId)).toMatchObject({ runtimeState: 'processing', parentDeletedAt: expect.any(String) })
    expect(store.get(terminal.taskId)).toMatchObject({ runtimeState: 'completed', parentDeletedAt: expect.any(String) })
  })

  it('serializes concurrent cancellation attempts behind one durable CAS operation', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const store = createStore(workspaceRoot)
    const reserved = store.reserve({
      parentSessionId: 'session_parent',
      delegatedPrompt: 'concurrent cancellation',
      childConfig: {},
    })
    const processing = store.transition(reserved.taskId, {
      runtimeState: 'processing',
      at: '2026-08-16T16:00:00.000Z',
    })
    let releaseAbort!: () => void
    const abortReleased = new Promise<void>((resolve) => {
      releaseAbort = resolve
    })
    let abortCalls = 0
    const coordinator = new SpawnTaskCoordinator({
      store,
      createChild: async () => {},
      appendDelegatedPrompt: async () => {},
      dispatchProvider: () => {},
    })
    const runtime = {
      abort: async () => {
        abortCalls += 1
        await abortReleased
      },
    }

    const first = coordinator.cancelChildSession(processing.childSessionId, 'first_reason', runtime)
    const second = coordinator.cancelChildSession(processing.childSessionId, 'second_reason', {
      abort: () => {
        throw new Error('the second abort must not run')
      },
    })
    await Promise.resolve()
    releaseAbort()

    const results = await Promise.all([first, second])

    expect(results[0]).toEqual(results[1])
    expect(results[0]).toMatchObject({
      status: 'cancelled',
      task: {
        runtimeState: 'cancelled',
        cancellation: { reason: 'first_reason' },
      },
    })
    expect(abortCalls).toBe(1)
  })

  it('commits cancel_failed and runs cleanup when abort throws', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(workspaceRoot)
    const store = createStore(workspaceRoot)
    const reserved = store.reserve({
      parentSessionId: 'session_parent',
      delegatedPrompt: 'abort failure',
      childConfig: {},
    })
    const processing = store.transition(reserved.taskId, {
      runtimeState: 'processing',
      at: '2026-08-16T16:00:00.000Z',
    })
    let cleanupCalls = 0
    const coordinator = new SpawnTaskCoordinator({
      store,
      createChild: async () => {},
      appendDelegatedPrompt: async () => {},
      dispatchProvider: () => {},
    })

    const result = await coordinator.cancelChildSession(processing.childSessionId, 'user_requested', {
      abort: () => {
        throw new Error('abort failed')
      },
      cleanup: () => {
        cleanupCalls += 1
      },
    })

    expect(result.status).toBe('cancel_failed')
    expect(result.task).toMatchObject({
      runtimeState: 'failed',
      failure: { code: 'cancel_failed', retryable: false },
    })
    expect(cleanupCalls).toBe(1)
  })

  it('keeps deterministic completion/failure versus cancellation race winners', async () => {
    const root = mkdtempSync(join(tmpdir(), 'spawn-coordinator-'))
    roots.push(root)
    const store = createStore(root)
    const makeProcessing = (prompt: string) => {
      const reserved = store.reserve({ parentSessionId: 'session_parent', delegatedPrompt: prompt, childConfig: {} })
      return store.transition(reserved.taskId, {
        runtimeState: 'processing',
        at: '2026-08-16T16:00:00.000Z',
      })
    }
    const updates: string[] = []
    const audits: string[] = []
    let coordinator!: SpawnTaskCoordinator
    coordinator = new SpawnTaskCoordinator({
      store,
      createChild: async () => {},
      appendDelegatedPrompt: async () => {},
      dispatchProvider: () => {},
      onTaskUpdated: ({ taskId }) => {
        updates.push(taskId)
      },
      onLateEvent: ({ taskId, eventKind }) => {
        audits.push(`${taskId}:${eventKind}`)
      },
    })

    const completionFirst = makeProcessing('completion first')
    const completionRace = await coordinator.cancelChildSession(completionFirst.childSessionId, 'race', {
      abort: async () => {
        await coordinator.finalizeResultForChildSession(completionFirst.childSessionId, 'winner')
      },
    })
    expect(completionRace.status).toBe('already_terminal')
    expect(completionRace.task?.runtimeState).toBe('completed')

    const failureFirst = makeProcessing('failure first')
    const failureRace = await coordinator.cancelChildSession(failureFirst.childSessionId, 'race', {
      abort: async () => {
        await coordinator.finalizeProviderFailureForChildSession(failureFirst.childSessionId, 'winner')
      },
    })
    expect(failureRace.status).toBe('already_terminal')
    expect(failureRace.task?.runtimeState).toBe('failed')

    const cancelBeforeCompletion = makeProcessing('cancel before completion')
    const cancelledCompletion = await coordinator.cancelChildSession(cancelBeforeCompletion.childSessionId, 'race')
    expect(cancelledCompletion.status).toBe('cancelled')
    const updatesAfterCompletionCancel = updates.length
    await coordinator.finalizeResultForChildSession(cancelBeforeCompletion.childSessionId, 'late result')
    expect(updates.length).toBe(updatesAfterCompletionCancel)

    const cancelBeforeFailure = makeProcessing('cancel before failure')
    const cancelledFailure = await coordinator.cancelChildSession(cancelBeforeFailure.childSessionId, 'race')
    expect(cancelledFailure.status).toBe('cancelled')
    const updatesAfterFailureCancel = updates.length
    await coordinator.finalizeProviderFailureForChildSession(cancelBeforeFailure.childSessionId, 'late failure')
    expect(updates.length).toBe(updatesAfterFailureCancel)

    expect(audits).toEqual([
      `${cancelBeforeCompletion.taskId}:result`,
      `${cancelBeforeFailure.taskId}:provider_error`,
    ])
  })

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
    const updates: string[] = []
    let notificationStarted = false
    let releaseNotification!: () => void
    const notificationReleased = new Promise<void>((resolve) => {
      releaseNotification = resolve
    })

    const coordinator = new SpawnTaskCoordinator({
      store,
      createChild: async () => {},
      appendDelegatedPrompt: async () => {
        appendCalls += 1
      },
      dispatchProvider: () => {
        providerCalls += 1
      },
      onTaskUpdated: async (change) => {
        notificationStarted = true
        await notificationReleased
        updates.push('task-updated')
        expect(store.get(change.taskId)).toMatchObject({ runtimeState: 'failed' })
      },
    })

    await coordinator.waitForStartupNotification()
    let spawnRejected = false
    const spawn = coordinator.spawn({
      parentSessionId: 'session_parent',
      delegatedPrompt: 'claim before dispatch',
      childConfig: {},
    }).catch((error) => {
      spawnRejected = true
      throw error
    })
    for (let attempt = 0; attempt < 20 && !notificationStarted; attempt++) {
      await Promise.resolve()
    }
    expect(notificationStarted).toBe(true)
    await Promise.resolve()
    expect(spawnRejected).toBe(false)
    releaseNotification()
    await expect(spawn).rejects.toMatchObject({
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
    expect(updates).toEqual(['task-updated'])
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
