import type { SpawnTask, SpawnTaskIntegrityError } from '@kata-sh/core';

export interface SpawnTaskMetadataUpdate {
  readonly at: string;
  readonly resultReadAt?: string;
  readonly parentDeletedAt?: string;
  readonly childDeletedAt?: string;
  /** null clears the marker after a verified atomic artifact repair. */
  readonly integrityError?: SpawnTaskIntegrityError | null;
}

export function updateSpawnTaskMetadata(
  task: SpawnTask,
  update: SpawnTaskMetadataUpdate,
): SpawnTask {
  return {
    ...task,
    version: task.version + 1,
    stateTimestamps: {
      ...task.stateTimestamps,
      updatedAt: update.at,
    },
    ...(update.resultReadAt !== undefined ? { resultReadAt: update.resultReadAt } : {}),
    ...(update.parentDeletedAt !== undefined ? { parentDeletedAt: update.parentDeletedAt } : {}),
    ...(update.childDeletedAt !== undefined ? { childDeletedAt: update.childDeletedAt } : {}),
    ...(update.integrityError === null
      ? { integrityError: undefined }
      : update.integrityError !== undefined
        ? { integrityError: update.integrityError }
        : {}),
  };
}
