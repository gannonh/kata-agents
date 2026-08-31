import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RoutineId } from '@kata-sh/core'
import { readJsonFile, writeJsonRecord } from '../conversations/durable-json.ts'
import { deriveRoutineRunId, deriveTriggerOccurrenceId, RoutineStore, toRoutineRunPublicDto } from './routine-store.ts'
import { nextScheduledInstant, scheduledInstantsBetween } from './schedule.ts'

const roots: string[] = []
const at = '2026-08-31T00:00:00.000Z'

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function workspace(): string { const root = mkdtempSync(join(tmpdir(), 'routine-store-')); roots.push(root); return root }
function routineInput() {
  return {
    ownerBotId: 'bot_1', name: 'Morning report', trigger: { kind: 'schedule' as const, cron: '0 9 * * *', timezone: 'Europe/Budapest', dst: { gap: 'skip' as const, fold: 'once' as const } },
    input: 'Summarize the day.', expectedResult: 'A concise report.', approvalBoundary: 'ask' as const, failurePolicy: 'uncertain' as const, destination: { kind: 'direct' as const, chatId: 'chat_1' },
  }
}

describe('RoutineStore', () => {
  it('persists CRUD, immutable revisions, lifecycle, and restart recovery', () => {
    const root = workspace()
    const first = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at, randomId: () => 'id_1' })
    const created = first.create(routineInput())
    expect(created.activeRevision).toBe(1)
    const updated = first.update(created.routineId, { name: 'Updated report', input: 'Summarize priorities.' })
    expect(updated.activeRevision).toBe(2)
    expect(first.getRevision(created.routineId, 1).input).toBe('Summarize the day.')
    expect(first.getActiveRevision(created.routineId).input).toBe('Summarize priorities.')
    expect(first.pause(created.routineId).lifecycle).toBe('paused')
    expect(first.enable(created.routineId).lifecycle).toBe('enabled')

    const restarted = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at })
    expect(restarted.getPublic(created.routineId).revision.input).toBe('Summarize priorities.')
    restarted.delete(created.routineId)
    expect(restarted.get(created.routineId)?.lifecycle).toBe('deleted')
    expect(restarted.list({ lifecycle: 'deleted' })).toHaveLength(1)
  })

  it('deduplicates occurrences and atomically maps one occurrence to one run', () => {
    const root = workspace()
    const store = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at, randomId: () => 'id_1' })
    const routine = store.create(routineInput())
    const scheduledInstant = '2026-08-31T07:00:00.000Z'
    const occurrence = store.recordOccurrence({ routineId: routine.routineId, routineRevision: 1, source: 'schedule', scheduledInstant })
    const duplicate = store.recordOccurrence({ routineId: routine.routineId, routineRevision: 1, source: 'schedule', scheduledInstant })
    expect(duplicate).toEqual(occurrence)
    expect(occurrence.occurrenceId).toBe(deriveTriggerOccurrenceId({ routineId: routine.routineId, revision: 1, source: 'schedule', scheduledInstant }))
    const claimed = store.claimOccurrence({ occurrenceId: occurrence.occurrenceId, workerId: 'server_1' })
    expect(claimed?.workerId).toBe('server_1')
    expect(store.claimOccurrence({ occurrenceId: occurrence.occurrenceId, workerId: 'server_2' })).toBeNull()
    const run = store.createRun({ occurrenceId: occurrence.occurrenceId, ownerBotId: 'bot_1' })
    expect(run.runId).toBe(deriveRoutineRunId(occurrence.occurrenceId))
    const legacyRun = { ...run } as Record<string, unknown>
    delete legacyRun.attempt
    writeJsonRecord(join(root, '.routines', 'runs', `${run.runId}.json`), legacyRun)
    expect(store.getRun(run.runId)?.attempt).toBe(1)
    expect(store.createRun({ occurrenceId: occurrence.occurrenceId, ownerBotId: 'bot_1' })).toEqual({ ...run, attempt: 1 })
    expect(store.listRuns(routine.routineId)).toHaveLength(1)
    const publicRun = toRoutineRunPublicDto(run)
    expect(publicRun.state).toEqual({ kind: 'queued', at })
    expect(JSON.stringify(publicRun)).not.toContain('claimToken')
  })

  it('enforces versioned lifecycle transitions, cursor monotonicity, and recovery markers', () => {
    const root = workspace()
    const store = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at, randomId: () => 'id_1' })
    const routine = store.create(routineInput())
    const occurrence = store.recordOccurrence({ routineId: routine.routineId, routineRevision: 1, source: 'event', externalEventId: 'evt_1' })
    const run = store.createRun({ occurrenceId: occurrence.occurrenceId, ownerBotId: 'bot_1' })
    const claimed = store.transitionRun(run.runId, 1, { kind: 'claimed', at, workerId: 'server_1', leaseUntil: '2026-08-31T00:02:00.000Z' })
    expect(() => store.transitionRun(run.runId, 1, { kind: 'running', at })).toThrow('version conflict')
    expect(store.transitionRun(run.runId, claimed.version, { kind: 'running', at }).state.kind).toBe('running')
    expect(() => store.advanceScheduleCursor(routine.routineId, 1, '2026-08-30T00:00:00.000Z')).not.toThrow()
    expect(() => store.advanceScheduleCursor(routine.routineId, 1, '2026-08-29T00:00:00.000Z')).toThrow('backwards')

    const markerPath = join(root, '.routines', 'transitions', `${run.runId}-3.json`)
    writeJsonRecord(markerPath, { runId: run.runId, expectedVersion: 3, next: { kind: 'succeeded', at, result: 'done' } })
    expect(store.recover().transitions).toContain(run.runId)
    expect(store.getRun(run.runId)?.state.kind).toBe('succeeded')
    expect(readJsonFile(markerPath)).toBeNull()
  })
})

describe('routine schedule', () => {
  const trigger = { kind: 'schedule' as const, cron: '30 2 * * *', timezone: 'Europe/Berlin', dst: { gap: 'skip' as const, fold: 'once' as const } }
  it('resolves timezone and skips a spring-forward gap', () => {
    expect(nextScheduledInstant(trigger, '2024-03-30T00:00:00.000Z')).toBe('2024-03-30T01:30:00.000Z')
    expect(nextScheduledInstant(trigger, '2024-03-30T01:30:00.000Z')).toBe('2024-03-31T01:30:00.000Z')
  })
  it('returns one real instant for a fall-back fold', () => {
    expect(scheduledInstantsBetween(trigger, '2024-10-26T00:00:00.000Z', '2024-10-28T00:00:00.000Z')).toEqual([
      '2024-10-26T00:30:00.000Z', '2024-10-27T00:30:00.000Z',
    ])
  })
})
