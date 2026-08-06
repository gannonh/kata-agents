/**
 * Handoff provider capability gate.
 *
 * Handoff is exposed only when the session's provider adapter advertises AND
 * is structurally able to prove safe execution-CWD rebinding while preserving
 * its immutable transcript/session identity. Unsupported adapters resolve to a
 * typed `unsupported-provider` blocker; V1 behavior is preserved (no handoff
 * surface, no mutation).
 */

import type { WorktreeHandoffProviderCapability } from '../../protocol'
import type { AgentBackend, ExecutionCwdRebindCapability } from './types'

export type HandoffCapabilityResolution =
  | { supported: true; capability: WorktreeHandoffProviderCapability }
  | { supported: false; blocker: 'unsupported-provider' }

function isCompleteCapability(value: ExecutionCwdRebindCapability): boolean {
  return (
    typeof value.handoffCapability === 'function' &&
    typeof value.rebindExecutionCwd === 'function' &&
    typeof value.verifyExecutionCwd === 'function'
  )
}

/**
 * Resolve whether a backend may expose handoff. Requires the adapter to
 * advertise `executionCwdRebindable: true` AND implement the full rebind +
 * verify surface. Live proof is demanded at confirm time (verifyExecutionCwd)
 * before Send unlocks; this gate decides whether handoff is offered at all.
 */
export function resolveHandoffCapability(
  backend: Pick<AgentBackend, 'executionCwdRebind'>
): HandoffCapabilityResolution {
  const adapter = backend.executionCwdRebind
  if (!adapter || !isCompleteCapability(adapter)) {
    return { supported: false, blocker: 'unsupported-provider' }
  }
  const capability = adapter.handoffCapability()
  if (!capability || capability.executionCwdRebindable !== true) {
    return { supported: false, blocker: 'unsupported-provider' }
  }
  return { supported: true, capability }
}
