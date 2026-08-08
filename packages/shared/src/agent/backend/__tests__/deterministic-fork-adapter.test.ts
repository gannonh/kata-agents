import { describe, test, expect } from 'bun:test'
import { createDeterministicStrictForkAdapter } from '../testing'
import { resolveIsolatedForkCapability } from '../conversation-fork-capability'
import type { ConversationForkEstablishInput } from '../types'

const INPUT: ConversationForkEstablishInput = {
  parentSdkSessionId: 'sdk-parent-1',
  parentSdkTurnId: 'turn-42',
  idempotencyKey: 'fork-txn-abc-step-4',
  executionCwd: '/srv/kata/worktrees/repo/feature-x',
  transcriptCwd: '/repo/.kata/sessions/session-child',
}

describe('deterministic strict fork adapter factory', () => {
  test('produces a complete strict capability with all four proof categories', async () => {
    const adapter = createDeterministicStrictForkAdapter({ adapterId: 'det-fork' })

    expect(adapter.adapterId).toBe('det-fork')
    expect(adapter.forkCapability()).toEqual({
      adapterId: 'det-fork',
      strictCrossCwdNativeFork: true,
    })
    const result = await adapter.establishNativeFork(INPUT)
    expect(result.childSdkSessionId).toBe('sdk-child-det-fork')
    expect(result.proof.adapterId).toBe('det-fork')
    expect(result.proof.destinationPath).toBe(INPUT.executionCwd)
    expect(result.proof.checks).toEqual(['file:read', 'shell:cwd', 'mcp:list', 'provider:cwd'])
  })

  test('records establish calls with the idempotency-keyed input when a log is supplied', async () => {
    const establishLog: Array<{ input: ConversationForkEstablishInput; childSdkSessionId: string }> = []
    const adapter = createDeterministicStrictForkAdapter({ establishLog })
    await adapter.establishNativeFork(INPUT)
    expect(establishLog).toHaveLength(1)
    expect(establishLog[0]!.input).toEqual(INPUT)
    expect(establishLog[0]!.childSdkSessionId).toBe('sdk-child-deterministic-strict-fork')
  })

  test('failEstablish makes native-fork establishment throw without touching the capability', async () => {
    const adapter = createDeterministicStrictForkAdapter({ failEstablish: true })
    await expect(adapter.establishNativeFork(INPUT)).rejects.toThrow('establish refused')
    // The capability gate is about advertisement, not the live establishment.
    expect(adapter.forkCapability().strictCrossCwdNativeFork).toBe(true)
  })

  test('missingChecks drops exactly the requested categories from the proof', async () => {
    const adapter = createDeterministicStrictForkAdapter({ missingChecks: ['mcp', 'provider'] })
    const result = await adapter.establishNativeFork(INPUT)
    expect(result.proof.checks).toEqual(['file:read', 'shell:cwd'])
  })

  test('honors a childSdkSessionId override for deterministic assertions', async () => {
    const adapter = createDeterministicStrictForkAdapter({ childSdkSessionId: 'sdk-child-e2e' })
    const result = await adapter.establishNativeFork(INPUT)
    expect(result.childSdkSessionId).toBe('sdk-child-e2e')
  })

  test('an adapter with missing categories still passes the capability gate but yields an incomplete proof', async () => {
    const adapter = createDeterministicStrictForkAdapter({ missingChecks: ['shell'] })
    expect(adapter.forkCapability().strictCrossCwdNativeFork).toBe(true)
    const resolution = resolveIsolatedForkCapability({ conversationFork: adapter })
    expect(resolution.supported).toBe(true)
    const result = await adapter.establishNativeFork(INPUT)
    expect(result.proof.checks.some((check) => check.startsWith('shell:'))).toBe(false)
  })

  // Retrying the same idempotency key never produces a different child ID;
  // persist-exactly-once dedupe itself is the fork service's responsibility
  // (the fixture records every call and does not dedupe).
  test('retrying establish with the same key returns the same child provider ID', async () => {
    const establishLog: Array<{ input: ConversationForkEstablishInput; childSdkSessionId: string }> = []
    const adapter = createDeterministicStrictForkAdapter({ establishLog })
    await adapter.establishNativeFork(INPUT)
    await adapter.establishNativeFork(INPUT)
    expect(establishLog).toHaveLength(2)
    expect(establishLog[0]!.childSdkSessionId).toBe(establishLog[1]!.childSdkSessionId)
    expect(establishLog[1]!.input.idempotencyKey).toBe(INPUT.idempotencyKey)
  })
})
