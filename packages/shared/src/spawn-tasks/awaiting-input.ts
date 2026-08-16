import {
  SPAWN_TASK_LIMITS,
  type SpawnTaskAwaitingInput,
  type SpawnTaskAwaitingInputKind,
} from '@kata-sh/core';
import { createSpawnTaskFailure } from './failures.ts';
import { assertSpawnTaskId } from './validation.ts';
import { truncateUtf8 } from './utf8.ts';

export interface CreateSpawnTaskAwaitingInputInput {
  readonly kind: SpawnTaskAwaitingInputKind;
  readonly requestId: string;
  readonly promptSummary: unknown;
  readonly createdAt: string;
}

/**
 * Build the only durable representation of a pending permission/auth request.
 * Raw provider payloads, credentials, commands, and headers never cross this
 * boundary; the summary uses the same redaction and UTF-8 bounds as failures.
 */
export function createSpawnTaskAwaitingInput(
  input: CreateSpawnTaskAwaitingInputInput,
): SpawnTaskAwaitingInput {
  if (input.kind !== 'permission' && input.kind !== 'authentication') {
    throw new TypeError('awaitingInput.kind must be permission|authentication');
  }
  const requestId = assertSpawnTaskId(input.requestId, 'awaitingInput.requestId');
  const promptSummary = createSpawnTaskFailure({
    code: 'unknown',
    message: input.promptSummary,
    retryable: false,
    committedAt: input.createdAt,
  }).message;

  return {
    kind: input.kind,
    requestId,
    promptSummary: truncateUtf8(promptSummary, SPAWN_TASK_LIMITS.promptSummaryBytes),
    createdAt: input.createdAt,
  };
}
