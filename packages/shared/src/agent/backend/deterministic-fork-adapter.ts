/**
 * Deterministic strict conversation-fork adapter factory (credential-free).
 *
 * The spec mandates deterministic provider adapters for state-machine coverage:
 * production adapters stay disabled until credentialed UAT, so tests and the
 * headless/E2E flows use this factory to exercise the first-Send native-fork
 * establishment, failure points, and the destination-execution proof gate
 * without a live provider. Failure injection is explicit per adapter instance;
 * nothing here touches a real SDK runtime.
 */

import type {
  ConversationForkEstablishInput,
  ConversationForkEstablishResult,
  ExecutionCwdProof,
  StrictConversationForkCapability,
} from './types'

const PROOF_CATEGORIES = ['file', 'shell', 'mcp', 'provider'] as const

export interface DeterministicStrictForkAdapterOptions {
  /** Adapter identity stamped into capabilities and proofs. */
  adapterId?: string
  /** establishNativeFork throws when true (native anchor missing/malformed). */
  failEstablish?: boolean
  /** Proof categories to omit; the strict fork requires all four. */
  missingChecks?: (typeof PROOF_CATEGORIES)[number][]
  /** Establish calls recorded for later assertions (shared array). */
  establishLog?: Array<{ input: ConversationForkEstablishInput; childSdkSessionId: string }>
  /** Deterministic child SDK session ID override. */
  childSdkSessionId?: string
}

/**
 * Build a deterministic strict fork adapter whose establish/verify succeed
 * unless failure injection is requested. `establishNativeFork` always returns
 * a stable child provider ID for the same adapter and proves the exact
 * destination execution CWD with all four tool categories unless
 * `missingChecks` removes one — the first-Send gate then rejects the proof
 * exactly like a broken production adapter would. Retrying the same
 * idempotency key never produces a different child ID.
 */
export function createDeterministicStrictForkAdapter(
  options: DeterministicStrictForkAdapterOptions = {},
): StrictConversationForkCapability {
  const adapterId = options.adapterId ?? 'deterministic-strict-fork'
  const childSdkSessionId = options.childSdkSessionId ?? `sdk-child-${adapterId}`
  const missing = new Set(options.missingChecks ?? [])
  return {
    adapterId,
    forkCapability: () => ({ adapterId, strictCrossCwdNativeFork: true }),
    establishNativeFork: async (
      input: ConversationForkEstablishInput,
    ): Promise<ConversationForkEstablishResult> => {
      if (options.failEstablish) {
        throw new Error(`deterministic adapter ${adapterId}: establish refused`)
      }
      options.establishLog?.push({ input, childSdkSessionId })
      const checks = PROOF_CATEGORIES.filter((category) => !missing.has(category)).map((category) => {
        switch (category) {
          case 'file':
            return 'file:read'
          case 'shell':
            return 'shell:cwd'
          case 'mcp':
            return 'mcp:list'
          case 'provider':
            return 'provider:cwd'
        }
      })
      const proof: ExecutionCwdProof = {
        adapterId,
        destinationPath: input.executionCwd,
        verifiedAt: Date.now(),
        checks,
      }
      return { childSdkSessionId, proof }
    },
  }
}
