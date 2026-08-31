import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RoutineId } from '@kata-sh/core'
import { readJsonFile, writeJsonRecord } from '../conversations/durable-json.ts'
import { withDurableLock } from '../spawn-tasks/durable-fs.ts'
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

  it('keeps a cached routine readable while another writer owns its cutover lock', () => {
    const root = workspace()
    const first = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at })
    const routine = first.create(routineInput())
    const second = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at })
    const lockPath = join(root, '.routines', 'routines', `.${routine.routineId}.lock`)

    withDurableLock(lockPath, () => {
      expect(second.get(routine.routineId)?.activeRevision).toBe(1)
      expect(second.list()).toEqual([expect.objectContaining({ routineId: routine.routineId, activeRevision: 1 })])
      expect(second.getRecoveryErrors()).toEqual([])
    })

    expect(second.get(routine.routineId)?.activeRevision).toBe(1)
  })

  it('leaves occurrence, run, and cursor artifacts untouched while their locks are busy', () => {
    const root = workspace()
    const store = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at })
    const routine = store.create(routineInput())
    const occurrence = store.recordOccurrence({ routineId: routine.routineId, routineRevision: 1, source: 'event', externalEventId: 'busy-read' })
    const run = store.createRun({ occurrenceId: occurrence.occurrenceId, ownerBotId: 'bot_1' })
    const occurrencePath = join(root, '.routines', 'occurrences', `${occurrence.occurrenceId}.json`)
    const runPath = join(root, '.routines', 'runs', `${run.runId}.json`)
    const cursorPath = join(root, '.routines', 'cursors', `${routine.routineId}-1.json`)
    writeFileSync(occurrencePath, '{malformed')
    writeFileSync(runPath, '{malformed')
    writeFileSync(cursorPath, '{malformed')

    const occurrenceLockPath = join(root, '.routines', 'claims', `.${occurrence.occurrenceId}.lock`)
    const runLockPath = join(root, '.routines', 'runs', `.${run.runId}.lock`)
    const cursorLockPath = join(root, '.routines', 'cursors', `.${routine.routineId}-1.lock`)
    withDurableLock(occurrenceLockPath, () => {
      expect(store.getOccurrence(occurrence.occurrenceId)).toBeNull()
      expect(existsSync(occurrencePath)).toBe(true)
    })
    withDurableLock(runLockPath, () => {
      expect(store.getRun(run.runId)).toBeNull()
      expect(existsSync(runPath)).toBe(true)
    })
    withDurableLock(cursorLockPath, () => {
      expect(() => store.getScheduleCursor(routine.routineId, 1)).toThrow('Durable lock is busy')
      expect(existsSync(cursorPath)).toBe(true)
    })
  })

  it('serializes routine edits and repairs an interrupted run index', () => {
    const root = workspace()
    const first = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at })
    const routine = first.create(routineInput())
    const second = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at })
    expect(second.update(routine.routineId, { name: 'From second writer' }).activeRevision).toBe(2)
    expect(first.update(routine.routineId, { name: 'From first writer' }).activeRevision).toBe(3)

    const occurrence = first.recordOccurrence({ routineId: routine.routineId, routineRevision: 3, source: 'event', externalEventId: 'pointer-repair' })
    const run = first.createRun({ occurrenceId: occurrence.occurrenceId, ownerBotId: 'bot_1' })
    rmSync(join(root, '.routines', 'occurrence-runs', `${occurrence.occurrenceId}.json`), { force: true })
    expect(second.createRun({ occurrenceId: occurrence.occurrenceId, ownerBotId: 'bot_1' }).runId).toBe(run.runId)
    expect(readJsonFile(join(root, '.routines', 'occurrence-runs', `${occurrence.occurrenceId}.json`))).toBe(`${run.runId}\n`)
  })

  it('rejects catastrophic event regexes before persistence', () => {
    const root = workspace()
    const store = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at })

    expect(() => store.create({
      ...routineInput(),
      trigger: { kind: 'event', source: 'source_1', matcher: { field: 'value', matches: '(a+)+' } },
    })).toThrow('trigger.matcher.matches is too complex')
  })

  it('rejects creating a run after its routine is paused', () => {
    const root = workspace()
    const store = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at })
    const routine = store.create(routineInput())
    const occurrence = store.recordOccurrence({ routineId: routine.routineId, routineRevision: 1, source: 'event', externalEventId: 'paused-run' })
    store.pause(routine.routineId)

    expect(() => store.createRun({ occurrenceId: occurrence.occurrenceId, ownerBotId: 'bot_1' })).toThrow('Routine is not enabled')
  })

  it('quarantines an invalid completed cutover marker', () => {
    const root = workspace()
    const store = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at })
    const routine = store.create(routineInput())
    const markerPath = join(root, '.routines', 'cutovers', `${routine.routineId}-1.json`)
    writeFileSync(markerPath, JSON.stringify({ schemaVersion: 999, routineId: routine.routineId, previousRevision: 0, nextRevision: 1, state: 'complete' }))

    expect(store.recover().cutovers).toEqual([])
    expect(store.getRecoveryErrors()).toEqual([
      expect.objectContaining({ path: markerPath }),
    ])
  })

  it('rejects an orphaned revision instead of reusing its revision number', () => {
    const root = workspace()
    const store = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at })
    const routine = store.create(routineInput())
    writeJsonRecord(join(root, '.routines', 'routines', routine.routineId, 'revisions', '2.json'), {
      ...store.getRevision(routine.routineId, 1),
      revision: 2,
    })

    expect(() => store.update(routine.routineId, { name: 'Should not overwrite orphan' })).toThrow('incomplete cutover')
    expect(store.get(routine.routineId)?.activeRevision).toBe(1)
  })

  it('recovers transition markers without overwriting a newer run state', () => {
    const root = workspace()
    const store = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at })
    const routine = store.create(routineInput())
    const occurrence = store.recordOccurrence({ routineId: routine.routineId, routineRevision: 1, source: 'event', externalEventId: 'transition-race' })
    const run = store.createRun({ occurrenceId: occurrence.occurrenceId, ownerBotId: 'bot_1' })
    const claim = store.claimOccurrence({ occurrenceId: occurrence.occurrenceId, workerId: 'worker-1' })!
    const claimed = store.transitionRun(run.runId, 1, { kind: 'claimed', at, workerId: 'worker-1', claimToken: claim.claimToken!, leaseUntil: claim.leaseUntil! }, { claim: { occurrenceId: occurrence.occurrenceId, workerId: 'worker-1', claimToken: claim.claimToken!, leaseUntil: claim.leaseUntil! } })
    writeJsonRecord(join(root, '.routines', 'transitions', `${run.runId}-1.json`), {
      runId: run.runId,
      expectedVersion: 1,
      next: { kind: 'claimed', at, workerId: 'worker-1', claimToken: claim.claimToken!, leaseUntil: '2026-08-31T00:02:00.000Z' },
      attempt: 1,
      token: 'transition-test',
    })

    expect(() => store.transitionRun(run.runId, 1, { kind: 'claimed', at, workerId: 'worker-2', claimToken: 'claim_other', leaseUntil: '2026-08-31T00:02:00.000Z' })).toThrow('version conflict')
    expect(store.getRun(run.runId)).toMatchObject({ version: claimed.version, state: { kind: 'claimed', workerId: 'worker-1' } })
    expect(store.recover().transitions).toEqual([])
    expect(store.getRun(run.runId)?.state).toMatchObject({ kind: 'claimed', workerId: 'worker-1' })
  })

  it('quarantines a mismatched active revision without blocking a restart', () => {
    const root = workspace()
    const store = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at })
    const routine = store.create(routineInput())
    store.update(routine.routineId, { name: 'Revision two' })
    const activePath = join(root, '.routines', 'routines', routine.routineId, 'active.json')
    writeJsonRecord(activePath, store.getRevision(routine.routineId, 1))

    const restarted = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at })

    expect(restarted.getRecoveryErrors()[0]).toEqual(expect.objectContaining({ path: activePath }))
  })

  it('quarantines malformed routine records without blocking a restart', () => {
    const root = workspace()
    const store = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at })
    const routine = store.create(routineInput())
    writeFileSync(join(root, '.routines', 'routines', routine.routineId, 'record.json'), '{malformed')

    const restarted = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at })

    expect(restarted.list()).toHaveLength(0)
    expect(restarted.getRecoveryErrors()).toEqual([
      expect.objectContaining({ path: join(root, '.routines', 'routines', routine.routineId, 'record.json') }),
    ])
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
    const claim = store.claimOccurrence({ occurrenceId: occurrence.occurrenceId, workerId: 'server_1' })!
    expect(() => store.transitionRunWithLifecycle(run.runId, run.version, { kind: 'claimed', at, workerId: 'server_1', claimToken: claim.claimToken!, leaseUntil: claim.leaseUntil! })).toThrow('claim is required')
    expect(() => store.transitionRun(run.runId, run.version, { kind: 'claimed', at, workerId: 'server_2', claimToken: claim.claimToken!, leaseUntil: claim.leaseUntil! }, { claim: { occurrenceId: occurrence.occurrenceId, workerId: 'server_1', claimToken: claim.claimToken!, leaseUntil: claim.leaseUntil! } })).toThrow('does not match claimed state')
    const claimed = store.transitionRun(run.runId, 1, { kind: 'claimed', at, workerId: 'server_1', claimToken: claim.claimToken!, leaseUntil: claim.leaseUntil! }, { claim: { occurrenceId: occurrence.occurrenceId, workerId: 'server_1', claimToken: claim.claimToken!, leaseUntil: claim.leaseUntil! } })
    expect(() => store.transitionRun(run.runId, 1, { kind: 'running', at })).toThrow('version conflict')
    expect(store.transitionRun(claimed.runId, claimed.version, { kind: 'running', at }, { claim: { occurrenceId: occurrence.occurrenceId, workerId: 'server_1', claimToken: claim.claimToken!, leaseUntil: claim.leaseUntil! } }).state.kind).toBe('running')
    expect(() => store.advanceScheduleCursor(routine.routineId, 1, '2026-08-30T00:00:00.000Z')).not.toThrow()
    expect(() => store.advanceScheduleCursor(routine.routineId, 1, '2026-08-29T00:00:00.000Z')).toThrow('backwards')

    const markerPath = join(root, '.routines', 'transitions', `${run.runId}-3.json`)
    writeJsonRecord(markerPath, { runId: run.runId, expectedVersion: 3, next: { kind: 'succeeded', at, result: 'done' }, attempt: 1, token: 'transition-test' })
    expect(store.recover().transitions).toContain(run.runId)
    expect(store.getRun(run.runId)?.state.kind).toBe('succeeded')
    expect(readJsonFile(markerPath)).toBeNull()

    const futureMarkerPath = join(root, '.routines', 'transitions', `${run.runId}-5.json`)
    writeJsonRecord(futureMarkerPath, { runId: run.runId, expectedVersion: 5, next: { kind: 'succeeded', at, result: 'future' }, attempt: 1, token: 'future-transition' })
    expect(store.recover().transitions).toEqual([])
    expect(store.getRecoveryErrors()).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: futureMarkerPath }),
    ]))
  })

  it('repairs a null occurrence-run pointer before creating a run', () => {
    const root = workspace()
    const store = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at })
    const routine = store.create(routineInput())
    const occurrence = store.recordOccurrence({ routineId: routine.routineId, routineRevision: 1, source: 'event', externalEventId: 'null-pointer' })
    const pointerPath = join(root, '.routines', 'occurrence-runs', `${occurrence.occurrenceId}.json`)
    writeFileSync(pointerPath, 'null')

    const run = store.createRun({ occurrenceId: occurrence.occurrenceId, ownerBotId: 'bot_1' })

    expect(readJsonFile(pointerPath)).toBe(`${run.runId}\n`)
  })

  it('cancels an execution result when the routine is paused before the terminal commit', () => {
    const root = workspace()
    const store = new RoutineStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at })
    const routine = store.create(routineInput())
    const occurrence = store.recordOccurrence({ routineId: routine.routineId, routineRevision: 1, source: 'event', externalEventId: 'paused-terminal' })
    const run = store.createRun({ occurrenceId: occurrence.occurrenceId, ownerBotId: 'bot_1' })
    const claim = store.claimOccurrence({ occurrenceId: occurrence.occurrenceId, workerId: 'worker-1' })!
    const claimed = store.transitionRun(run.runId, run.version, { kind: 'claimed', at, workerId: 'worker-1', claimToken: claim.claimToken!, leaseUntil: claim.leaseUntil! }, { claim: { occurrenceId: occurrence.occurrenceId, workerId: 'worker-1', claimToken: claim.claimToken!, leaseUntil: claim.leaseUntil! } })
    const running = store.transitionRun(claimed.runId, claimed.version, { kind: 'running', at }, { claim: { occurrenceId: occurrence.occurrenceId, workerId: 'worker-1', claimToken: claim.claimToken!, leaseUntil: claim.leaseUntil! } })
    store.pause(routine.routineId)

    expect(store.transitionRunAfterExecution(running.runId, running.version, { kind: 'succeeded', at, result: 'done' }).state).toEqual({ kind: 'cancelled', at, reason: 'routine-paused' })
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
