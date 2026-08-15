import { randomUUID } from 'node:crypto';

export interface SpawnTaskReservedIds {
  readonly taskId: string;
  readonly childSessionId: string;
  readonly messageId: string;
  readonly dispatchAttemptId: string;
}

export function reserveSpawnTaskIds(randomId: () => string = randomUUID): SpawnTaskReservedIds {
  return {
    taskId: `task_${randomId()}`,
    childSessionId: `session_${randomId()}`,
    messageId: `message_${randomId()}`,
    dispatchAttemptId: `attempt_${randomId()}`,
  };
}
