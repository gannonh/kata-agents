import type {
  SpawnTask,
  SpawnTaskAwaitingInput,
  SpawnTaskCancellation,
  SpawnTaskFailure,
  SpawnTaskResult,
  SpawnTaskRuntimeState,
} from '@kata-sh/core';

const LEGAL_TRANSITIONS: Readonly<Record<SpawnTaskRuntimeState, readonly SpawnTaskRuntimeState[]>> = {
  queued: ['processing', 'cancelled'],
  processing: ['awaiting-input', 'completed', 'failed', 'cancelled'],
  'awaiting-input': ['processing', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export type SpawnTaskTransition =
  | { readonly runtimeState: 'processing'; readonly at: string }
  | { readonly runtimeState: 'awaiting-input'; readonly at: string; readonly awaitingInput: SpawnTaskAwaitingInput }
  | { readonly runtimeState: 'completed'; readonly at: string; readonly result: SpawnTaskResult }
  | { readonly runtimeState: 'failed'; readonly at: string; readonly failure: SpawnTaskFailure }
  | { readonly runtimeState: 'cancelled'; readonly at: string; readonly cancellation: SpawnTaskCancellation };

export class SpawnTaskTransitionError extends Error {
  constructor(from: SpawnTaskRuntimeState, to: SpawnTaskRuntimeState) {
    super(`Illegal spawned-task runtime transition: ${from} -> ${to}`);
    this.name = 'SpawnTaskTransitionError';
  }
}

export function canTransitionSpawnTask(
  from: SpawnTaskRuntimeState,
  to: SpawnTaskRuntimeState,
): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export function isSpawnTaskTerminal(state: SpawnTaskRuntimeState): boolean {
  return LEGAL_TRANSITIONS[state].length === 0;
}

export function transitionSpawnTask(task: SpawnTask, transition: SpawnTaskTransition): SpawnTask {
  const nextState = transition.runtimeState;
  if (!canTransitionSpawnTask(task.runtimeState, nextState)) {
    throw new SpawnTaskTransitionError(task.runtimeState, nextState);
  }

  const stateTimestamps = {
    ...task.stateTimestamps,
    updatedAt: transition.at,
    ...(nextState === 'processing' ? { processingAt: transition.at } : {}),
    ...(nextState === 'awaiting-input' ? { awaitingInputAt: transition.at } : {}),
    ...(nextState === 'completed' ? { completedAt: transition.at } : {}),
    ...(nextState === 'failed' ? { failedAt: transition.at } : {}),
    ...(nextState === 'cancelled' ? { cancelledAt: transition.at } : {}),
  };

  const next: SpawnTask = {
    ...task,
    version: task.version + 1,
    runtimeState: nextState,
    stateTimestamps,
  };

  delete (next as { awaitingInput?: SpawnTaskAwaitingInput }).awaitingInput;
  delete (next as { result?: SpawnTaskResult }).result;
  delete (next as { failure?: SpawnTaskFailure }).failure;

  switch (nextState) {
    case 'processing':
      return next;
    case 'awaiting-input':
      return { ...next, awaitingInput: transition.awaitingInput };
    case 'completed':
      return { ...next, result: transition.result };
    case 'failed':
      return { ...next, failure: transition.failure };
    case 'cancelled':
      return { ...next, cancellation: transition.cancellation };
    default: {
      const exhaustive: never = nextState;
      throw new Error(`Unhandled spawned-task runtime state: ${exhaustive}`);
    }
  }
}
