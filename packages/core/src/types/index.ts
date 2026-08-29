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
  SpawnTaskOrigin,
  SpawnTaskJsonPrimitive,
  SpawnTaskJsonValue,
  SpawnTaskStateTimestamps,
  SpawnTaskDispatchMetadata,
  SpawnTaskDispatchFence,
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
  SPAWN_TASK_RESULT_ARTIFACT_PATH,
  SPAWN_TASK_RUNTIME_STATES,
  SPAWN_TASK_DISPATCH_STATES,
  SPAWN_TASK_FAILURE_CODES,
  SPAWN_TASK_LIMITS,
} from './spawn-task.ts';
export { SPAWN_TASK_CANONICAL_FIXTURE } from './spawn-task-fixture.ts';

// Ordered public conversation history
export type {
  ConversationId,
  JournalEntry,
  JournalEntryId,
  JournalEntryKind,
  JournalCursor,
} from './conversation.ts';
export {
  CONVERSATION_SCHEMA_VERSION,
  CONVERSATION_LIMITS,
  JOURNAL_ENTRY_KINDS,
} from './conversation.ts';

// Bot identity and DirectChat contracts
export type {
  BotId,
  BotLifecycle,
  BotPermissionMode,
  DirectChatId,
  LegacySessionDisposition,
  CreationIntentState,
  BotProviderConfig,
  BotRecord,
  BotPublicDto,
  DirectChatRecord,
  CreationIntent,
  SessionDispositionRecord,
} from './bot.ts';
export {
  BOT_SCHEMA_VERSION,
  BOT_LIFECYCLES,
  BOT_PERMISSION_MODES,
  LEGACY_SESSION_DISPOSITIONS,
  CREATION_INTENT_STATES,
  BOT_LIMITS,
} from './bot.ts';

export type {
  HandoffId,
  HandoffDeliveryId,
  DeliveryClaimId,
  HandoffMailState,
  HandoffDeliveryClaim,
  HandoffDeliveryFailure,
  HandoffDeliveryRecord,
  HandoffDeliveryPending,
  HandoffDeliveryClaimed,
  HandoffDeliveryAcknowledged,
  HandoffDeliveryFailed,
  HandoffTaskView,
} from './handoff.ts';
export {
  HANDOFF_SCHEMA_VERSION,
  HANDOFF_LIMITS,
  HANDOFF_MAIL_STATES,
  HANDOFF_MAIL_TRANSITIONS,
} from './handoff.ts';

export type {
  BotMemoryState,
  BotMemoryMutationKind,
  BotMemoryProvenance,
  BotMemoryRecord,
  BotMemoryExclusion,
  BotMemoryHead,
  BotMemoryMutation,
  BotMemoryCandidate,
  BotCompactionCheckpoint,
  BotContextCursor,
  BotContextRun,
  BotTurnContext,
  BotContextSnapshot,
} from './bot-memory.ts';
export {
  BOT_MEMORY_SCHEMA_VERSION,
  BOT_MEMORY_STATES,
  BOT_MEMORY_MUTATION_KINDS,
  BOT_MEMORY_LIMITS,
} from './bot-memory.ts';

// Channel membership and autonomous routing contracts
export type {
  ChannelId,
  ChannelLifecycle,
  ChannelMember,
  ChannelPublicDto,
  ChannelRecord,
  ClaimOutcome,
  MemberAvailability,
  RouteBlockReason,
  RouteClaim,
  RouteId,
  RouteMode,
  RouteRecord,
  RouteStage,
  RouteStageState,
  StageCancelReason,
  StageId,
} from './channel.ts';
export {
  CHANNEL_SCHEMA_VERSION,
  CHANNEL_LIFECYCLES,
  CHANNEL_LIMITS,
  CLAIM_OUTCOMES,
  MEMBER_AVAILABILITIES,
  ROUTE_BLOCK_REASONS,
  ROUTE_MODES,
  ROUTE_STAGE_STATES,
  STAGE_CANCEL_REASONS,
} from './channel.ts';

// Message persistence mappers
export { messageToStored, storedToMessage } from './message-mapper.ts';

// Server types (headless operations)
export type {
  ServerStatus,
  ServerHealth,
  SessionProcessingStatus,
  ActiveSessionInfo,
} from './server.ts';
