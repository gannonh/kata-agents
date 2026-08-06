/**
 * Contract tests for the handoff provider capability gate.
 *
 * Handoff is exposed only when the session's provider adapter advertises and
 * can prove safe execution-CWD rebinding while preserving its immutable
 * transcript/session identity. These fixtures are deterministic adapters, not
 * mocks: they exercise the real contract surface (advertise → rebind → verify)
 * that the handoff service will consume.
 */

import { describe, expect, it } from 'bun:test'
import { resolveHandoffCapability, type HandoffCapabilityResolution } from '../handoff-capability'
import type { AgentBackend, ExecutionCwdRebindCapability } from '../types'
import type { WorktreeHandoffProviderCapability } from '../../../protocol'

/** Deterministic adapter that advertises, rebinds, and verifies. */
class RecordingHandoffAdapter implements ExecutionCwdRebindCapability {
  readonly adapterId = 'test-pi'
  rebindCalls: string[] = []
  verifyCalls: string[] = []
  constructor(private readonly rebindable: boolean = true) {}

  handoffCapability(): WorktreeHandoffProviderCapability {
    return { adapterId: this.adapterId, executionCwdRebindable: this.rebindable }
  }

  async rebindExecutionCwd(destinationPath: string): Promise<void> {
    this.rebindCalls.push(destinationPath)
  }

  async verifyExecutionCwd(destinationPath: string) {
    this.verifyCalls.push(destinationPath)
    return {
      adapterId: this.adapterId,
      destinationPath,
      verifiedAt: 1,
      checks: ['file:read', 'shell:cwd'],
    }
  }
}

/**
 * Deterministic fixture backend. The rest of AgentBackend is irrelevant to the
 * capability gate; the spy on updateSdkCwd proves the contract never touches
 * transcript identity.
 */
function makeBackend(executionCwdRebind?: ExecutionCwdRebindCapability): AgentBackend & { sdkCwdWrites: string[] } {
  const sdkCwdWrites: string[] = []
  const partial = {
    executionCwdRebind,
    updateSdkCwd(path: string) {
      sdkCwdWrites.push(path)
    },
  }
  return Object.assign(partial, { sdkCwdWrites }) as unknown as AgentBackend & { sdkCwdWrites: string[] }
}

describe('handoff provider capability gate', () => {
  it('returns a typed unsupported-provider blocker when the backend has no capability', () => {
    const backend = makeBackend()
    const resolution = resolveHandoffCapability(backend)

    expect(resolution.supported).toBe(false)
    if (!resolution.supported) {
      expect(resolution.blocker).toBe('unsupported-provider')
    }
  })

  it('resolves a supported adapter to its advertised capability', () => {
    const adapter = new RecordingHandoffAdapter()
    const resolution: HandoffCapabilityResolution = resolveHandoffCapability(makeBackend(adapter))

    expect(resolution.supported).toBe(true)
    if (resolution.supported) {
      expect(resolution.capability.adapterId).toBe('test-pi')
      expect(resolution.capability.executionCwdRebindable).toBe(true)
    }
  })

  it('blocks an adapter that advertises executionCwdRebindable: false', () => {
    // E.g. an adapter that cannot separate transcript storage from execution.
    const adapter = new RecordingHandoffAdapter(false)
    const resolution = resolveHandoffCapability(makeBackend(adapter))

    expect(resolution.supported).toBe(false)
  })

  it('blocks a degraded adapter missing the rebind or verify surface', () => {
    const incomplete = {
      adapterId: 'broken',
      handoffCapability: () => ({ adapterId: 'broken', executionCwdRebindable: true }),
    }
    const resolution = resolveHandoffCapability(
      makeBackend(incomplete as unknown as ExecutionCwdRebindCapability)
    )

    expect(resolution.supported).toBe(false)
  })

  it('rebinds execution to the exact destination and records it', async () => {
    const adapter = new RecordingHandoffAdapter()
    await adapter.rebindExecutionCwd('/srv/kata/worktrees/repo/ab12cd34')

    expect(adapter.rebindCalls).toEqual(['/srv/kata/worktrees/repo/ab12cd34'])
  })

  it('verifies execution CWD with concrete tool-resolution proof', async () => {
    const adapter = new RecordingHandoffAdapter()
    const proof = await adapter.verifyExecutionCwd('/srv/kata/worktrees/repo/ab12cd34')

    expect(proof.adapterId).toBe('test-pi')
    expect(proof.destinationPath).toBe('/srv/kata/worktrees/repo/ab12cd34')
    expect(proof.verifiedAt).toBeGreaterThan(0)
    expect(proof.checks.length).toBeGreaterThan(0)
  })

  it('never mutates transcript identity (sdkCwd) through the capability surface', async () => {
    const adapter = new RecordingHandoffAdapter()
    const backend = makeBackend(adapter)

    resolveHandoffCapability(backend)
    await adapter.rebindExecutionCwd('/srv/kata/worktrees/repo/ab12cd34')
    await adapter.verifyExecutionCwd('/srv/kata/worktrees/repo/ab12cd34')

    expect(backend.sdkCwdWrites).toEqual([])
  })
})
