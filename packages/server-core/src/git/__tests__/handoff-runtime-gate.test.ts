import { describe, test, expect, afterEach, beforeEach } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createDeterministicHandoffAdapter } from '@kata-sh/shared/agent/testing'
import { loadSession as loadStoredSession } from '@kata-sh/shared/sessions'
import { setupI18n } from '@kata-sh/shared/i18n/setupI18n'
import { SessionManager, createManagedSession } from '../../sessions/SessionManager'
import { makeTmpDir, cleanup } from './test-helpers'

setupI18n()

const cleanups: string[] = []
function tmp(): string {
  const d = makeTmpDir('kata-handoff-gate-')
  cleanups.push(d)
  return d
}
afterEach(() => {
  while (cleanups.length) cleanup(cleanups.pop()!)
})
let previousGitWorkspaceV1: string | undefined
beforeEach(() => {
  previousGitWorkspaceV1 = process.env.KATA_FEATURE_GIT_WORKSPACE_V1
  process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = '1'
})
afterEach(() => {
  if (previousGitWorkspaceV1 === undefined) delete process.env.KATA_FEATURE_GIT_WORKSPACE_V1
  else process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = previousGitWorkspaceV1
})

function makeManager(): { sm: SessionManager } {
  const sm = new SessionManager()
  return { sm }
}

function injectSession(sm: SessionManager, id: string, workspaceRootPath: string, overrides: Record<string, unknown> = {}) {
  const workspace = { id: 'ws_test', name: 'WS', rootPath: workspaceRootPath, createdAt: Date.now() }
  mkdirSync(join(workspaceRootPath, 'sessions', id), { recursive: true })
  const managed = createManagedSession(
    { id, sdkCwd: join(workspaceRootPath, 'sessions', id) },
    workspace as any,
    { messagesLoaded: true, createdAt: Date.now(), ...overrides } as any,
  )
  ;(sm as any).sessions.set(id, managed)
  return managed
}

describe('SessionManager.verifyHandoffRuntimeBeforeSend', () => {
  test('verifies an unverified runtime and marks it verified for the process', async () => {
    const { sm } = makeManager()
    const wsRoot = tmp()
    const managed = injectSession(sm, 's1', wsRoot, { workingDirectory: '/srv/dest', handoffRuntimeState: 'unverified' })
    const agent = { executionCwdRebind: createDeterministicHandoffAdapter({ adapterId: 'det' }) }

    await (sm as any).verifyHandoffRuntimeBeforeSend('s1', managed, agent)

    expect(managed.handoffRuntimeState).toBe('verified')
  })

  test('blocks Send with recovery-required when verification throws', async () => {
    const { sm } = makeManager()
    const wsRoot = tmp()
    const managed = injectSession(sm, 's1', wsRoot, { workingDirectory: '/srv/dest', handoffRuntimeState: 'unverified' })
    const agent = { executionCwdRebind: createDeterministicHandoffAdapter({ adapterId: 'det', failVerify: true }) }

    await expect((sm as any).verifyHandoffRuntimeBeforeSend('s1', managed, agent)).rejects.toThrow(
      'Handoff runtime verification failed',
    )
    expect(managed.handoffRuntimeState).toBe('recovery-required')
    // Persisted so a restart keeps Send blocked until the runtime is fixed.
    expect(loadStoredSession(wsRoot, 's1')?.handoffRuntimeState).toBe('recovery-required')
  })

  test('blocks Send when the proof misses a required tool category', async () => {
    const { sm } = makeManager()
    const wsRoot = tmp()
    const managed = injectSession(sm, 's1', wsRoot, { workingDirectory: '/srv/dest', handoffRuntimeState: 'unverified' })
    const agent = { executionCwdRebind: createDeterministicHandoffAdapter({ adapterId: 'det', missingChecks: ['mcp'] }) }

    await expect((sm as any).verifyHandoffRuntimeBeforeSend('s1', managed, agent)).rejects.toThrow(
      'Handoff runtime verification failed',
    )
    expect(managed.handoffRuntimeState).toBe('recovery-required')
  })

  test('blocks Send when the adapter is missing from the recreated runtime', async () => {
    const { sm } = makeManager()
    const wsRoot = tmp()
    const managed = injectSession(sm, 's1', wsRoot, { workingDirectory: '/srv/dest', handoffRuntimeState: 'unverified' })

    await expect((sm as any).verifyHandoffRuntimeBeforeSend('s1', managed, { executionCwdRebind: undefined })).rejects.toThrow(
      'Handoff runtime reconstruction is unavailable',
    )
    expect(managed.handoffRuntimeState).toBe('recovery-required')
  })

  test('is a no-op for verified sessions; recovery-required re-attempts the proof', async () => {
    const { sm } = makeManager()
    const wsRoot = tmp()
    // Verified: never re-proven within the process — the failing adapter
    // proves the verified state short-circuits the proof.
    const verified = injectSession(sm, 's-verified', wsRoot, { workingDirectory: '/srv/dest', handoffRuntimeState: 'verified' })
    const failingAgent = { executionCwdRebind: createDeterministicHandoffAdapter({ adapterId: 'det', failVerify: true }) }
    await (sm as any).verifyHandoffRuntimeBeforeSend(verified.id, verified, failingAgent)
    expect(verified.handoffRuntimeState).toBe('verified')

    // Recovery-required with a still-broken adapter: Send stays blocked.
    const broken = injectSession(sm, 's-broken', wsRoot, { workingDirectory: '/srv/dest', handoffRuntimeState: 'recovery-required' })
    await expect((sm as any).verifyHandoffRuntimeBeforeSend(broken.id, broken, failingAgent)).rejects.toThrow(
      'Handoff runtime verification failed',
    )
    expect(broken.handoffRuntimeState).toBe('recovery-required')

    // Recovery-required with a fixed adapter: a later Send re-proves and clears.
    const fixed = injectSession(sm, 's-fixed', wsRoot, { workingDirectory: '/srv/dest', handoffRuntimeState: 'recovery-required' })
    await (sm as any).verifyHandoffRuntimeBeforeSend(fixed.id, fixed, {
      executionCwdRebind: createDeterministicHandoffAdapter({ adapterId: 'det' }),
    })
    expect(fixed.handoffRuntimeState).toBe('verified')
  })

  test('is a no-op for sessions that never performed a handoff (no gate armed)', async () => {
    const { sm } = makeManager()
    const wsRoot = tmp()
    // A session without handoffRuntimeState has no destination to prove; it
    // must not be blocked or marked recovery-required even without an adapter.
    const managed = injectSession(sm, 's-never-handoff', wsRoot, { workingDirectory: '/srv/dest' })

    await (sm as any).verifyHandoffRuntimeBeforeSend(managed.id, managed, { executionCwdRebind: undefined })
    expect(managed.handoffRuntimeState).toBeUndefined()
    expect(loadStoredSession(wsRoot, 's-never-handoff')?.handoffRuntimeState).toBeUndefined()
  })

  test('blocks every send while the runtime stays broken (second-send blocking)', async () => {
    const { sm } = makeManager()
    const wsRoot = tmp()
    const managed = injectSession(sm, 's1', wsRoot, { workingDirectory: '/srv/dest', handoffRuntimeState: 'unverified' })
    const broken = { executionCwdRebind: createDeterministicHandoffAdapter({ adapterId: 'det', failVerify: true }) }
    await expect((sm as any).verifyHandoffRuntimeBeforeSend('s1', managed, broken)).rejects.toThrow()
    await expect((sm as any).verifyHandoffRuntimeBeforeSend('s1', managed, broken)).rejects.toThrow()
    expect(managed.handoffRuntimeState).toBe('recovery-required')
  })

  test('a successful proof is never persisted as verified (recreated runtimes re-prove)', async () => {
    const { sm } = makeManager()
    const wsRoot = tmp()
    const managed = injectSession(sm, 's1', wsRoot, { workingDirectory: '/srv/dest', handoffRuntimeState: 'unverified' })
    const agent = { executionCwdRebind: createDeterministicHandoffAdapter({ adapterId: 'det' }) }

    await (sm as any).verifyHandoffRuntimeBeforeSend('s1', managed, agent)
    expect(managed.handoffRuntimeState).toBe('verified')
    ;(sm as any).persistSession(managed)
    await sm.flushSession('s1')

    // The durable header must stay armed so a recreated runtime re-proves.
    expect(loadStoredSession(wsRoot, 's1')?.handoffRuntimeState).toBe('unverified')
  })

  test('a handoff commit arms the runtime as unverified and the DTO exposes the state', async () => {
    const worktreeRoot = tmp()
    const { createGitServices } = await import('../../git/index')
    const services = createGitServices({
      worktreeRoot,
      registryPath: join(worktreeRoot, 'registry.json'),
    })
    const sm = new SessionManager()
    sm.setGitServices(services)
    const wsRoot = tmp()
    const managed = injectSession(sm, 's1', wsRoot, { workingDirectory: '/repo' })
    const checkout = {
      schemaVersion: 1,
      mode: 'current' as const,
      repositoryRoot: '/repo',
      checkoutPath: '/repo',
      branchAtPreparation: null,
      baseRef: null,
      managedWorktreeId: null,
      expectedBranch: null,
    }

    await sm.commitHandoffBinding({ sessionId: 's1', checkout: checkout as any, executionCwd: '/srv/dest' })

    expect(managed.handoffRuntimeState).toBe('unverified')
    expect(loadStoredSession(wsRoot, 's1')?.handoffRuntimeState).toBe('unverified')
    expect(loadStoredSession(wsRoot, 's1')?.workingDirectory).toBe('/srv/dest')
  })

  test('sendMessage preflight failure returns the session to idle (regression)', async () => {
    const { sm } = makeManager()
    const wsRoot = tmp()
    const managed = injectSession(sm, 's-preflight', wsRoot, {
      workingDirectory: '/srv/dest',
      handoffRuntimeState: 'unverified',
    })
    // The agent build succeeds, but the execution-CWD proof fails, so
    // verifyHandoffRuntimeBeforeSend throws after isProcessing was set.
    ;(sm as any).getOrCreateAgent = async () => ({
      executionCwdRebind: createDeterministicHandoffAdapter({ adapterId: 'det', failVerify: true }),
    })

    // The message was acked before the proof ran; the failure is routed via
    // the event stream (error + complete) and sendMessage resolves normally.
    await (sm as any).sendMessage('s-preflight', 'hello')

    // The session must not stay stuck in isProcessing: a later send would
    // otherwise enter the queue path with no active chat to drain.
    expect(managed.isProcessing).toBe(false)
    expect(managed.handoffRuntimeState).toBe('recovery-required')
  })
})
