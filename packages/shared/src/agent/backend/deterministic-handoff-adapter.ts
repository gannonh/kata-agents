/**
 * Deterministic handoff adapter factory (credential-free).
 *
 * The spec mandates deterministic provider adapters for state-machine coverage:
 * production adapters stay disabled until credentialed UAT, so tests and the
 * headless/E2E flows use this factory to exercise every handoff direction,
 * failure point, and proof gate without a live provider. Failure injection is
 * explicit per adapter instance; nothing here touches a real SDK runtime.
 */

import type { ExecutionCwdProof, ExecutionCwdRebindCapability } from './types'

export interface DeterministicHandoffAdapterOptions {
  /** Adapter identity stamped into capabilities and proofs. */
  adapterId?: string
  /** rebindExecutionCwd throws when true (runtime cannot quiesce/rebind). */
  failRebind?: boolean
  /** verifyExecutionCwd throws when true (proof acquisition fails). */
  failVerify?: boolean
  /** Proof categories to omit; the handoff gate requires all four. */
  missingChecks?: Array<'file' | 'shell' | 'mcp' | 'provider'>
  /** Rebind destinations recorded for later assertions (shared array). */
  rebindLog?: string[]
}

const PROOF_CATEGORIES = ['file', 'shell', 'mcp', 'provider'] as const

/**
 * Build a deterministic adapter whose rebind/verify succeed unless failure
 * injection is requested. `verifyExecutionCwd` always proves the exact
 * destination path with all four tool categories unless `missingChecks`
 * removes one — the handoff gate then fails the proof exactly like a broken
 * production adapter would.
 */
export function createDeterministicHandoffAdapter(
  options: DeterministicHandoffAdapterOptions = {},
): ExecutionCwdRebindCapability {
  const adapterId = options.adapterId ?? 'deterministic-handoff'
  const missing = new Set(options.missingChecks ?? [])
  return {
    adapterId,
    handoffCapability: () => ({ adapterId, executionCwdRebindable: true }),
    rebindExecutionCwd: async (destinationPath) => {
      if (options.failRebind) throw new Error(`deterministic adapter ${adapterId}: rebind refused`)
      options.rebindLog?.push(destinationPath)
    },
    verifyExecutionCwd: async (destinationPath): Promise<ExecutionCwdProof> => {
      if (options.failVerify) throw new Error(`deterministic adapter ${adapterId}: verify refused`)
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
      return {
        adapterId,
        destinationPath,
        verifiedAt: Date.now(),
        checks,
      }
    },
  }
}
