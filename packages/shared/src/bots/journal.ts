import {
  BOT_SCHEMA_VERSION,
  type DirectChatRecord,
  type JournalCursor,
  type JournalEntry,
  type JournalEntryKind,
} from '@kata-sh/core';
import { ensureDurableDirectory } from '../spawn-tasks/durable-fs.ts';
import { deriveJournalEntryId } from './ids.ts';
import {
  botsRootPath,
  chatRecordPath,
  journalCursorPath,
  journalEntriesPath,
  journalEntryPath,
  journalIndexPath,
  readJsonFile,
  writeJsonIfAbsent,
  writeJsonRecord,
} from './layout.ts';
import {
  assertBotId,
  assertDirectChatRecord,
  assertIdempotencyKey,
  assertJournalEntry,
} from './validation.ts';

export interface ConversationJournalOptions {
  readonly workspaceRoot: string;
  readonly workspaceId: string;
  readonly clock?: () => string;
  readonly randomId?: () => string;
}

export interface AppendJournalEntryInput {
  readonly chatId: string;
  readonly botId: string;
  readonly kind: JournalEntryKind;
  readonly body: string;
  readonly idempotencyKey: string;
  readonly entryId?: string;
  readonly createdAt?: string;
}

interface JournalIndex {
  readonly schemaVersion: typeof BOT_SCHEMA_VERSION;
  readonly chatId: string;
  readonly nextSeq: number;
  readonly byIdempotencyKey: Record<string, string>;
  readonly entries: { readonly entryId: string; readonly seq: number }[];
}

export class ConversationJournal {
  readonly rootPath: string;
  readonly workspaceId: string;

  private readonly clock: () => string;

  constructor(options: ConversationJournalOptions) {
    assertBotId(options.workspaceId, 'workspaceId');
    this.rootPath = botsRootPath(options.workspaceRoot);
    this.workspaceId = options.workspaceId;
    this.clock = options.clock ?? (() => new Date().toISOString());
    ensureDurableDirectory(this.rootPath);
  }

  append(input: AppendJournalEntryInput): JournalEntry {
    const chat = this.requireChat(input.chatId);
    assertBotId(input.botId, 'botId');
    if (chat.botId !== input.botId) throw new Error(`Direct chat ${chat.chatId} is not owned by bot ${input.botId}`);
    const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);

    const index = this.readIndex(chat.chatId);
    const existingId = Object.hasOwn(index.byIdempotencyKey, idempotencyKey)
      ? index.byIdempotencyKey[idempotencyKey]
      : undefined;
    if (existingId) {
      const existingSeq = index.entries.find((item) => item.entryId === existingId)?.seq;
      if (existingSeq === undefined) throw new Error(`Journal index is missing entry ${existingId}`);
      return this.requireEntry(chat.chatId, existingSeq, existingId);
    }

    const seq = index.nextSeq;
    const entryId = assertBotId(input.entryId ?? deriveJournalEntryId(chat.chatId, idempotencyKey), 'entryId');
    const entry: JournalEntry = assertJournalEntry({
      schemaVersion: BOT_SCHEMA_VERSION,
      entryId,
      chatId: chat.chatId,
      botId: chat.botId,
      seq,
      kind: input.kind,
      idempotencyKey,
      body: input.body,
      createdAt: input.createdAt ?? this.clock(),
    });

    const entryPath = journalEntryPath(this.rootPath, chat.chatId, seq, entryId);
    const committed = writeJsonIfAbsent(entryPath, entry)
      ? entry
      : this.requireEntry(chat.chatId, seq, entryId);
    return this.commitIndex(index, committed);
  }

  list(chatId: string, options?: { afterSeq?: number; limit?: number }): JournalEntry[] {
    const chat = this.requireChat(chatId);
    const afterSeq = options?.afterSeq ?? 0;
    const limit = options?.limit;
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
      throw new Error('limit must be a non-negative safe integer');
    }
    return this.readIndex(chat.chatId).entries
      .filter((item) => item.seq > afterSeq)
      .sort((left, right) => left.seq - right.seq)
      .slice(0, limit)
      .map((item) => this.requireEntry(chat.chatId, item.seq, item.entryId));
  }

  getCursor(chatId: string): JournalCursor {
    const chat = this.requireChat(chatId);
    return this.buildCursor(chat.chatId, this.readLastReadSeq(chat.chatId));
  }

  markRead(chatId: string, seq: number): JournalCursor {
    const chat = this.requireChat(chatId);
    if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('seq must be a non-negative safe integer');
    const lastSeq = this.readIndex(chat.chatId).nextSeq - 1;
    const lastReadSeq = Math.max(this.readLastReadSeq(chat.chatId), Math.min(seq, lastSeq));
    writeJsonRecord(journalCursorPath(this.rootPath, chat.chatId), { chatId: chat.chatId, lastReadSeq });
    return this.buildCursor(chat.chatId, lastReadSeq);
  }

  private commitIndex(index: JournalIndex, entry: JournalEntry): JournalEntry {
    // ponytail: full index rewrite per append is O(n) in entries. Fine at chat
    // volumes; upgrade path is an append-only index log plus periodic snapshot.
    const next: JournalIndex = {
      schemaVersion: BOT_SCHEMA_VERSION,
      chatId: index.chatId,
      nextSeq: entry.seq + 1,
      byIdempotencyKey: { ...index.byIdempotencyKey, [entry.idempotencyKey]: entry.entryId },
      entries: [...index.entries, { entryId: entry.entryId, seq: entry.seq }],
    };
    writeJsonRecord(journalIndexPath(this.rootPath, index.chatId), next);
    return entry;
  }

  private buildCursor(chatId: string, lastReadSeq: number): JournalCursor {
    const lastSeq = this.readIndex(chatId).nextSeq - 1;
    return { chatId, lastReadSeq, unreadCount: Math.max(0, lastSeq - lastReadSeq) };
  }

  private readLastReadSeq(chatId: string): number {
    const record = readJsonFile(journalCursorPath(this.rootPath, chatId), 'journal cursor') as
      | { lastReadSeq?: unknown }
      | null;
    if (!record) return 0;
    if (!Number.isSafeInteger(record.lastReadSeq) || (record.lastReadSeq as number) < 0) {
      throw new Error(`Journal cursor for ${chatId} is corrupt`);
    }
    return record.lastReadSeq as number;
  }

  private readIndex(chatId: string): JournalIndex {
    const record = readJsonFile(journalIndexPath(this.rootPath, chatId), 'journal index') as JournalIndex | null;
    if (!record) {
      return { schemaVersion: BOT_SCHEMA_VERSION, chatId, nextSeq: 1, byIdempotencyKey: {}, entries: [] };
    }
    if (record.schemaVersion !== BOT_SCHEMA_VERSION) throw new Error(`Unsupported journal index for ${chatId}`);
    if (record.chatId !== chatId) throw new Error(`Journal index identity mismatch for ${chatId}`);
    if (!Number.isSafeInteger(record.nextSeq) || record.nextSeq < 1) {
      throw new Error(`Journal index for ${chatId} is corrupt`);
    }
    return record;
  }

  private requireEntry(chatId: string, seq: number, entryId: string): JournalEntry {
    const record = readJsonFile(journalEntryPath(this.rootPath, chatId, seq, entryId), 'journal entry');
    if (!record) throw new Error(`Journal entry not found: ${entryId}`);
    const entry = assertJournalEntry(record);
    if (entry.chatId !== chatId || entry.seq !== seq || entry.entryId !== entryId) {
      throw new Error(`Journal entry identity mismatch for ${entryId}`);
    }
    return entry;
  }

  private requireChat(chatId: string): DirectChatRecord {
    assertBotId(chatId, 'chatId');
    const record = readJsonFile(chatRecordPath(this.rootPath, chatId), 'direct chat record');
    if (!record) throw new Error(`Direct chat not found: ${chatId}`);
    const chat = assertDirectChatRecord(record);
    if (chat.chatId !== chatId) throw new Error(`Direct chat identity mismatch for ${chatId}`);
    if (chat.workspaceId !== this.workspaceId) throw new Error(`Direct chat ${chatId} belongs to another workspace`);
    ensureDurableDirectory(journalEntriesPath(this.rootPath, chatId));
    return chat;
  }
}
