import type { SpawnTask, SpawnTaskAwaitingInput, SpawnTaskFailure, SpawnTaskResult } from '@kata-sh/core';
import { isSpawnTaskTerminal } from './transitions.ts';

/** Store-owned terminalization for a verified artifact found during reload. */
export function finalizeRecoveredSpawnTask(
  task: SpawnTask,
  result: SpawnTaskResult,
): SpawnTask {
  if (isSpawnTaskTerminal(task.runtimeState)) {
    throw new Error(`Cannot recover-finalize terminal spawned-task state ${task.runtimeState}`);
  }

  const finalized: SpawnTask = {
    ...task,
    version: task.version + 1,
    runtimeState: 'completed',
    stateTimestamps: {
      ...task.stateTimestamps,
      updatedAt: result.committedAt,
      completedAt: result.committedAt,
    },
    result,
  };
  delete (finalized as { awaitingInput?: SpawnTaskAwaitingInput }).awaitingInput;
  delete (finalized as { failure?: SpawnTaskFailure }).failure;
  return finalized;
}
