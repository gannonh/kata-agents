import type { SpawnTaskDispatchFence } from '@kata-sh/core';

export function matchesSpawnTaskDispatchFence(
  actual: SpawnTaskDispatchFence | undefined,
  expected: SpawnTaskDispatchFence,
): boolean {
  return actual?.deliveryId === expected.deliveryId
    && actual.claimId === expected.claimId
    && actual.recipientBotId === expected.recipientBotId
    && actual.ownerEpoch === expected.ownerEpoch;
}
