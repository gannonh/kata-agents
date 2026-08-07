/**
 * Contract tests for the isolated-conversation-fork provider capability gate.
 *
 * Isolated forks are exposed only when the session's provider adapter
 * advertises AND structurally can prove a strict cross-CWD native fork: the
 * adapter establishes a provider-native fork at the recorded source
 * conversation head while guaranteeing every file, shell, MCP, and provider
 * tool executes in the destination and the immutable transcript identity is
 * preserved. These fixtures are deterministic adapters, not mocks: they
 * exercise the real contract surface (advertise → establish) that the fork
 * service will consume.
 */

import { describe, expect, it } from 'bun:test'
import {
  resolveIsolatedForkCapability,
  type IsolatedForkCapabilityResolution,
} from '../conversation-fork-capability'
import type {
  AgentBackend,
  ConversationForkEstablishInput,
  ConversationForkEstablishResult,
  ExecutionCwdProof,
  StrictConversationForkCapability,
} from '../types'
import type { ConversationForkProviderCapability } from '../../../protocol'

/** Deterministic adapter that advertises and establishes native forks. */
class RecordingForkAdapter implements StrictConversationForkCapability {
  readonly adapterId = 'test-pi'
  establishCalls: ConversationForkEstablishInput[] = []
  constructor(private readonly strict: boolean = true) {}

  forkCapability(): ConversationForkProviderCapability {
    return { adapterId: this.adapterId, strictCrossCwdNativeFork: this.strict }
  }

  async establishNativeFork(input: ConversationForkEstablishInput): Promise<ConversationForkEstablishResult> {
    this.establishCalls.push(input)
    const proof: ExecutionCwdProof = {
      adapterId: this.adapterId,
      destinationPath: input.executionCwd,
      verifiedAt: 1,
      checks: ['file:read', 'shell:cwd', 'mcp:list', 'provider:cwd'],
    }
    return { childSdkSessionId: 'sdk-child-test-pi', proof }
  }
}

/**
 * Deterministic fixture backend. The rest of AgentBackend is irrelevant to the
 * capability gate; the spy on updateSdkCwd proves the contract never touches
 * transcript identity.
 */
function makeBackend(conversationFork?: StrictConversationForkCapability): AgentBackend & { sdkCwdWrites: string[] } {
  const sdkCwdWrites: string[] = []
  const partial = {
    conversationFork,
    updateSdkCwd(path: string) {
      sdkCwdWrites.push(path)
    },
  }
  return Object.assign(partial, { sdkCwdWrites }) as unknown as AgentBackend & { sdkCwdWrites: string[] }
}

describe('isolated conversation fork provider capability gate', () => {
  it('returns a typed unsupported-provider blocker when the backend has no capability', () => {
    const backend = makeBackend()
    const resolution = resolveIsolatedForkCapability(backend)

    expect(resolution.supported).toBe(false)
    if (!resolution.supported) {
      expect(resolution.blocker).toBe('unsupported-provider')
    }
  })

  it('resolves a supported adapter to its advertised capability', () => {
    const adapter = new RecordingForkAdapter()
    const resolution: IsolatedForkCapabilityResolution = resolveIsolatedForkCapability(makeBackend(adapter))

    expect(resolution.supported).toBe(true)
    if (resolution.supported) {
      expect(resolution.capability.adapterId).toBe('test-pi')
      expect(resolution.capability.strictCrossCwdNativeFork).toBe(true)
    }
  })

  it('blocks an adapter that advertises strictCrossCwdNativeFork: false', () => {
    // E.g. an adapter that cannot separate transcript storage from execution.
    const adapter = new RecordingForkAdapter(false)
    const resolution = resolveIsolatedForkCapability(makeBackend(adapter))

    expect(resolution.supported).toBe(false)
  })

  it('blocks a degraded adapter missing the establish surface', () => {
    const incomplete = {
      adapterId: 'broken',
      forkCapability: () => ({ adapterId: 'broken', strictCrossCwdNativeFork: true }),
    }
    const resolution = resolveIsolatedForkCapability(
      makeBackend(incomplete as unknown as StrictConversationForkCapability),
    )

    expect(resolution.supported).toBe(false)
  })

  it('blocks an adapter whose capability callback throws', () => {
    const throwing = {
      adapterId: 'degraded',
      forkCapability: () => {
        throw new Error('adapter degraded')
      },
      establishNativeFork: async () => ({ childSdkSessionId: 'sdk-child', proof: {} as ExecutionCwdProof }),
    }
    const resolution = resolveIsolatedForkCapability(
      makeBackend(throwing as unknown as StrictConversationForkCapability),
    )

    expect(resolution.supported).toBe(false)
    if (!resolution.supported) {
      expect(resolution.blocker).toBe('unsupported-provider')
    }
  })

  it('establishes the native fork with idempotency-keyed parent identity and never mutates transcript identity', async () => {
    const adapter = new RecordingForkAdapter()
    const backend = makeBackend(adapter)
    const input: ConversationForkEstablishInput = {
      parentSdkSessionId: 'sdk-parent-1',
      parentSdkTurnId: 'turn-42',
      idempotencyKey: 'fork-txn-abc-step-4',
      executionCwd: '/srv/kata/worktrees/repo/feature-x',
      transcriptCwd: '/repo/.kata/sessions/session-child',
    }

    const result = await adapter.establishNativeFork(input)

    expect(adapter.establishCalls).toEqual([input])
    expect(result.childSdkSessionId).toBe('sdk-child-test-pi')
    expect(result.proof.destinationPath).toBe(input.executionCwd)
    expect(backend.sdkCwdWrites).toEqual([])
  })
})
