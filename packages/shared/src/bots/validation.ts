import {
  BOT_LIFECYCLES,
  BOT_LIMITS,
  BOT_PERMISSION_MODES,
  BOT_SCHEMA_VERSION,
  CREATION_INTENT_STATES,
  LEGACY_SESSION_DISPOSITIONS,
  type BotProviderConfig,
  type BotRecord,
  type CreationIntent,
  type DirectChatRecord,
  type SessionDispositionRecord,
} from '@kata-sh/core';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/;

function fail(message: string): never {
  throw new TypeError(`Invalid bot record: ${message}`);
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

function bounded(value: unknown, field: string, maxBytes: number): string {
  const text = string(value, field);
  if (Buffer.byteLength(text, 'utf8') > maxBytes) fail(`${field} exceeds ${maxBytes} byte limit`);
  return text;
}

function timestamp(value: unknown, field: string): string {
  const text = string(value, field);
  if (!Number.isFinite(Date.parse(text))) fail(`${field} must be an ISO timestamp`);
  return text;
}

function member(value: unknown, field: string, allowed: readonly string[]): string {
  const text = string(value, field);
  if (!allowed.includes(text)) fail(`${field} must be one of ${allowed.join(', ')}`);
  return text;
}

export function assertBotId(value: unknown, field = 'id'): string {
  const id = string(value, field);
  if (!SAFE_ID.test(id) || id === '.' || id === '..') fail(`${field} is not an opaque path-safe ID`);
  return id;
}

export function assertIdempotencyKey(value: unknown, field = 'idempotencyKey'): string {
  const key = bounded(value, field, BOT_LIMITS.idempotencyKeyBytes);
  if (!key.trim()) fail(`${field} must be non-empty`);
  return key;
}

export function assertBotName(value: unknown, field = 'name'): string {
  const name = bounded(value, field, BOT_LIMITS.nameBytes);
  if (!name.trim()) fail(`${field} must be non-empty`);
  return name;
}

export function assertBotProfile(value: unknown, field = 'profile'): string {
  return bounded(value, field, BOT_LIMITS.profileBytes);
}

export function assertBotProviderConfig(value: unknown, field = 'providerConfig'): BotProviderConfig {
  const config = object(value, field);
  exactKeys(config, field, ['providerId', 'modelId']);
  bounded(config.providerId, `${field}.providerId`, BOT_LIMITS.providerIdBytes);
  if (!string(config.providerId, `${field}.providerId`).trim()) fail(`${field}.providerId must be non-empty`);
  bounded(config.modelId, `${field}.modelId`, BOT_LIMITS.modelIdBytes);
  if (!string(config.modelId, `${field}.modelId`).trim()) fail(`${field}.modelId must be non-empty`);
  return value as BotProviderConfig;
}

function assertSchemaVersion(value: unknown): void {
  if (value !== BOT_SCHEMA_VERSION) fail('unsupported schemaVersion');
}

export function assertBotRecord(value: unknown): BotRecord {
  const record = object(value, 'bot');
  exactKeys(record, 'bot', [
    'schemaVersion',
    'botId',
    'workspaceId',
    'directChatId',
    'name',
    'profile',
    'permissionMode',
    'providerConfig',
    'lifecycle',
    'createdAt',
    'updatedAt',
    'archivedAt',
    'hiddenAt',
    'legacySessionId',
  ]);
  assertSchemaVersion(record.schemaVersion);
  assertBotId(record.botId, 'botId');
  assertBotId(record.workspaceId, 'workspaceId');
  assertBotId(record.directChatId, 'directChatId');
  assertBotName(record.name);
  if (record.profile !== undefined) assertBotProfile(record.profile);
  member(record.permissionMode, 'permissionMode', BOT_PERMISSION_MODES);
  assertBotProviderConfig(record.providerConfig);
  const lifecycle = member(record.lifecycle, 'lifecycle', BOT_LIFECYCLES);
  timestamp(record.createdAt, 'createdAt');
  timestamp(record.updatedAt, 'updatedAt');
  if (record.archivedAt !== undefined) timestamp(record.archivedAt, 'archivedAt');
  if (record.hiddenAt !== undefined) timestamp(record.hiddenAt, 'hiddenAt');
  if (record.legacySessionId !== undefined) assertBotId(record.legacySessionId, 'legacySessionId');
  if (lifecycle === 'archived' && record.archivedAt === undefined) fail('archived bots require archivedAt');
  if (lifecycle === 'hidden' && record.hiddenAt === undefined) fail('hidden bots require hiddenAt');
  return value as BotRecord;
}

export function assertDirectChatRecord(value: unknown): DirectChatRecord {
  const record = object(value, 'chat');
  exactKeys(record, 'chat', ['schemaVersion', 'chatId', 'botId', 'workspaceId', 'createdAt']);
  assertSchemaVersion(record.schemaVersion);
  assertBotId(record.chatId, 'chatId');
  assertBotId(record.botId, 'botId');
  assertBotId(record.workspaceId, 'workspaceId');
  timestamp(record.createdAt, 'createdAt');
  return value as DirectChatRecord;
}

export function assertCreationIntent(value: unknown): CreationIntent {
  const intent = object(value, 'intent');
  exactKeys(intent, 'intent', [
    'schemaVersion',
    'intentId',
    'workspaceId',
    'botId',
    'directChatId',
    'idempotencyKey',
    'name',
    'profile',
    'permissionMode',
    'providerConfig',
    'legacySessionId',
    'state',
    'createdAt',
    'updatedAt',
    'publishedAt',
  ]);
  assertSchemaVersion(intent.schemaVersion);
  assertBotId(intent.intentId, 'intentId');
  assertBotId(intent.workspaceId, 'workspaceId');
  assertBotId(intent.botId, 'botId');
  assertBotId(intent.directChatId, 'directChatId');
  assertIdempotencyKey(intent.idempotencyKey);
  assertBotName(intent.name);
  if (intent.profile !== undefined) assertBotProfile(intent.profile);
  member(intent.permissionMode, 'permissionMode', BOT_PERMISSION_MODES);
  assertBotProviderConfig(intent.providerConfig);
  if (intent.legacySessionId !== undefined) assertBotId(intent.legacySessionId, 'legacySessionId');
  const state = member(intent.state, 'state', CREATION_INTENT_STATES);
  timestamp(intent.createdAt, 'createdAt');
  timestamp(intent.updatedAt, 'updatedAt');
  if (intent.publishedAt !== undefined) timestamp(intent.publishedAt, 'publishedAt');
  if (state === 'published' && intent.publishedAt === undefined) fail('published intents require publishedAt');
  return value as CreationIntent;
}

export function assertSessionDispositionRecord(value: unknown): SessionDispositionRecord {
  const record = object(value, 'disposition');
  exactKeys(record, 'disposition', [
    'schemaVersion',
    'sessionId',
    'workspaceId',
    'disposition',
    'botId',
    'chatId',
    'convertedAt',
    'cutoverMarkerEntryId',
  ]);
  assertSchemaVersion(record.schemaVersion);
  assertBotId(record.sessionId, 'sessionId');
  assertBotId(record.workspaceId, 'workspaceId');
  const disposition = member(record.disposition, 'disposition', LEGACY_SESSION_DISPOSITIONS);
  if (record.botId !== undefined) assertBotId(record.botId, 'botId');
  if (record.chatId !== undefined) assertBotId(record.chatId, 'chatId');
  if (record.convertedAt !== undefined) timestamp(record.convertedAt, 'convertedAt');
  if (record.cutoverMarkerEntryId !== undefined) assertBotId(record.cutoverMarkerEntryId, 'cutoverMarkerEntryId');
  if (disposition === 'converted' && (record.botId === undefined || record.chatId === undefined)) {
    fail('converted dispositions require botId and chatId');
  }
  return value as SessionDispositionRecord;
}
