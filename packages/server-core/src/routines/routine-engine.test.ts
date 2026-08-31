import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RoutineStore } from '@kata-sh/shared/routines'
import type { RoutineRevision, RoutineRun, ToolInvocation } from '@kata-sh/core'
import { RoutineEngine, type RoutineExecutionResult, type RoutineExecutor } from './routine-engine'

const roots: string[] = []
const at = '2026-08-31T00:00:00.000Z'

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function workspace(): string { const root = mkdtempSync(join(tmpdir(), 'routine-engine-')); roots.push(root); return root }
function input(trigger: RoutineRevision['trigger'], failurePolicy: RoutineRevision['failurePolicy'] = 'uncertain') {
  return {
    ownerBotId: 'bot_1',
    name: 'Routine',
    trigger,
    input: 'Do the work.',
    expectedResult: 'Done.',
    approvalBoundary: 'ask' as const,
    failurePolicy,
    destination: { kind: 'direct' as const, chatId: 'chat_1' },
  }
}

function invocation(): ToolInvocation {
  return {
    workspaceId: 'ws_1', botId: 'bot_1', conversationId: 'chat_1', runtimeId: 'session_1',
    toolName: 'Bash', toolSchemaVersion: '1', normalizedInput: { command: 'echo ok' }, attempt: 1,
    target: { kind: 'shell', value: 'echo ok', fingerprint: 'fp_1' }, policyRevision: 'ask',
  }
}

class FakeExecutor implements RoutineExecutor {
  calls = 0
  next: RoutineExecutionResult = { kind: 'completed', reply: 'done' }
  responses: RoutineExecutionResult[] = []
  async execute(_run: RoutineRun, _revision: RoutineRevision): Promise<RoutineExecutionResult> {
    this.calls += 1
    return this.responses.shift() ?? this.next
  }
}

describe('RoutineEngine', () => {
  it('deduplicates a narrow external event before execution', async () => {
    const executor = new FakeExecutor()
    const root = workspace()
    const store = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at })
    const routine = store.create(input({ kind: 'event', source: 'SessionStatusChange', matcher: { field: 'newState', equals: 'done' } }))
    const engine = new RoutineEngine({ workspaceRoot: root, workspaceId: 'ws_1', store, execute: executor, clock: () => at })

    const first = await engine.ingestEvent({ source: 'SessionStatusChange', externalEventId: 'event_1', payload: { newState: 'done' } })
    const second = await engine.ingestEvent({ source: 'SessionStatusChange', externalEventId: 'event_1', payload: { newState: 'done' } })

    expect(first).toHaveLength(1)
    expect(second[0]?.runId).toBe(first[0]?.runId)
    expect(executor.calls).toBe(1)
    expect(engine.listRuns(routine.routineId)[0]?.state.kind).toBe('succeeded')
  })

  it('advances a durable schedule cursor and creates each missed occurrence once', async () => {
    let now = at
    const executor = new FakeExecutor()
    const root = workspace()
    const store = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => now })
    const routine = store.create(input({ kind: 'schedule', cron: '0 * * * *', timezone: 'UTC', dst: { gap: 'skip', fold: 'once' } }))
    const engine = new RoutineEngine({ workspaceRoot: root, workspaceId: 'ws_1', store, execute: executor, clock: () => now })

    now = '2026-08-31T02:00:00.000Z'
    await engine.tick(now)
    await engine.tick(now)

    expect(executor.calls).toBe(2)
    expect(engine.listRuns(routine.routineId)).toHaveLength(2)
    expect(store.getScheduleCursor(routine.routineId, 1)).toBe('2026-08-31T02:00:00.000Z')
  })

  it('honors retry and uncertain failure policies with a durable attempt count', async () => {
    const root = workspace()
    const executor = new FakeExecutor()
    executor.responses = [{ kind: 'failed', error: 'temporary' }, { kind: 'completed', reply: 'done' }]
    const store = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at })
    const routine = store.create(input({ kind: 'on-demand' }, 'retry'))
    const engine = new RoutineEngine({ workspaceRoot: root, workspaceId: 'ws_1', store, execute: executor, clock: () => at })

    const result = await engine.testRoutine(routine.routineId)

    expect(executor.calls).toBe(2)
    expect(result.state.kind).toBe('succeeded')
    expect(result.attempt).toBe(2)

    const uncertainExecutor = new FakeExecutor()
    uncertainExecutor.next = { kind: 'failed', error: 'ambiguous' }
    const uncertainRoot = workspace()
    const uncertainStore = new RoutineStore({ workspaceRoot: uncertainRoot, workspaceId: 'ws_1', clock: () => at })
    const uncertainRoutine = uncertainStore.create(input({ kind: 'on-demand' }, 'uncertain'))
    const uncertainEngine = new RoutineEngine({ workspaceRoot: uncertainRoot, workspaceId: 'ws_1', store: uncertainStore, execute: uncertainExecutor, clock: () => at })
    const uncertain = await uncertainEngine.testRoutine(uncertainRoutine.routineId)
    expect(uncertain.state.kind).toBe('uncertain')

    const noReplayExecutor = new FakeExecutor()
    noReplayExecutor.responses = [{ kind: 'uncertain', reason: 'provider outcome is ambiguous' }, { kind: 'completed', reply: 'must not replay' }]
    const noReplayRoot = workspace()
    const noReplayStore = new RoutineStore({ workspaceRoot: noReplayRoot, workspaceId: 'ws_1', clock: () => at })
    const noReplayRoutine = noReplayStore.create(input({ kind: 'on-demand' }, 'retry'))
    const noReplayEngine = new RoutineEngine({ workspaceRoot: noReplayRoot, workspaceId: 'ws_1', store: noReplayStore, execute: noReplayExecutor, clock: () => at })
    const noReplay = await noReplayEngine.testRoutine(noReplayRoutine.routineId)
    expect(noReplayExecutor.calls).toBe(1)
    expect(noReplay.state.kind).toBe('uncertain')
  })

  it('follows up the original dispatch when approval resolves before it returns', async () => {
    const root = workspace()
    let releaseGate!: () => void
    const gate = new Promise<void>(resolve => { releaseGate = resolve })
    let calls = 0
    const approval = invocation()
    const executor: RoutineExecutor = {
      async execute() {
        calls += 1
        if (calls === 1) {
          await gate
          return { kind: 'awaiting-approval', approvalId: 'approval_1', operationHash: 'hash_1', version: 1, invocation: approval }
        }
        return { kind: 'completed', reply: 'done' }
      },
    }
    const store = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at })
    const routine = store.create(input({ kind: 'on-demand' }))
    const engine = new RoutineEngine({ workspaceRoot: root, workspaceId: 'ws_1', store, execute: executor, clock: () => at })

    const runPromise = engine.testRoutine(routine.routineId)
    await new Promise(resolve => setTimeout(resolve, 0))
    const run = store.listRuns(routine.routineId)[0]!
    expect(calls).toBe(1)
    await expect(engine.onApprovalResolved('approval_1', true)).resolves.toBeNull()
    releaseGate()

    const result = await runPromise
    expect(calls).toBe(2)
    expect(result.state.kind).toBe('succeeded')
    expect(JSON.stringify(result)).not.toContain('session_1')
    const attempt = JSON.parse(readFileSync(join(root, '.routines', 'approval-attempts', `${run.runId}.json`), 'utf8')) as { requestId?: string }
    expect(attempt.requestId).toBeUndefined()
    await engine.stop()
  })

  it('cancels a completed provider turn when its approval was denied during execution', async () => {
    const root = workspace()
    let releaseGate!: () => void
    const gate = new Promise<void>(resolve => { releaseGate = resolve })
    const executor: RoutineExecutor = {
      async execute() {
        await gate
        return { kind: 'completed', reply: 'provider finished after denial' }
      },
      async denyApproval() {},
    }
    const store = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at })
    const routine = store.create(input({ kind: 'on-demand' }))
    const engine = new RoutineEngine({ workspaceRoot: root, workspaceId: 'ws_1', store, execute: executor, clock: () => at })
    const runPromise = engine.testRoutine(routine.routineId)
    await new Promise(resolve => setTimeout(resolve, 0))
    const run = store.listRuns(routine.routineId)[0]!

    expect(engine.onApprovalRequest(run.runId, 'approval_denied_during_run', 'request_denied')).toBe(true)
    await expect(engine.onApprovalResolved('approval_denied_during_run', false)).resolves.toBeNull()
    releaseGate()

    const result = await runPromise
    expect(result.state).toMatchObject({ kind: 'cancelled', reason: 'approval-denied' })
    await engine.stop()
  })

  it('persists a request ID handed off while the provider is waiting', async () => {
    const root = workspace()
    let releaseGate!: () => void
    const gate = new Promise<void>(resolve => { releaseGate = resolve })
    let calls = 0
    const approval = invocation()
    const executor: RoutineExecutor = {
      async execute() {
        calls += 1
        await gate
        return { kind: 'awaiting-approval', approvalId: 'approval_2', operationHash: 'hash_2', version: 1, invocation: approval }
      },
    }
    const store = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at })
    const routine = store.create(input({ kind: 'on-demand' }))
    const engine = new RoutineEngine({ workspaceRoot: root, workspaceId: 'ws_1', store, execute: executor, clock: () => at })
    const runPromise = engine.testRoutine(routine.routineId)
    await new Promise(resolve => setTimeout(resolve, 0))
    const run = store.listRuns(routine.routineId)[0]!
    engine.onApprovalRequest(run.runId, 'approval_2', 'request_2')
    releaseGate()
    const result = await runPromise
    const attempt = JSON.parse(readFileSync(join(root, '.routines', 'approval-attempts', `${run.runId}.json`), 'utf8')) as { requestId?: string }
    expect(result.state.kind).toBe('awaiting-approval')
    expect(attempt.requestId).toBe('request_2')
    expect(calls).toBe(1)
    await engine.stop()
  })

  it('cancels an approval result when the routine pauses during execution', async () => {
    const root = workspace()
    let releaseGate!: () => void
    const gate = new Promise<void>(resolve => { releaseGate = resolve })
    const executor: RoutineExecutor = {
      async execute() {
        await gate
        return { kind: 'awaiting-approval', approvalId: 'approval_3', operationHash: 'hash_3', version: 1, invocation: invocation() }
      },
    }
    const store = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at })
    const routine = store.create(input({ kind: 'on-demand' }))
    const engine = new RoutineEngine({ workspaceRoot: root, workspaceId: 'ws_1', store, execute: executor, clock: () => at })
    const runPromise = engine.testRoutine(routine.routineId)
    await new Promise(resolve => setTimeout(resolve, 0))
    engine.pause(routine.routineId)
    releaseGate()

    const result = await runPromise
    expect(result.state.kind).toBe('cancelled')
    expect(result.state).toMatchObject({ reason: 'routine-paused' })
    await engine.stop()
  })

  it('recovers an approved durable attempt after restart', async () => {
    const root = workspace()
    const store = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at })
    const routine = store.create(input({ kind: 'on-demand' }))
    const first: RoutineExecutor = {
      async execute() {
        return { kind: 'awaiting-approval', approvalId: 'approval_4', operationHash: 'hash_4', version: 1, invocation: invocation() }
      },
    }
    const initial = new RoutineEngine({ workspaceRoot: root, workspaceId: 'ws_1', store, execute: first, clock: () => at })
    const run = await initial.testRoutine(routine.routineId)
    await initial.stop()

    let claims = 0
    const resumed: RoutineExecutor = {
      async execute() { return { kind: 'completed', reply: 'done after restart' } },
      async validateApproval() { return 'allowed' },
      async claimApproval() { claims += 1 },
    }
    const restarted = new RoutineEngine({ workspaceRoot: root, workspaceId: 'ws_1', execute: resumed, clock: () => at })
    await restarted.start()

    expect(claims).toBe(1)
    expect(restarted.store.getRun(run.runId)?.state.kind).toBe('succeeded')
    await restarted.stop()

    const consumedRoot = workspace()
    const consumedStore = new RoutineStore({ workspaceRoot: consumedRoot, workspaceId: 'ws_1', clock: () => at })
    const consumedRoutine = consumedStore.create(input({ kind: 'on-demand' }))
    const consumedInitial = new RoutineEngine({
      workspaceRoot: consumedRoot,
      workspaceId: 'ws_1',
      store: consumedStore,
      execute: { async execute() { return { kind: 'awaiting-approval', approvalId: 'approval_consumed', operationHash: 'hash_consumed', version: 1, invocation: invocation() } } },
      clock: () => at,
    })
    const consumedRun = await consumedInitial.testRoutine(consumedRoutine.routineId)
    await consumedInitial.stop()
    let consumedClaims = 0
    const consumedRestarted = new RoutineEngine({
      workspaceRoot: consumedRoot,
      workspaceId: 'ws_1',
      execute: {
        async execute() { return { kind: 'completed', reply: 'done after consumed approval' } },
        async validateApproval() { return 'consumed' },
        async claimApproval() { consumedClaims += 1 },
      },
      clock: () => at,
    })
    await consumedRestarted.start()
    expect(consumedClaims).toBe(1)
    expect(consumedRestarted.store.getRun(consumedRun.runId)?.state.kind).toBe('succeeded')
    await consumedRestarted.stop()
  })

  it('cancels an approval run when restart finds its routine paused', async () => {
    const root = workspace()
    const store = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at })
    const routine = store.create(input({ kind: 'on-demand' }))
    const firstExecutor = new FakeExecutor()
    firstExecutor.next = { kind: 'awaiting-approval', approvalId: 'approval_paused', operationHash: 'hash_paused', version: 1, invocation: invocation() }
    const first = new RoutineEngine({ workspaceRoot: root, workspaceId: 'ws_1', store, execute: firstExecutor, clock: () => at })
    const run = await first.testRoutine(routine.routineId)
    await first.stop()
    store.pause(routine.routineId)

    const resumed = new FakeExecutor()
    const restarted = new RoutineEngine({ workspaceRoot: root, workspaceId: 'ws_1', execute: resumed, clock: () => at })
    await restarted.start()

    expect(restarted.store.getRun(run.runId)?.state).toMatchObject({ kind: 'cancelled', reason: 'routine-paused' })
    expect(resumed.calls).toBe(0)
    await restarted.stop()
  })

  it('gates queued work when a routine is paused and rejects deleted replay', async () => {
    const root = workspace()
    const executor = new FakeExecutor()
    const store = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at })
    const routine = store.create(input({ kind: 'on-demand' }))
    const occurrence = store.recordOccurrence({ routineId: routine.routineId, routineRevision: 1, source: 'event', externalEventId: 'queued-event' })
    const run = store.createRun({ occurrenceId: occurrence.occurrenceId, ownerBotId: 'bot_1' })
    const engine = new RoutineEngine({ workspaceRoot: root, workspaceId: 'ws_1', store, execute: executor, clock: () => at })

    engine.pause(routine.routineId)
    await engine.tick()
    expect(executor.calls).toBe(0)
    expect(store.getRun(run.runId)?.state.kind).toBe('cancelled')

    engine.enable(routine.routineId)
    engine.delete(routine.routineId)
    await expect(engine.replayRun(run.runId)).rejects.toThrow('Routine is not enabled')
  })

  it('marks an approval run uncertain when its durable execution record is missing', async () => {
    const root = workspace()
    const store = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at })
    const routine = store.create(input({ kind: 'on-demand' }))
    const paused = new FakeExecutor()
    paused.next = { kind: 'awaiting-approval', approvalId: 'approval_missing', operationHash: 'hash_missing', version: 1, invocation: {
      workspaceId: 'ws_1', botId: 'bot_1', conversationId: 'chat_1', runtimeId: 'session_1', toolName: 'Bash', toolSchemaVersion: '1', normalizedInput: { command: 'echo ok' }, attempt: 1,
      target: { kind: 'shell', value: 'echo ok', fingerprint: 'fp_missing' }, policyRevision: 'ask',
    } }
    const first = new RoutineEngine({ workspaceRoot: root, workspaceId: 'ws_1', store, execute: paused, clock: () => at })
    const run = await first.testRoutine(routine.routineId)
    rmSync(join(root, '.routines', 'approval-attempts', `${run.runId}.json`), { force: true })
    let deniedApproval: string | undefined
    const restarted = new RoutineEngine({
      workspaceRoot: root,
      workspaceId: 'ws_1',
      execute: { async execute() { return { kind: 'completed', reply: 'unused' } }, async denyApproval(approvalId) { deniedApproval = approvalId } },
      clock: () => at,
    })

    await restarted.start()

    expect(deniedApproval).toBe('approval_missing')
    expect(restarted.store.getRun(run.runId)?.state.kind).toBe('uncertain')
    await restarted.stop()
  })

  it('cancels an expired approval after restart and cleans its execution link', async () => {
    const root = workspace()
    const store = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at })
    const routine = store.create(input({ kind: 'on-demand' }))
    const first = new FakeExecutor()
    first.next = { kind: 'awaiting-approval', approvalId: 'approval_expired', operationHash: 'hash_expired', version: 1, invocation: invocation() }
    const initial = new RoutineEngine({ workspaceRoot: root, workspaceId: 'ws_1', store, execute: first, clock: () => at })
    const run = await initial.testRoutine(routine.routineId)
    await initial.stop()
    let resolved: boolean | undefined
    const restarted = new RoutineEngine({
      workspaceRoot: root,
      workspaceId: 'ws_1',
      execute: {
        async execute() { return { kind: 'completed', reply: 'unused' } },
        async validateApproval() { return 'expired' },
        async resolveApproval(_attempt, allowed) { resolved = allowed },
      },
      clock: () => at,
    })
    await restarted.start()
    expect(resolved).toBe(false)
    expect(restarted.store.getRun(run.runId)?.state).toMatchObject({ kind: 'cancelled', reason: 'approval-expired' })
    await restarted.stop()
  })

  it('resumes an approval-paused run after a process restart', async () => {
    const root = workspace()
    const store = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at })
    const routine = store.create(input({ kind: 'on-demand' }))
    const paused = new FakeExecutor()
    const approvalInvocation: ToolInvocation = {
      workspaceId: 'ws_1', botId: 'bot_1', conversationId: 'chat_1', runtimeId: 'session_1',
      toolName: 'Bash', toolSchemaVersion: '1', normalizedInput: { command: 'echo ok' }, attempt: 1,
      target: { kind: 'shell', value: 'echo ok', fingerprint: 'fp_1' }, policyRevision: 'ask',
    }
    paused.next = { kind: 'awaiting-approval', approvalId: 'approval_1', operationHash: 'hash_1', version: 1, invocation: approvalInvocation }
    const first = new RoutineEngine({ workspaceRoot: root, workspaceId: 'ws_1', store, execute: paused, clock: () => at })
    const run = await first.testRoutine(routine.routineId)
    await first.stop()
    expect(run.state.kind).toBe('awaiting-approval')

    const resumed = new FakeExecutor()
    const restarted = new RoutineEngine({ workspaceRoot: root, workspaceId: 'ws_1', execute: resumed, clock: () => at })
    const result = await restarted.onApprovalResolved('approval_1', true)

    expect(result?.state.kind).toBe('succeeded')
    expect(resumed.calls).toBe(1)
    await restarted.stop()
  })

  it('marks a crash between approval persistence and run transition uncertain and cleans the approval', async () => {
    const root = workspace()
    const store = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at })
    const routine = store.create(input({ kind: 'on-demand' }))
    const first = new FakeExecutor()
    first.next = { kind: 'awaiting-approval', approvalId: 'approval_running', operationHash: 'hash_running', version: 1, invocation: invocation() }
    const initial = new RoutineEngine({ workspaceRoot: root, workspaceId: 'ws_1', store, execute: first, clock: () => at })
    const awaiting = await initial.testRoutine(routine.routineId)
    const persisted = store.getRun(awaiting.runId)!
    store.transitionRun(persisted.runId, persisted.version, { kind: 'running', at })
    let cleanups = 0
    const restarted = new RoutineEngine({
      workspaceRoot: root,
      workspaceId: 'ws_1',
      execute: {
        async execute() { return { kind: 'completed', reply: 'unused' } },
        async resolveApproval(_attempt, allowed) { if (!allowed) cleanups += 1 },
      },
      clock: () => at,
    })

    await restarted.start()

    expect(restarted.store.getRun(awaiting.runId)?.state.kind).toBe('uncertain')
    expect(cleanups).toBe(1)
    expect(existsSync(join(root, '.routines', 'approval-attempts', `${awaiting.runId}.json`))).toBe(false)
    await restarted.stop()
  })

  it('retries durable approval cleanup after a cancellation across restart', async () => {
    const root = workspace()
    const store = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at })
    const routine = store.create(input({ kind: 'on-demand' }))
    const first = new FakeExecutor()
    first.next = { kind: 'awaiting-approval', approvalId: 'approval_cleanup', operationHash: 'hash_cleanup', version: 1, invocation: invocation() }
    const initial = new RoutineEngine({
      workspaceRoot: root,
      workspaceId: 'ws_1',
      store,
      execute: first,
      clock: () => at,
    })
    const run = await initial.testRoutine(routine.routineId)
    let attempts = 0
    const failing = new RoutineEngine({
      workspaceRoot: root,
      workspaceId: 'ws_1',
      store,
      execute: {
        async execute() { return { kind: 'completed', reply: 'unused' } },
        async resolveApproval() { attempts += 1; throw new Error('temporary cleanup failure') },
      },
      clock: () => at,
    })

    failing.pause(routine.routineId)
    await failing.stop()
    expect(attempts).toBe(1)
    expect(existsSync(join(root, '.routines', 'approval-attempts', `${run.runId}.json`))).toBe(true)

    const recovered = new RoutineEngine({
      workspaceRoot: root,
      workspaceId: 'ws_1',
      execute: {
        async execute() { return { kind: 'completed', reply: 'unused' } },
        async resolveApproval() { attempts += 1 },
      },
      clock: () => at,
    })
    await recovered.start()

    expect(attempts).toBe(2)
    expect(existsSync(join(root, '.routines', 'approval-attempts', `${run.runId}.json`))).toBe(false)
    await recovered.stop()
  })

  it('cancels a run when allow-once claim fails and removes its durable approval attempt', async () => {
    const root = workspace()
    const store = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at })
    const routine = store.create(input({ kind: 'on-demand' }))
    const executor: RoutineExecutor = {
      async execute() { return { kind: 'awaiting-approval', approvalId: 'approval_claim', operationHash: 'hash_claim', version: 1, invocation: invocation() } },
      async claimApproval() { throw new Error('claim failed') },
      async resolveApproval() {},
    }
    const engine = new RoutineEngine({ workspaceRoot: root, workspaceId: 'ws_1', store, execute: executor, clock: () => at })
    const run = await engine.testRoutine(routine.routineId)

    const result = await engine.onApprovalResolved('approval_claim', true)

    expect(result?.state).toMatchObject({ kind: 'uncertain', reason: 'approval execution record could not be claimed' })
    expect(existsSync(join(root, '.routines', 'approval-attempts', `${run.runId}.json`))).toBe(false)
    await engine.stop()
  })

  it('serializes duplicate approval responses for one run', async () => {
    const root = workspace()
    const store = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at })
    const routine = store.create(input({ kind: 'on-demand' }))
    let calls = 0
    const executor: RoutineExecutor = {
      async execute() {
        calls += 1
        return calls === 1
          ? { kind: 'awaiting-approval', approvalId: 'approval_duplicate', operationHash: 'hash_duplicate', version: 1, invocation: invocation() }
          : { kind: 'completed', reply: 'done' }
      },
      async claimApproval() { await Promise.resolve() },
      async resolveApproval() { await Promise.resolve() },
    }
    const engine = new RoutineEngine({ workspaceRoot: root, workspaceId: 'ws_1', store, execute: executor, clock: () => at })
    const run = await engine.testRoutine(routine.routineId)

    const results = await Promise.all([
      engine.onApprovalResolved('approval_duplicate', true),
      engine.onApprovalResolved('approval_duplicate', true),
    ])

    expect(results[0]?.state.kind).toBe('succeeded')
    expect(results[1]?.state.kind).toBe('succeeded')
    expect(calls).toBe(2)
    expect(existsSync(join(root, '.routines', 'approval-attempts', `${run.runId}.json`))).toBe(false)
    await engine.stop()
  })

  it('serializes duplicate direct approval resume requests', async () => {
    const root = workspace()
    const store = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at })
    const routine = store.create(input({ kind: 'on-demand' }))
    let calls = 0
    const executor: RoutineExecutor = {
      async execute() {
        calls += 1
        return calls === 1
          ? { kind: 'awaiting-approval', approvalId: 'approval_resume', operationHash: 'hash_resume', version: 1, invocation: invocation() }
          : { kind: 'completed', reply: 'done' }
      },
      async claimApproval() { await Promise.resolve() },
      async resolveApproval() { await Promise.resolve() },
    }
    const engine = new RoutineEngine({ workspaceRoot: root, workspaceId: 'ws_1', store, execute: executor, clock: () => at })
    const run = await engine.testRoutine(routine.routineId)

    const results = await Promise.all([
      engine.resumeAfterApproval(run.runId, run.version),
      engine.resumeAfterApproval(run.runId, run.version),
    ])

    expect(results[0].state.kind).toBe('succeeded')
    expect(results[1].state.kind).toBe('succeeded')
    expect(calls).toBe(2)
    await engine.stop()
  })

  it('rejects missing request IDs without mutating the approval attempt', async () => {
    const root = workspace()
    const store = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at })
    const routine = store.create(input({ kind: 'on-demand' }))
    const executor = new FakeExecutor()
    executor.next = { kind: 'awaiting-approval', approvalId: 'approval_request', operationHash: 'hash_request', version: 1, invocation: invocation() }
    const engine = new RoutineEngine({ workspaceRoot: root, workspaceId: 'ws_1', store, execute: executor, clock: () => at })
    const run = await engine.testRoutine(routine.routineId)

    expect(engine.onApprovalRequest(run.runId, 'approval_request', undefined as unknown as string)).toBe(false)
    const attempt = JSON.parse(readFileSync(join(root, '.routines', 'approval-attempts', `${run.runId}.json`), 'utf8')) as { requestId?: string }
    expect(attempt.requestId).toBeUndefined()
    await engine.stop()
  })

  it('recovers an orphaned run file when its routine record is gone', async () => {
    const root = workspace()
    const store = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at })
    const routine = store.create(input({ kind: 'on-demand' }))
    const occurrence = store.recordOccurrence({ routineId: routine.routineId, routineRevision: 1, source: 'event', externalEventId: 'orphan-event' })
    const run = store.createRun({ occurrenceId: occurrence.occurrenceId, ownerBotId: 'bot_1' })
    rmSync(join(root, '.routines', 'routines', routine.routineId), { recursive: true, force: true })

    const restarted = new RoutineEngine({
      workspaceRoot: root,
      workspaceId: 'ws_1',
      execute: new FakeExecutor(),
      clock: () => at,
    })
    await restarted.start()

    expect(restarted.store.listAllRuns()).toHaveLength(1)
    expect(restarted.store.getRun(run.runId)?.state).toMatchObject({ kind: 'cancelled', reason: 'routine-deleted' })
    await restarted.stop()
  })

  it('drains an in-flight routine before shutdown', async () => {
    const root = workspace()
    const store = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at })
    const routine = store.create(input({ kind: 'on-demand' }))
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const executor: RoutineExecutor = {
      async execute() {
        await gate
        return { kind: 'completed', reply: 'done' }
      },
    }
    const engine = new RoutineEngine({ workspaceRoot: root, workspaceId: 'ws_1', store, execute: executor, clock: () => at })
    const runPromise = engine.testRoutine(routine.routineId)
    await new Promise(resolve => setTimeout(resolve, 0))
    const stopPromise = engine.stop()
    release()

    const [run] = await Promise.all([runPromise, stopPromise.then(() => store.getRun(engine.store.listRuns(routine.routineId)[0]!.runId)!)])

    expect(run.state.kind).toBe('succeeded')
    expect(engine.isRunning()).toBe(false)
  })
})
