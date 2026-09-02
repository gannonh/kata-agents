import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RoutineStore } from '@kata-sh/shared/routines'
import type { RoutineRevision, RoutineRun } from '@kata-sh/core'
import { RoutineEngine, type RoutineExecutor } from './routine-engine'

const roots: string[] = []
const at = '2026-08-31T00:00:00.000Z'

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'routine-public-boundary-'))
  roots.push(root)
  return root
}

class FakeExecutor implements RoutineExecutor {
  calls = 0
  async execute(_run: RoutineRun, _revision: RoutineRevision) {
    this.calls += 1
    return { kind: 'completed' as const, reply: 'ROUTINE_PUBLIC_BOUNDARY' }
  }
}

async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for public-boundary routine execution')
}

describe('public-boundary routine event fixture (#83)', () => {
  it('creates exactly one Bot-owned run for a matching event and ignores an unrelated event', async () => {
    const executor = new FakeExecutor()
    const root = workspace()
    const store = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at })
    const routine = store.create({
      ownerBotId: 'bot_1',
      name: 'Public boundary',
      trigger: { kind: 'event', source: 'routine-fixture', matcher: { field: 'value', equals: 'match' } },
      input: 'Reply with ROUTINE_PUBLIC_BOUNDARY',
      expectedResult: 'ROUTINE_PUBLIC_BOUNDARY',
      approvalBoundary: 'allow-all',
      failurePolicy: 'stop',
      destination: { kind: 'direct', chatId: 'chat_1' },
    })
    const engine = new RoutineEngine({ workspaceRoot: root, workspaceId: 'ws_1', store, execute: executor, clock: () => at })

    const matching = await engine.ingestEvent({
      source: 'routine-fixture',
      externalEventId: 'event-match',
      payload: { value: 'match' },
    })
    const duplicate = await engine.ingestEvent({
      source: 'routine-fixture',
      externalEventId: 'event-match',
      payload: { value: 'match' },
    })
    const unrelated = await engine.ingestEvent({
      source: 'routine-fixture',
      externalEventId: 'event-unrelated',
      payload: { value: 'different' },
    })

    await waitFor(() => engine.listRuns(routine.routineId)[0]?.state.kind === 'succeeded')
    const runs = engine.listRuns(routine.routineId)
    const publicJson = JSON.stringify({ matching, duplicate, unrelated, runs, routine: engine.get(routine.routineId) })

    expect(matching).toHaveLength(1)
    expect(matching[0]?.runId).toMatch(/^run_[A-Za-z0-9_-]+$/)
    expect(matching[0]?.ownerBotId).toBe('bot_1')
    expect(matching[0]?.routineId).toBe(routine.routineId)
    expect(duplicate[0]?.runId).toBe(matching[0]?.runId)
    expect(unrelated).toHaveLength(0)
    expect(runs).toHaveLength(1)
    expect(runs[0]?.state).toEqual({ kind: 'succeeded', at, result: 'ROUTINE_PUBLIC_BOUNDARY' })
    expect(executor.calls).toBe(1)
    expect(publicJson).not.toContain('claimToken')
    expect(publicJson).not.toContain('sessionId')
    await engine.stop()
  })
})
