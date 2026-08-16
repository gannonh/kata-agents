import {
  SPAWN_TASK_DISPATCH_STATES,
  SPAWN_TASK_FAILURE_CODES,
  SPAWN_TASK_LIMITS,
  SPAWN_TASK_RESULT_ARTIFACT_PATH,
  SPAWN_TASK_RUNTIME_STATES,
  SPAWN_TASK_SCHEMA_VERSION,
  type SpawnTask,
  type SpawnTaskJsonValue,
  type SpawnTaskResult,
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

function exactKeys(value: Record<string, unknown>, field: string, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${field}.${key} is unknown`);
  }
}

function timestamp(value: unknown, field: string): string {
  const text = string(value, field);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text) || !Number.isFinite(Date.parse(text))) {
    fail(`${field} must be an ISO timestamp`);
  }
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

export function assertSpawnTaskResult(value: unknown, field = 'result'): SpawnTaskResult {
  const result = object(value, field);
  exactKeys(result, field, [
    'artifactPath',
    'byteLength',
    'sha256',
    'sourceMessageId',
    'committedAt',
    'preview',
  ]);
  if (result.artifactPath !== SPAWN_TASK_RESULT_ARTIFACT_PATH) {
    fail(`${field}.artifactPath must be ${SPAWN_TASK_RESULT_ARTIFACT_PATH}`);
  }
  const byteLength = positiveInteger(result.byteLength, `${field}.byteLength`, true);
  if (byteLength > SPAWN_TASK_LIMITS.resultBytes) fail(`${field}.byteLength exceeds byte limit`);
  if (!SHA256.test(string(result.sha256, `${field}.sha256`))) fail(`${field}.sha256 must be lowercase SHA-256`);
  if (result.sourceMessageId !== undefined) assertSpawnTaskId(result.sourceMessageId, `${field}.sourceMessageId`);
  timestamp(result.committedAt, `${field}.committedAt`);
  const preview = string(result.preview, `${field}.preview`);
  const previewBytes = Buffer.byteLength(preview, 'utf8');
  if (previewBytes > SPAWN_TASK_LIMITS.resultPreviewBytes || previewBytes > byteLength) {
    fail(`${field}.preview exceeds byte limit`);
  }
  return value as SpawnTaskResult;
}

export function assertSpawnTask(value: unknown): SpawnTask {
  const task = object(value, 'task');
  exactKeys(task, 'task', [
    'schemaVersion',
    'version',
    'taskId',
    'workspaceId',
    'parentSessionId',
    'childSessionId',
    'delegatedPrompt',
    'childConfig',
    'runtimeState',
    'stateTimestamps',
    'dispatch',
    'awaitingInput',
    'cancellation',
    'result',
    'failure',
    'resultReadAt',
    'parentDeletedAt',
    'childDeletedAt',
    'integrityError',
  ]);
  if (task.schemaVersion !== SPAWN_TASK_SCHEMA_VERSION) fail('unsupported schemaVersion');
  positiveInteger(task.version, 'version');
  assertSpawnTaskId(task.taskId, 'taskId');
  assertSpawnTaskId(task.workspaceId, 'workspaceId');
  assertSpawnTaskId(task.parentSessionId, 'parentSessionId');
  assertSpawnTaskId(task.childSessionId, 'childSessionId');
  string(task.delegatedPrompt, 'delegatedPrompt');
  const childConfig = object(task.childConfig, 'childConfig');
  assertJsonValue(childConfig, 'childConfig');
  if (Buffer.byteLength(JSON.stringify(childConfig), 'utf8') > SPAWN_TASK_LIMITS.childConfigBytes) {
    fail('childConfig exceeds byte limit');
  }

  const runtimeState = string(task.runtimeState, 'runtimeState');
  if (!(SPAWN_TASK_RUNTIME_STATES as readonly string[]).includes(runtimeState)) fail('unknown runtimeState');

  const stateTimestamps = object(task.stateTimestamps, 'stateTimestamps');
  exactKeys(stateTimestamps, 'stateTimestamps', [
    'createdAt',
    'updatedAt',
    'queuedAt',
    'processingAt',
    'awaitingInputAt',
    'completedAt',
    'failedAt',
    'cancelledAt',
  ]);
  timestamp(stateTimestamps.createdAt, 'stateTimestamps.createdAt');
  timestamp(stateTimestamps.updatedAt, 'stateTimestamps.updatedAt');
  timestamp(stateTimestamps.queuedAt, 'stateTimestamps.queuedAt');
  for (const key of ['processingAt', 'awaitingInputAt', 'completedAt', 'failedAt', 'cancelledAt']) {
    if (stateTimestamps[key] !== undefined) timestamp(stateTimestamps[key], `stateTimestamps.${key}`);
  }

  const dispatch = object(task.dispatch, 'dispatch');
  exactKeys(dispatch, 'dispatch', [
    'state',
    'dispatchAttemptId',
    'messageId',
    'reservedAt',
    'readyAt',
    'claimedAt',
    'sentAt',
  ]);
  const dispatchState = string(dispatch.state, 'dispatch.state');
  if (!(SPAWN_TASK_DISPATCH_STATES as readonly string[]).includes(dispatchState)) fail('unknown dispatch.state');
  assertSpawnTaskId(dispatch.dispatchAttemptId, 'dispatch.dispatchAttemptId');
  assertSpawnTaskId(dispatch.messageId, 'dispatch.messageId');
  timestamp(dispatch.reservedAt, 'dispatch.reservedAt');
  for (const key of ['readyAt', 'claimedAt', 'sentAt']) {
    if (dispatch[key] !== undefined) timestamp(dispatch[key], `dispatch.${key}`);
  }
  const requiredDispatchTimestamps: Record<string, readonly string[]> = {
    reserved: [],
    ready: ['readyAt'],
    claimed: ['readyAt', 'claimedAt'],
    sent: ['readyAt', 'claimedAt', 'sentAt'],
  };
  const allowedDispatchTimestamps = new Set(requiredDispatchTimestamps[dispatchState]);
  for (const key of ['readyAt', 'claimedAt', 'sentAt']) {
    if (allowedDispatchTimestamps.has(key) !== (dispatch[key] !== undefined)) {
      fail(`dispatch.${key} is inconsistent with dispatch state ${dispatchState}`);
    }
  }

  if (task.awaitingInput !== undefined) {
    const awaiting = object(task.awaitingInput, 'awaitingInput');
    exactKeys(awaiting, 'awaitingInput', ['kind', 'requestId', 'promptSummary', 'createdAt']);
    if (awaiting.kind !== 'permission' && awaiting.kind !== 'authentication') fail('unknown awaitingInput.kind');
    assertSpawnTaskId(awaiting.requestId, 'awaitingInput.requestId');
    const summary = string(awaiting.promptSummary, 'awaitingInput.promptSummary');
    if (Buffer.byteLength(summary, 'utf8') > SPAWN_TASK_LIMITS.promptSummaryBytes) fail('awaitingInput.promptSummary exceeds byte limit');
    timestamp(awaiting.createdAt, 'awaitingInput.createdAt');
  }

  if (task.cancellation !== undefined) {
    const cancellation = object(task.cancellation, 'cancellation');
    exactKeys(cancellation, 'cancellation', ['requestedAt', 'reason']);
    timestamp(cancellation.requestedAt, 'cancellation.requestedAt');
    const reason = string(cancellation.reason, 'cancellation.reason');
    if (!reason.trim() || Buffer.byteLength(reason, 'utf8') > SPAWN_TASK_LIMITS.failureMessageBytes) {
      fail('cancellation.reason must be non-empty and bounded');
    }
  }

  if (task.result !== undefined) assertSpawnTaskResult(task.result);

  if (task.failure !== undefined) {
    const failure = object(task.failure, 'failure');
    exactKeys(failure, 'failure', ['code', 'message', 'retryable', 'details', 'committedAt']);
    const code = string(failure.code, 'failure.code');
    if (!(SPAWN_TASK_FAILURE_CODES as readonly string[]).includes(code)) fail('unknown failure.code');
    const message = string(failure.message, 'failure.message');
    if (Buffer.byteLength(message, 'utf8') > SPAWN_TASK_LIMITS.failureMessageBytes) fail('failure.message exceeds byte limit');
    if (typeof failure.retryable !== 'boolean') fail('failure.retryable must be boolean');
    let details: Record<string, unknown> | undefined;
    if (failure.details !== undefined) {
      details = object(failure.details, 'failure.details');
      assertJsonValue(details, 'failure.details');
      if (Buffer.byteLength(JSON.stringify(details), 'utf8') > SPAWN_TASK_LIMITS.failureDetailsBytes) fail('failure.details exceeds byte limit');
    }
    if (code === 'input_interrupted' && details?.kind !== 'permission' && details?.kind !== 'authentication') {
      fail('input_interrupted failure requires details.kind permission|authentication');
    }
    timestamp(failure.committedAt, 'failure.committedAt');
  }

  if (task.integrityError !== undefined) {
    const integrity = object(task.integrityError, 'integrityError');
    exactKeys(integrity, 'integrityError', ['code', 'message', 'detectedAt']);
    if (integrity.code !== 'result_persist_failed') fail('unknown integrityError.code');
    string(integrity.message, 'integrityError.message');
    timestamp(integrity.detectedAt, 'integrityError.detectedAt');
    if (runtimeState !== 'completed') fail('integrityError requires completed runtimeState');
  }

  if (task.resultReadAt !== undefined) {
    timestamp(task.resultReadAt, 'resultReadAt');
    if (runtimeState !== 'completed') fail('resultReadAt requires completed runtimeState');
  }
  if (task.parentDeletedAt !== undefined) timestamp(task.parentDeletedAt, 'parentDeletedAt');
  if (task.childDeletedAt !== undefined) timestamp(task.childDeletedAt, 'childDeletedAt');

  const stateTimestamp = runtimeState === 'awaiting-input'
    ? 'awaitingInputAt'
    : `${runtimeState}At`;
  if (stateTimestamps[stateTimestamp] === undefined) {
    fail(`stateTimestamps.${stateTimestamp} is required for ${runtimeState} state`);
  }

  if (runtimeState === 'awaiting-input' && task.awaitingInput === undefined) fail('awaiting-input state requires awaitingInput');
  if (runtimeState !== 'awaiting-input' && task.awaitingInput !== undefined) fail('awaitingInput requires awaiting-input state');
  if (runtimeState === 'completed' && task.result === undefined) fail('completed state requires result');
  if (runtimeState !== 'completed' && task.result !== undefined) fail('result requires completed state');
  if (runtimeState === 'failed' && task.failure === undefined) fail('failed state requires failure');
  if (runtimeState !== 'failed' && task.failure !== undefined) fail('failure requires failed state');
  if (runtimeState === 'cancelled' && task.cancellation === undefined) fail('cancelled state requires cancellation');

  return value as SpawnTask;
}
