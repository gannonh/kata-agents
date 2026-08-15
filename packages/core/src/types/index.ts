/**
 * Re-export all types from @kata-sh/core
 */

// Workspace and config types
export type {
  WorkspaceInfo,
  Workspace,
  RemoteServerConfig,
  McpAuthType,
  AuthType,
  OAuthCredentials,
  StoredConfig,
} from './workspace.ts';

// Session types
export type {
  Session,
  StoredSession,
  SessionMetadata,
  SessionStatus,
} from './session.ts';

// Message types
export type {
  MessageRole,
  ToolStatus,
  ToolDisplayMeta,
  AttachmentType,
  MessageAttachment,
  StoredAttachment,
  ContentBadge,
  AnnotationAuthor,
  AnnotationBody,
  AnnotationIntent,
  AnnotationStatus,
  AnnotationBlockType,
  AnnotationSelector,
  AnnotationTarget,
  AnnotationV1,
  Message,
  StoredMessage,
  TokenUsage,
  AgentEventUsage,
  RecoveryAction,
  ErrorCode,
  TypedError,
  PermissionRequest,
  AgentEvent,
  // Auth-related types
  CredentialInputMode,
  AuthRequestType,
  AuthStatus,
} from './message.ts';
export { generateMessageId } from './message.ts';

// Spawned task types and canonical parity fixture
export type {
  SpawnTaskRuntimeState,
  SpawnTaskDispatchState,
  SpawnTaskFailureCode,
  SpawnTaskAwaitingInputKind,
  SpawnTaskJsonPrimitive,
  SpawnTaskJsonValue,
  SpawnTaskStateTimestamps,
  SpawnTaskDispatchMetadata,
  SpawnTaskAwaitingInput,
  SpawnTaskCancellation,
  SpawnTaskResult,
  SpawnTaskFailureDetails,
  SpawnTaskFailure,
  SpawnTaskIntegrityError,
  SpawnTask,
  SpawnTaskView,
  SpawnTaskTerminalSuccessView,
  SpawnTaskTerminalFailureView,
  SpawnTaskTerminalCancellationView,
  SpawnTaskTerminalView,
  SpawnTaskResultView,
  SpawnTaskResultChunkView,
  SpawnTaskIntegrityView,
} from './spawn-task.ts';
export {
  SPAWN_TASK_SCHEMA_VERSION,
  SPAWN_TASK_RUNTIME_STATES,
  SPAWN_TASK_DISPATCH_STATES,
  SPAWN_TASK_FAILURE_CODES,
  SPAWN_TASK_LIMITS,
} from './spawn-task.ts';
export { SPAWN_TASK_CANONICAL_FIXTURE } from './spawn-task-fixture.ts';

// Message persistence mappers
export { messageToStored, storedToMessage } from './message-mapper.ts';

// Server types (headless operations)
export type {
  ServerStatus,
  ServerHealth,
  SessionProcessingStatus,
  ActiveSessionInfo,
} from './server.ts';

