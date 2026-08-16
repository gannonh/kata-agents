import type {
  SpawnTask,
  SpawnTaskResultChunkView,
  SpawnTaskTerminalCancellationView,
  SpawnTaskTerminalFailureView,
  SpawnTaskTerminalSuccessView,
  SpawnTaskView,
} from './spawn-task.ts';

const reserved = {
  schemaVersion: 1,
  version: 1,
  taskId: 'task_018f47b8-c4af-7d15-9f46-0242ac120002',
  workspaceId: 'ws_fixture',
  parentSessionId: 'session_parent_fixture',
  childSessionId: 'session_child_fixture',
  delegatedPrompt: 'Summarize the durable task contract.',
  childConfig: {
    model: 'fixture-model',
    permissionMode: 'safe',
    enabledSources: ['docs'],
  },
  runtimeState: 'queued',
  stateTimestamps: {
    createdAt: '2026-01-02T03:04:05.000Z',
    updatedAt: '2026-01-02T03:04:05.000Z',
    queuedAt: '2026-01-02T03:04:05.000Z',
  },
  dispatch: {
    state: 'reserved',
    dispatchAttemptId: 'attempt_018f47b8-c4af-7d15-9f46-0242ac120003',
    messageId: 'message_018f47b8-c4af-7d15-9f46-0242ac120004',
    reservedAt: '2026-01-02T03:04:05.000Z',
  },
} as const satisfies SpawnTask;

const awaitingInput = {
  ...reserved,
  version: 3,
  runtimeState: 'awaiting-input',
  stateTimestamps: {
    ...reserved.stateTimestamps,
    updatedAt: '2026-01-02T03:06:05.000Z',
    processingAt: '2026-01-02T03:05:05.000Z',
    awaitingInputAt: '2026-01-02T03:06:05.000Z',
  },
  dispatch: {
    ...reserved.dispatch,
    state: 'sent',
    readyAt: '2026-01-02T03:04:15.000Z',
    claimedAt: '2026-01-02T03:04:20.000Z',
    sentAt: '2026-01-02T03:04:25.000Z',
  },
  awaitingInput: {
    kind: 'permission',
    requestId: 'permission_fixture',
    promptSummary: 'Allow reading the fixture directory?',
    createdAt: '2026-01-02T03:06:05.000Z',
  },
} as const satisfies SpawnTaskView;

const completed = {
  ...reserved,
  version: 8,
  runtimeState: 'completed',
  stateTimestamps: {
    ...reserved.stateTimestamps,
    updatedAt: '2026-01-02T03:10:05.000Z',
    processingAt: '2026-01-02T03:05:05.000Z',
    completedAt: '2026-01-02T03:09:05.000Z',
  },
  dispatch: awaitingInput.dispatch,
  result: {
    artifactPath: 'result.md',
    byteLength: 3,
    sha256: '1dabba21cdad44541f6b15796f8d22978fc7ea10c46aeceeeeb66c23b3ac7604',
    sourceMessageId: 'child_message_fixture',
    committedAt: '2026-01-02T03:09:05.000Z',
    preview: '✓',
  },
  resultReadAt: '2026-01-02T03:10:05.000Z',
  parentDeletedAt: '2026-01-02T04:00:00.000Z',
  childDeletedAt: '2026-01-02T04:01:00.000Z',
  integrityError: {
    code: 'result_persist_failed',
    message: 'Fixture integrity marker.',
    detectedAt: '2026-01-02T04:02:00.000Z',
  },
} as const satisfies SpawnTaskTerminalSuccessView;

const failed = {
  ...reserved,
  version: 5,
  runtimeState: 'failed',
  stateTimestamps: {
    ...reserved.stateTimestamps,
    updatedAt: '2026-01-02T03:08:05.000Z',
    processingAt: '2026-01-02T03:05:05.000Z',
    awaitingInputAt: '2026-01-02T03:06:05.000Z',
    failedAt: '2026-01-02T03:08:05.000Z',
  },
  dispatch: awaitingInput.dispatch,
  failure: {
    code: 'input_interrupted',
    message: 'Authentication input was interrupted.',
    retryable: true,
    details: { kind: 'authentication' },
    committedAt: '2026-01-02T03:08:05.000Z',
  },
} as const satisfies SpawnTaskTerminalFailureView;

const cancelled = {
  ...reserved,
  version: 2,
  runtimeState: 'cancelled',
  stateTimestamps: {
    ...reserved.stateTimestamps,
    updatedAt: '2026-01-02T03:05:00.000Z',
    cancelledAt: '2026-01-02T03:05:00.000Z',
  },
  cancellation: {
    requestedAt: '2026-01-02T03:04:59.000Z',
    reason: 'parent_deleted',
  },
} as const satisfies SpawnTaskTerminalCancellationView;

const resultChunk = {
  taskId: completed.taskId,
  offset: 0,
  nextOffset: 3,
  byteLength: 3,
  totalByteLength: 3,
  sha256: completed.result.sha256,
  dataBase64: '4pyT',
  truncated: false,
} as const satisfies SpawnTaskResultChunkView;

/** One canonical fixture suite for domain and future tool/RPC/renderer parity tests. */
export const SPAWN_TASK_CANONICAL_FIXTURE = Object.freeze({
  schemaVersion: 1,
  tasks: Object.freeze({ reserved, awaitingInput, completed, failed, cancelled }),
  resultChunk,
});
