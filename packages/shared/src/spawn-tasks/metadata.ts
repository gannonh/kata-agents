import type { SpawnTask, SpawnTaskIntegrityError } from '@kata-sh/core';
import { isSpawnTaskTerminal } from './transitions.ts';

export interface SpawnTaskMetadataUpdate {
  readonly at: string;
  readonly resultReadAt?: string;
  readonly parentDeletedAt?: string;
  readonly childDeletedAt?: string;
  /** null clears the marker after a verified atomic artifact repair. */
  readonly integrityError?: SpawnTaskIntegrityError | null;
}

export function requestSpawnTaskCancellation(
  task: SpawnTask,
  requestedAt: string,
  reason: string,
): SpawnTask {
  if (isSpawnTaskTerminal(task.runtimeState)) return task;
  if (!reason.trim()) throw new Error('Spawned-task cancellation reason must not be empty');
  if (task.cancellation) {
    if (task.cancellation.requestedAt === requestedAt && task.cancellation.reason === reason) return task;
    throw new Error('Spawned-task cancellation request is immutable once persisted');
  }

  return {
    ...task,
    version: task.version + 1,
    stateTimestamps: {
      ...task.stateTimestamps,
      updatedAt: requestedAt,
    },
    cancellation: { requestedAt, reason },
  };
}

export function updateSpawnTaskMetadata(
  task: SpawnTask,
  update: SpawnTaskMetadataUpdate,
): SpawnTask {
  if (update.resultReadAt !== undefined && task.runtimeState !== 'completed') {
    throw new Error('Result read metadata requires a completed spawned task');
  }
  if (update.integrityError !== undefined && task.runtimeState !== 'completed') {
    throw new Error('Integrity metadata requires a completed spawned task');
  }
  if (task.parentDeletedAt && update.parentDeletedAt && task.parentDeletedAt !== update.parentDeletedAt) {
    throw new Error('Parent deletion marker is immutable once set');
  }
  if (task.childDeletedAt && update.childDeletedAt && task.childDeletedAt !== update.childDeletedAt) {
    throw new Error('Child deletion marker is immutable once set');
  }

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
