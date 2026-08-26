/**
 * Canonical Bot directory and conversation journal contract.
 *
 * A Bot owns exactly one DirectChat. The journal holds the ordered public
 * entries for that chat. Public DTOs never carry session IDs, credentials,
 * host paths, or callback identities.
 */

export const BOT_SCHEMA_VERSION = 1 as const;

/** Bounds are UTF-8 byte counts, not JavaScript string lengths. */
export const BOT_LIMITS = Object.freeze({
  nameBytes: 256,
  profileBytes: 8 * 1024,
  journalEntryBytes: 256 * 1024,
  idempotencyKeyBytes: 512,
  providerIdBytes: 256,
  modelIdBytes: 256,
});

export const BOT_LIFECYCLES = ['active', 'hidden', 'archived'] as const;
export type BotLifecycle = (typeof BOT_LIFECYCLES)[number];

export const BOT_PERMISSION_MODES = ['safe', 'ask', 'allow-all'] as const;
export type BotPermissionMode = (typeof BOT_PERMISSION_MODES)[number];

export const LEGACY_SESSION_DISPOSITIONS = [
  'legacy-readonly',
  'converted',
  'provider-execution',
] as const;
export type LegacySessionDisposition = (typeof LEGACY_SESSION_DISPOSITIONS)[number];

export const JOURNAL_ENTRY_KINDS = ['user', 'bot', 'tool', 'error', 'lifecycle'] as const;
export type JournalEntryKind = (typeof JOURNAL_ENTRY_KINDS)[number];

export const CREATION_INTENT_STATES = ['reserved', 'published', 'abandoned'] as const;
export type CreationIntentState = (typeof CREATION_INTENT_STATES)[number];

/** `bot_<uuid>` */
export type BotId = string;
/** `chat_<uuid>` */
export type DirectChatId = string;
/** `entry_<hash>` */
export type JournalEntryId = string;

export interface BotProviderConfig {
  readonly providerId: string;
  readonly modelId: string;
}

export interface BotRecord {
  readonly schemaVersion: typeof BOT_SCHEMA_VERSION;
  readonly botId: BotId;
  readonly workspaceId: string;
  readonly directChatId: DirectChatId;
  readonly name: string;
  readonly profile?: string;
  readonly permissionMode: BotPermissionMode;
  readonly providerConfig: BotProviderConfig;
  readonly lifecycle: BotLifecycle;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt?: string;
  readonly hiddenAt?: string;
  readonly legacySessionId?: string;
}

export interface BotPublicDto {
  readonly botId: BotId;
  readonly workspaceId: string;
  readonly directChatId: DirectChatId;
  readonly name: string;
  readonly profile?: string;
  readonly permissionMode: BotPermissionMode;
  readonly providerConfig: BotProviderConfig;
  readonly lifecycle: BotLifecycle;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt?: string;
  readonly hiddenAt?: string;
}

export interface DirectChatRecord {
  readonly schemaVersion: typeof BOT_SCHEMA_VERSION;
  readonly chatId: DirectChatId;
  readonly botId: BotId;
  readonly workspaceId: string;
  readonly createdAt: string;
}

export interface CreationIntent {
  readonly schemaVersion: typeof BOT_SCHEMA_VERSION;
  readonly intentId: string;
  readonly workspaceId: string;
  readonly botId: BotId;
  readonly directChatId: DirectChatId;
  readonly idempotencyKey: string;
  readonly name: string;
  readonly profile?: string;
  readonly permissionMode: BotPermissionMode;
  readonly providerConfig: BotProviderConfig;
  readonly legacySessionId?: string;
  readonly state: CreationIntentState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly publishedAt?: string;
}

export interface JournalEntry {
  readonly schemaVersion: typeof BOT_SCHEMA_VERSION;
  readonly entryId: JournalEntryId;
  readonly chatId: DirectChatId;
  readonly botId: BotId;
  readonly seq: number;
  readonly kind: JournalEntryKind;
  readonly idempotencyKey: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface JournalCursor {
  readonly chatId: DirectChatId;
  readonly lastReadSeq: number;
  readonly unreadCount: number;
}

export interface SessionDispositionRecord {
  readonly schemaVersion: typeof BOT_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly disposition: LegacySessionDisposition;
  readonly botId?: BotId;
  readonly chatId?: DirectChatId;
  readonly convertedAt?: string;
  readonly cutoverMarkerEntryId?: JournalEntryId;
}
