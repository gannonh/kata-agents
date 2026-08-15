/**
 * Canonical spawned-task persistence and read contract.
 *
 * Keep this domain separate from SessionStatus: task runtime describes delegated
 * execution, while session status remains user-controlled workflow metadata.
 */

export const SPAWN_TASK_SCHEMA_VERSION = 1 as const;

export const SPAWN_TASK_RUNTIME_STATES = [
  'queued',
  'processing',
  'awaiting-input',
  'completed',
  'failed',
  'cancelled',
] as const;

export type SpawnTaskRuntimeState = (typeof SPAWN_TASK_RUNTIME_STATES)[number];

export const SPAWN_TASK_DISPATCH_STATES = [
  'reserved',
  'ready',
  'claimed',
  'sent',
] as const;

export type SpawnTaskDispatchState = (typeof SPAWN_TASK_DISPATCH_STATES)[number];

export const SPAWN_TASK_FAILURE_CODES = [
  'spawn_persist_failed',
  'dispatch_interrupted',
  'provider_error',
  'tool_error',
  'input_interrupted',
  'cancel_failed',
  'result_too_large',
  'result_persist_failed',
  'unknown',
] as const;

export type SpawnTaskFailureCode = (typeof SPAWN_TASK_FAILURE_CODES)[number];
export type SpawnTaskAwaitingInputKind = 'permission' | 'authentication';

/** Bounds are UTF-8 byte counts, not JavaScript string lengths. */
export const SPAWN_TASK_LIMITS = Object.freeze({
  resultBytes: 8 * 1024 * 1024,
  resultReadBytes: 64 * 1024,
  resultPreviewBytes: 4 * 1024,
  failureMessageBytes: 4 * 1024,
  failureDetailsBytes: 4 * 1024,
  promptSummaryBytes: 4 * 1024,
});

export type SpawnTaskJsonPrimitive = string | number | boolean | null;
export type SpawnTaskJsonValue =
  | SpawnTaskJsonPrimitive
  | readonly SpawnTaskJsonValue[]
  | { readonly [key: string]: SpawnTaskJsonValue };

export interface SpawnTaskStateTimestamps {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly queuedAt: string;
  readonly processingAt?: string;
  readonly awaitingInputAt?: string;
  readonly completedAt?: string;
  readonly failedAt?: string;
  readonly cancelledAt?: string;
}

export interface SpawnTaskDispatchMetadata {
  readonly state: SpawnTaskDispatchState;
  readonly dispatchAttemptId: string;
  readonly messageId: string;
  readonly reservedAt: string;
  readonly readyAt?: string;
  readonly claimedAt?: string;
  readonly sentAt?: string;
}

export interface SpawnTaskAwaitingInput {
  readonly kind: SpawnTaskAwaitingInputKind;
  readonly requestId: string;
  readonly promptSummary: string;
  readonly createdAt: string;
}

export interface SpawnTaskCancellation {
  readonly requestedAt: string;
  readonly reason: string;
}

export interface SpawnTaskResult {
  readonly artifactPath: 'result.md';
  readonly byteLength: number;
  readonly sha256: string;
  readonly sourceMessageId?: string;
  readonly committedAt: string;
  /** UTF-8 prefix capped by SPAWN_TASK_LIMITS.resultPreviewBytes. */
  readonly preview: string;
}

export interface SpawnTaskFailureDetails {
  readonly kind?: SpawnTaskAwaitingInputKind;
  readonly [key: string]: SpawnTaskJsonValue | undefined;
}

export interface SpawnTaskFailure {
  readonly code: SpawnTaskFailureCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: SpawnTaskFailureDetails;
  readonly committedAt: string;
}

export interface SpawnTaskIntegrityError {
  readonly code: 'result_persist_failed';
  readonly message: string;
  readonly detectedAt: string;
}

/** Durable workspace-owned task record. Identity and delegation fields never change. */
export interface SpawnTask {
  readonly schemaVersion: typeof SPAWN_TASK_SCHEMA_VERSION;
  readonly version: number;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly parentSessionId: string;
  readonly childSessionId: string;
  readonly delegatedPrompt: string;
  readonly childConfig: Readonly<Record<string, SpawnTaskJsonValue>>;
  readonly runtimeState: SpawnTaskRuntimeState;
  readonly stateTimestamps: SpawnTaskStateTimestamps;
  readonly dispatch: SpawnTaskDispatchMetadata;
  readonly awaitingInput?: SpawnTaskAwaitingInput;
  readonly cancellation?: SpawnTaskCancellation;
  readonly result?: SpawnTaskResult;
  readonly failure?: SpawnTaskFailure;
  readonly resultReadAt?: string;
  readonly parentDeletedAt?: string;
  readonly childDeletedAt?: string;
  /** Metadata only: this never changes a terminal runtime outcome. */
  readonly integrityError?: SpawnTaskIntegrityError;
}

/** Wire-neutral canonical task read view. Authorization wrappers may omit fields, not redefine them. */
export type SpawnTaskView = Readonly<SpawnTask>;

export type SpawnTaskTerminalSuccessView = SpawnTaskView & {
  readonly runtimeState: 'completed';
  readonly result: SpawnTaskResult;
  readonly failure?: never;
  readonly awaitingInput?: never;
};

export type SpawnTaskTerminalFailureView = SpawnTaskView & {
  readonly runtimeState: 'failed';
  readonly failure: SpawnTaskFailure;
  readonly result?: never;
  readonly awaitingInput?: never;
};

export type SpawnTaskTerminalCancellationView = SpawnTaskView & {
  readonly runtimeState: 'cancelled';
  readonly cancellation: SpawnTaskCancellation;
  readonly result?: never;
  readonly failure?: never;
  readonly awaitingInput?: never;
};

export type SpawnTaskTerminalView =
  | SpawnTaskTerminalSuccessView
  | SpawnTaskTerminalFailureView
  | SpawnTaskTerminalCancellationView;

export interface SpawnTaskResultView {
  readonly taskId: string;
  readonly runtimeState: 'completed';
  readonly result: SpawnTaskResult;
  readonly integrityError?: SpawnTaskIntegrityError;
}

/**
 * Exact byte-oriented result slice. dataBase64 preserves chunks that split a
 * multi-byte UTF-8 sequence; callers can concatenate decoded bytes losslessly.
 */
export interface SpawnTaskResultChunkView {
  readonly taskId: string;
  readonly offset: number;
  readonly nextOffset: number;
  readonly byteLength: number;
  readonly totalByteLength: number;
  readonly sha256: string;
  readonly dataBase64: string;
  readonly truncated: boolean;
}

export interface SpawnTaskIntegrityView {
  readonly taskId: string;
  readonly runtimeState: 'completed';
  readonly result: SpawnTaskResult;
  readonly integrityError: SpawnTaskIntegrityError;
}
