/**
 * Isolated conversation fork provider capability gate.
 *
 * Isolated forks are exposed only when the session's provider adapter
 * advertises AND is structurally able to prove a strict cross-CWD native
 * fork: establishing the provider-native child at the recorded source
 * conversation head while every file, shell, MCP, and provider tool executes
 * in the destination and the immutable transcript identity is preserved.
 * Unsupported adapters resolve to a typed `unsupported-provider` blocker;
 * the existing missing-anchor/full-history fallback is never used for the
 * isolated strategy.
 */

import type { ConversationForkProviderCapability } from '../../protocol'
import type { AgentBackend, StrictConversationForkCapability } from './types'

export type IsolatedForkCapabilityResolution =
  | { supported: true; capability: ConversationForkProviderCapability }
  | { supported: false; blocker: 'unsupported-provider' }

function isCompleteCapability(value: StrictConversationForkCapability): boolean {
  return (
    typeof value.forkCapability === 'function' &&
    typeof value.establishNativeFork === 'function'
  )
}

/**
 * Resolve whether a backend may expose isolated conversation forks. Requires
 * the adapter to advertise `strictCrossCwdNativeFork: true` AND implement the
 * full advertise + establish surface. Live proof is demanded at first Send
 * (establishNativeFork's proof) before the child provider ID is persisted;
 * this gate decides whether isolated is offered at all.
 */
export function resolveIsolatedForkCapability(
  backend: Pick<AgentBackend, 'conversationFork'>,
): IsolatedForkCapabilityResolution {
  const adapter = backend.conversationFork
  if (!adapter || !isCompleteCapability(adapter)) {
    return { supported: false, blocker: 'unsupported-provider' }
  }
  let capability: ConversationForkProviderCapability | undefined
  try {
    capability = adapter.forkCapability()
  } catch {
    // A degraded adapter may throw inside the capability callback; the
    // documented typed blocker beats a generic error escaping the gate.
    return { supported: false, blocker: 'unsupported-provider' }
  }
  if (!capability || capability.strictCrossCwdNativeFork !== true) {
    return { supported: false, blocker: 'unsupported-provider' }
  }
  return { supported: true, capability }
}
