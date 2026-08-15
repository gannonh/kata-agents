import {
  SPAWN_TASK_DISPATCH_STATES,
  SPAWN_TASK_FAILURE_CODES,
  SPAWN_TASK_LIMITS,
  SPAWN_TASK_RUNTIME_STATES,
  SPAWN_TASK_SCHEMA_VERSION,
  type SpawnTask,
  type SpawnTaskJsonValue,
} from '@kata-sh/core';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function fail(message: string): never {
  throw new TypeError(`Invalid spawned-task record: ${message}`);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string') fail(`${field} must be a string`);
  return value;
}

function timestamp(value: unknown, field: string): string {
  const text = string(value, field);
  if (!Number.isFinite(Date.parse(text))) fail(`${field} must be an ISO timestamp`);
  return text;
}

function positiveInteger(value: unknown, field: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || (allowZero ? Number(value) < 0 : Number(value) < 1)) {
    fail(`${field} must be a ${allowZero ? 'non-negative' : 'positive'} safe integer`);
  }
  return value as number;
}

export function assertSpawnTaskId(value: unknown, field = 'id'): string {
  const id = string(value, field);
  if (!SAFE_ID.test(id) || id === '.' || id === '..') fail(`${field} is not an opaque path-safe ID`);
  return id;
}

function assertJsonValue(value: unknown, field: string): asserts value is SpawnTaskJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${field}[${index}]`));
    return;
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      assertJsonValue(item, `${field}.${key}`);
    }
    return;
  }
  fail(`${field} must contain JSON values only`);
}

export function assertSpawnTask(value: unknown): SpawnTask {
  const task = object(value, 'task');
  if (task.schemaVersion !== SPAWN_TASK_SCHEMA_VERSION) fail('unsupported schemaVersion');
  positiveInteger(task.version, 'version');
  assertSpawnTaskId(task.taskId, 'taskId');
  assertSpawnTaskId(task.workspaceId, 'workspaceId');
  assertSpawnTaskId(task.parentSessionId, 'parentSessionId');
  assertSpawnTaskId(task.childSessionId, 'childSessionId');
  string(task.delegatedPrompt, 'delegatedPrompt');
  const childConfig = object(task.childConfig, 'childConfig');
  assertJsonValue(childConfig, 'childConfig');

  const runtimeState = string(task.runtimeState, 'runtimeState');
  if (!(SPAWN_TASK_RUNTIME_STATES as readonly string[]).includes(runtimeState)) fail('unknown runtimeState');

  const stateTimestamps = object(task.stateTimestamps, 'stateTimestamps');
  timestamp(stateTimestamps.createdAt, 'stateTimestamps.createdAt');
  timestamp(stateTimestamps.updatedAt, 'stateTimestamps.updatedAt');
  timestamp(stateTimestamps.queuedAt, 'stateTimestamps.queuedAt');
  for (const key of ['processingAt', 'awaitingInputAt', 'completedAt', 'failedAt', 'cancelledAt']) {
    if (stateTimestamps[key] !== undefined) timestamp(stateTimestamps[key], `stateTimestamps.${key}`);
  }

  const dispatch = object(task.dispatch, 'dispatch');
  const dispatchState = string(dispatch.state, 'dispatch.state');
  if (!(SPAWN_TASK_DISPATCH_STATES as readonly string[]).includes(dispatchState)) fail('unknown dispatch.state');
  assertSpawnTaskId(dispatch.dispatchAttemptId, 'dispatch.dispatchAttemptId');
  assertSpawnTaskId(dispatch.messageId, 'dispatch.messageId');
  timestamp(dispatch.reservedAt, 'dispatch.reservedAt');
  for (const key of ['readyAt', 'claimedAt', 'sentAt']) {
    if (dispatch[key] !== undefined) timestamp(dispatch[key], `dispatch.${key}`);
  }

  if (task.awaitingInput !== undefined) {
    const awaiting = object(task.awaitingInput, 'awaitingInput');
    if (awaiting.kind !== 'permission' && awaiting.kind !== 'authentication') fail('unknown awaitingInput.kind');
    assertSpawnTaskId(awaiting.requestId, 'awaitingInput.requestId');
    const summary = string(awaiting.promptSummary, 'awaitingInput.promptSummary');
    if (Buffer.byteLength(summary, 'utf8') > SPAWN_TASK_LIMITS.promptSummaryBytes) fail('awaitingInput.promptSummary exceeds byte limit');
    timestamp(awaiting.createdAt, 'awaitingInput.createdAt');
  }

  if (task.cancellation !== undefined) {
    const cancellation = object(task.cancellation, 'cancellation');
    timestamp(cancellation.requestedAt, 'cancellation.requestedAt');
    string(cancellation.reason, 'cancellation.reason');
  }

  if (task.result !== undefined) {
    const result = object(task.result, 'result');
    if (result.artifactPath !== 'result.md') fail('result.artifactPath must be result.md');
    positiveInteger(result.byteLength, 'result.byteLength', true);
    if (!SHA256.test(string(result.sha256, 'result.sha256'))) fail('result.sha256 must be lowercase SHA-256');
    if (result.sourceMessageId !== undefined) assertSpawnTaskId(result.sourceMessageId, 'result.sourceMessageId');
    timestamp(result.committedAt, 'result.committedAt');
    const preview = string(result.preview, 'result.preview');
    if (Buffer.byteLength(preview, 'utf8') > SPAWN_TASK_LIMITS.resultPreviewBytes) fail('result.preview exceeds byte limit');
  }

  if (task.failure !== undefined) {
    const failure = object(task.failure, 'failure');
    const code = string(failure.code, 'failure.code');
    if (!(SPAWN_TASK_FAILURE_CODES as readonly string[]).includes(code)) fail('unknown failure.code');
    const message = string(failure.message, 'failure.message');
    if (Buffer.byteLength(message, 'utf8') > SPAWN_TASK_LIMITS.failureMessageBytes) fail('failure.message exceeds byte limit');
    if (typeof failure.retryable !== 'boolean') fail('failure.retryable must be boolean');
    if (failure.details !== undefined) {
      const details = object(failure.details, 'failure.details');
      assertJsonValue(details, 'failure.details');
      if (Buffer.byteLength(JSON.stringify(details), 'utf8') > SPAWN_TASK_LIMITS.failureDetailsBytes) fail('failure.details exceeds byte limit');
    }
    timestamp(failure.committedAt, 'failure.committedAt');
  }

  if (task.integrityError !== undefined) {
    const integrity = object(task.integrityError, 'integrityError');
    if (integrity.code !== 'result_persist_failed') fail('unknown integrityError.code');
    string(integrity.message, 'integrityError.message');
    timestamp(integrity.detectedAt, 'integrityError.detectedAt');
    if (runtimeState !== 'completed') fail('integrityError requires completed runtimeState');
  }

  if (task.resultReadAt !== undefined) timestamp(task.resultReadAt, 'resultReadAt');
  if (task.parentDeletedAt !== undefined) timestamp(task.parentDeletedAt, 'parentDeletedAt');
  if (task.childDeletedAt !== undefined) timestamp(task.childDeletedAt, 'childDeletedAt');

  if (runtimeState === 'awaiting-input' && task.awaitingInput === undefined) fail('awaiting-input state requires awaitingInput');
  if (runtimeState !== 'awaiting-input' && task.awaitingInput !== undefined) fail('awaitingInput requires awaiting-input state');
  if (runtimeState === 'completed' && task.result === undefined) fail('completed state requires result');
  if (runtimeState !== 'completed' && task.result !== undefined) fail('result requires completed state');
  if (runtimeState === 'failed' && task.failure === undefined) fail('failed state requires failure');
  if (runtimeState !== 'failed' && task.failure !== undefined) fail('failure requires failed state');
  if (runtimeState === 'cancelled' && task.cancellation === undefined) fail('cancelled state requires cancellation');

  return value as SpawnTask;
}
