import {
  BOT_SCHEMA_VERSION,
  type BotPermissionMode,
  type BotProviderConfig,
  type BotRecord,
  type JournalEntry,
  type SessionDispositionRecord,
} from '@kata-sh/core';
import type { BotDirectory } from './directory.ts';
import type { ConversationJournal } from '../conversations/index.ts';
import { dispositionPath } from './layout.ts';
import { readJsonFile, writeJsonRecord } from '../conversations/index.ts';
import { assertBotId, assertSessionDispositionRecord } from './validation.ts';

export interface ConvertSessionMessage {
  readonly role: string;
  readonly text: string;
  readonly createdAt?: string;
}

export interface ConvertSessionToBotInput {
  readonly sessionId: string;
  readonly workspaceId?: string;
  readonly idempotencyKey: string;
  readonly name: string;
  readonly permissionMode: BotPermissionMode;
  readonly providerConfig: BotProviderConfig;
  readonly profile?: string;
  readonly messages: readonly ConvertSessionMessage[];
}

export interface ConvertSessionToBotResult {
  readonly bot: BotRecord;
  readonly chatId: string;
  readonly entries: JournalEntry[];
  readonly disposition: SessionDispositionRecord;
}

export function convertSessionToBot(
  directory: BotDirectory,
  journal: ConversationJournal,
  input: ConvertSessionToBotInput,
): ConvertSessionToBotResult {
  const sessionId = assertBotId(input.sessionId, 'sessionId');
  if (input.workspaceId !== undefined && input.workspaceId !== directory.workspaceId) {
    throw new Error(`Session ${sessionId} belongs to another workspace`);
  }
  if (journal.workspaceId !== directory.workspaceId) {
    throw new Error('Bot directory and conversation journal must share a workspace');
  }

  const existing = directory.getBotByLegacySession(sessionId);
  if (existing) {
    const disposition = readDisposition(directory.rootPath, sessionId);
    if (disposition) {
      return {
        bot: existing,
        chatId: existing.directChatId,
        entries: journal.list(existing.directChatId),
        disposition,
      };
    }
  }

  const bot = existing ?? directory.createBot({
    name: input.name,
    permissionMode: input.permissionMode,
    providerConfig: input.providerConfig,
    ...(input.profile !== undefined ? { profile: input.profile } : {}),
    idempotencyKey: input.idempotencyKey,
    legacySessionId: sessionId,
  });

  const entries = input.messages.map((message, index) => journal.append({
    conversationId: bot.directChatId,
    kind: message.role === 'user' ? 'user' : 'bot',
    body: message.text,
    idempotencyKey: `convert.${sessionId}.${index}`,
    entryId: `entry_convert_${sessionId}_${index}`,
    ...(message.createdAt !== undefined ? { createdAt: message.createdAt } : {}),
  }));

  const cutover = journal.append({
    conversationId: bot.directChatId,
    kind: 'lifecycle',
    body: `Converted from session ${sessionId}. Earlier history is imported above.`,
    idempotencyKey: `convert.${sessionId}.cutover`,
    entryId: `entry_convert_${sessionId}_cutover`,
  });

  const disposition = assertSessionDispositionRecord({
    schemaVersion: BOT_SCHEMA_VERSION,
    sessionId,
    workspaceId: directory.workspaceId,
    disposition: 'converted',
    botId: bot.botId,
    chatId: bot.directChatId,
    convertedAt: cutover.createdAt,
    cutoverMarkerEntryId: cutover.entryId,
  });
  writeJsonRecord(dispositionPath(directory.rootPath, sessionId), disposition);

  return { bot, chatId: bot.directChatId, entries: [...entries, cutover], disposition };
}

function readDisposition(rootPath: string, sessionId: string): SessionDispositionRecord | null {
  const record = readJsonFile(dispositionPath(rootPath, sessionId));
  return record ? assertSessionDispositionRecord(record) : null;
}
