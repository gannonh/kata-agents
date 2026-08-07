import { describe, test, expect } from 'bun:test'
import { createDeterministicHandoffAdapter } from '../deterministic-handoff-adapter'
import { resolveHandoffCapability } from '../handoff-capability'

describe('deterministic handoff adapter factory', () => {
  test('produces a complete capability with all four proof categories', async () => {
    const adapter = createDeterministicHandoffAdapter({ adapterId: 'det-test' })

    expect(adapter.adapterId).toBe('det-test')
    expect(adapter.handoffCapability()).toEqual({ adapterId: 'det-test', executionCwdRebindable: true })
    const proof = await adapter.verifyExecutionCwd('/srv/dest')
    expect(proof.adapterId).toBe('det-test')
    expect(proof.destinationPath).toBe('/srv/dest')
    expect(proof.checks).toEqual(['file:read', 'shell:cwd', 'mcp:list', 'provider:cwd'])
    await expect(adapter.rebindExecutionCwd('/srv/dest')).resolves.toBeUndefined()
  })

  test('records rebinds when a log is supplied', async () => {
    const rebindLog: string[] = []
    const adapter = createDeterministicHandoffAdapter({ rebindLog })
    await adapter.rebindExecutionCwd('/first')
    await adapter.rebindExecutionCwd('/second')
    expect(rebindLog).toEqual(['/first', '/second'])
  })

  test('failRebind makes rebinding throw without touching verification', async () => {
    const adapter = createDeterministicHandoffAdapter({ failRebind: true })
    await expect(adapter.rebindExecutionCwd('/srv/dest')).rejects.toThrow('rebind refused')
    await expect(adapter.verifyExecutionCwd('/srv/dest')).resolves.toMatchObject({ destinationPath: '/srv/dest' })
  })

  test('failVerify makes proof acquisition throw', async () => {
    const adapter = createDeterministicHandoffAdapter({ failVerify: true })
    await expect(adapter.verifyExecutionCwd('/srv/dest')).rejects.toThrow('verify refused')
  })

  test('missingChecks drops exactly the requested categories from the proof', async () => {
    const adapter = createDeterministicHandoffAdapter({ missingChecks: ['mcp', 'provider'] })
    const proof = await adapter.verifyExecutionCwd('/srv/dest')
    expect(proof.checks).toEqual(['file:read', 'shell:cwd'])
  })

  test('an adapter with missing categories still passes the capability gate but yields an incomplete proof', async () => {
    const adapter = createDeterministicHandoffAdapter({ missingChecks: ['shell'] })
    const capability = adapter.handoffCapability()
    // The capability advertises support; the live proof gate (checks) is what
    // rejects the incomplete proof at confirm/Send time.
    expect(capability.executionCwdRebindable).toBe(true)
    const resolution = resolveHandoffCapability({ executionCwdRebind: adapter })
    expect(resolution.supported).toBe(true)
    const proof = await adapter.verifyExecutionCwd('/srv/dest')
    expect(proof.checks.some((check) => check.startsWith('shell:'))).toBe(false)
  })
})
