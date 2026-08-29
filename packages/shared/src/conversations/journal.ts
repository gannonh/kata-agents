/**
 * ConversationJournal — the single authority for ordered public history.
 *
 * A conversation is a Bot DirectChat or a Channel. The journal knows neither;
 * it takes a resolver that answers "does this conversation exist, in which
 * workspace, and may this Bot author here". Sequence numbers are monotonic per
 * conversation and authoritative; timestamps are informational.
 *
 * Every append is synchronous, so appends inside one process are serialized
 * against each other and the entry write is a compare-and-set.
 */

import { createHash, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONVERSATION_LIMITS,
  CONVERSATION_SCHEMA_VERSION,
  JOURNAL_ENTRY_KINDS,
  type JournalCursor,
  type JournalEntry,
  type JournalEntryKind,
} from '@kata-sh/core';
import { ensureDurableDirectory } from '../spawn-tasks/durable-fs.ts';
import { readJsonFile, writeJsonIfAbsent, writeJsonRecord } from './durable-json.ts';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/;
const ENTRY_FILENAME = /^(\d+)-(.+)\.json$/;

/** Resolved identity of one conversation, as its owning store sees it. */
export interface ConversationRef {
  readonly conversationId: string;
  readonly workspaceId: string;
  /**
   * The one Bot allowed to author non-user entries. Set for a DirectChat;
   * absent for a Channel, where any committed member may author.
   */
  readonly soleAuthorBotId?: string;
  /** Guard for multi-author conversations. Return false to reject the author. */
  readonly mayAuthor?: (botId: string) => boolean;
}

export interface ConversationJournalOptions {
  /** Directory that holds this family's `journals/<conversationId>/` trees. */
  readonly journalRoot: string;
  readonly workspaceId: string;
  readonly resolveConversation: (conversationId: string) => ConversationRef | null;
  readonly clock?: () => string;
}

export interface AppendJournalEntryInput {
  readonly conversationId: string;
  readonly authorBotId?: string;
  /** Required for handoff entries; rejected on every other kind. */
  readonly handoffId?: string;
  /** Required for approval entries; rejected on every other kind. */
  readonly approvalId?: string;
  readonly kind: JournalEntryKind;
  readonly body: string;
  readonly idempotencyKey: string;
  readonly entryId?: string;
  readonly createdAt?: string;
}

interface JournalIndex {
  readonly schemaVersion: typeof CONVERSATION_SCHEMA_VERSION;
  readonly conversationId: string;
  readonly nextSeq: number;
  readonly byIdempotencyKey: Record<string, string>;
  readonly entries: { readonly entryId: string; readonly seq: number }[];
}

export function journalEntriesPath(root: string, conversationId: string): string {
  return join(root, 'journals', conversationId, 'entries');
}

export function journalIndexPath(root: string, conversationId: string): string {
  return join(root, 'journals', conversationId, 'index.json');
}

export function journalCursorPath(root: string, conversationId: string): string {
  return join(root, 'journals', conversationId, 'cursor.json');
}

export function journalEntryPath(root: string, conversationId: string, seq: number, entryId: string): string {
  return join(journalEntriesPath(root, conversationId), `${String(seq).padStart(12, '0')}-${entryId}.json`);
}

export function mintJournalEntryId(randomId: () => string = randomUUID): string {
  return `entry_${randomId()}`;
}

export function deriveJournalEntryId(conversationId: string, idempotencyKey: string): string {
  const digest = createHash('sha256')
    .update(`${conversationId}\0${idempotencyKey}`, 'utf8')
    .digest('hex');
  return `entry_${digest.slice(0, 32)}`;
}

function fail(message: string): never {
  throw new TypeError(`Invalid journal entry: ${message}`);
}

export function assertConversationId(value: unknown, field = 'conversationId'): string {
  if (typeof value !== 'string') fail(`${field} must be a string`);
  if (!SAFE_ID.test(value) || value === '.' || value === '..') fail(`${field} is not an opaque path-safe ID`);
  return value;
}

export function assertJournalIdempotencyKey(value: unknown, field = 'idempotencyKey'): string {
  if (typeof value !== 'string') fail(`${field} must be a string`);
  if (Buffer.byteLength(value, 'utf8') > CONVERSATION_LIMITS.idempotencyKeyBytes) {
    fail(`${field} exceeds ${CONVERSATION_LIMITS.idempotencyKeyBytes} byte limit`);
  }
  if (!value.trim()) fail(`${field} must be non-empty`);
  return value;
}

/**
 * Legacy Bot DirectChat journals used `chatId` / `botId`. Rewrite those fields
 * into the conversation-generic shape before schema validation.
 */
export function migrateLegacyJournalEntry(value: unknown): { record: Record<string, unknown>; migrated: boolean } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('entry must be an object');
  const entry = value as Record<string, unknown>;
  const hasLegacyChatId = Object.hasOwn(entry, 'chatId');
  const hasLegacyBotId = Object.hasOwn(entry, 'botId');
  if (!hasLegacyChatId && !hasLegacyBotId) return { record: entry, migrated: false };

  const next: Record<string, unknown> = { ...entry };
  if (hasLegacyChatId) {
    if (typeof next.chatId !== 'string') fail('chatId must be a string');
    if (next.conversationId === undefined) next.conversationId = next.chatId;
    else if (next.conversationId !== next.chatId) fail('chatId does not match conversationId');
    delete next.chatId;
  }
  if (hasLegacyBotId) {
    const legacyBotId = next.botId;
    delete next.botId;
    if (next.kind !== 'user' && next.authorBotId === undefined) {
      if (typeof legacyBotId !== 'string') fail('botId must be a string');
      next.authorBotId = legacyBotId;
    }
  }
  return { record: next, migrated: true };
}

export function assertJournalEntry(value: unknown): JournalEntry {
  const { record: entry } = migrateLegacyJournalEntry(value);
  const allowed = [
    'schemaVersion',
    'entryId',
    'conversationId',
    'authorBotId',
    'handoffId',
    'approvalId',
    'seq',
    'kind',
    'idempotencyKey',
    'body',
    'createdAt',
  ];
  for (const key of Object.keys(entry)) {
    if (!allowed.includes(key)) fail(`entry.${key} is unknown`);
  }
  if (entry.schemaVersion !== CONVERSATION_SCHEMA_VERSION) fail('unsupported schemaVersion');
  assertConversationId(entry.entryId, 'entryId');
  assertConversationId(entry.conversationId, 'conversationId');
  if (entry.authorBotId !== undefined) assertConversationId(entry.authorBotId, 'authorBotId');
  if (!Number.isSafeInteger(entry.seq) || (entry.seq as number) < 1) fail('seq must be a positive safe integer');
  if (typeof entry.kind !== 'string' || !JOURNAL_ENTRY_KINDS.includes(entry.kind as JournalEntryKind)) {
    fail(`kind must be one of ${JOURNAL_ENTRY_KINDS.join(', ')}`);
  }
  assertJournalIdempotencyKey(entry.idempotencyKey);
  if (typeof entry.body !== 'string') fail('body must be a string');
  if (Buffer.byteLength(entry.body, 'utf8') > CONVERSATION_LIMITS.entryBytes) {
    fail(`body exceeds ${CONVERSATION_LIMITS.entryBytes} byte limit`);
  }
  if (typeof entry.createdAt !== 'string' || !Number.isFinite(Date.parse(entry.createdAt))) {
    fail('createdAt must be an ISO timestamp');
  }
  if (entry.kind === 'handoff') {
    if (entry.handoffId === undefined) fail('handoff entries require handoffId');
    assertConversationId(entry.handoffId, 'handoffId');
    if (entry.authorBotId === undefined) fail('handoff entries require an author Bot');
    if (entry.approvalId !== undefined) fail('only approval entries may carry approvalId');
  } else if (entry.kind === 'approval') {
    if (entry.approvalId === undefined) fail('approval entries require approvalId');
    assertConversationId(entry.approvalId, 'approvalId');
    if (entry.authorBotId === undefined) fail('approval entries require an author Bot');
    if (entry.handoffId !== undefined) fail('only handoff entries may carry handoffId');
  } else if (entry.handoffId !== undefined) {
    fail('only handoff entries may carry handoffId');
  } else if (entry.approvalId !== undefined) {
    fail('only approval entries may carry approvalId');
  }
  return entry as unknown as JournalEntry;
}

export class ConversationJournal {
  readonly journalRoot: string;
  readonly workspaceId: string;

  private readonly clock: () => string;
  private readonly resolveConversation: (conversationId: string) => ConversationRef | null;

  constructor(options: ConversationJournalOptions) {
    assertConversationId(options.workspaceId, 'workspaceId');
    this.journalRoot = options.journalRoot;
    this.workspaceId = options.workspaceId;
    this.resolveConversation = options.resolveConversation;
    this.clock = options.clock ?? (() => new Date().toISOString());
    ensureDurableDirectory(this.journalRoot);
  }

  append(input: AppendJournalEntryInput): JournalEntry {
    const conversation = this.require(input.conversationId);
    const idempotencyKey = assertJournalIdempotencyKey(input.idempotencyKey);
    const authorBotId = this.resolveAuthor(conversation, input);

    const index = this.reconcileOrphanedEntries(this.readIndex(conversation.conversationId));
    const existingId = Object.hasOwn(index.byIdempotencyKey, idempotencyKey)
      ? index.byIdempotencyKey[idempotencyKey]
      : undefined;
    if (existingId) {
      const existingSeq = index.entries.find((item) => item.entryId === existingId)?.seq;
      if (existingSeq === undefined) throw new Error(`Journal index is missing entry ${existingId}`);
      return this.requireEntry(conversation.conversationId, existingSeq, existingId);
    }

    const seq = index.nextSeq;
    const entryId = assertConversationId(
      input.entryId ?? deriveJournalEntryId(conversation.conversationId, idempotencyKey),
      'entryId',
    );
    const entry: JournalEntry = assertJournalEntry({
      schemaVersion: CONVERSATION_SCHEMA_VERSION,
      entryId,
      conversationId: conversation.conversationId,
      ...(authorBotId !== undefined ? { authorBotId } : {}),
      ...(input.handoffId !== undefined ? { handoffId: input.handoffId } : {}),
      ...(input.approvalId !== undefined ? { approvalId: input.approvalId } : {}),
      seq,
      kind: input.kind,
      idempotencyKey,
      body: input.body,
      createdAt: input.createdAt ?? this.clock(),
    });

    const entryPath = journalEntryPath(this.journalRoot, conversation.conversationId, seq, entryId);
    const committed = writeJsonIfAbsent(entryPath, entry)
      ? entry
      : this.requireEntry(conversation.conversationId, seq, entryId);
    return this.commitIndex(index, committed);
  }

  list(conversationId: string, options?: { afterSeq?: number; limit?: number }): JournalEntry[] {
    const conversation = this.require(conversationId);
    const afterSeq = options?.afterSeq ?? 0;
    const limit = options?.limit;
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
      throw new Error('limit must be a non-negative safe integer');
    }
    return this.readIndex(conversation.conversationId).entries
      .filter((item) => item.seq > afterSeq)
      .sort((left, right) => left.seq - right.seq)
      .slice(0, limit)
      .map((item) => this.requireEntry(conversation.conversationId, item.seq, item.entryId));
  }

  getEntry(conversationId: string, entryId: string): JournalEntry | null {
    const conversation = this.require(conversationId);
    const found = this.readIndex(conversation.conversationId).entries.find((item) => item.entryId === entryId);
    return found ? this.requireEntry(conversation.conversationId, found.seq, found.entryId) : null;
  }

  getCursor(conversationId: string): JournalCursor {
    const conversation = this.require(conversationId);
    return this.buildCursor(conversation.conversationId, this.readLastReadSeq(conversation.conversationId));
  }

  /** The authoritative highest sequence, independent of the UI read cursor. */
  getHeadSequence(conversationId: string): number {
    const conversation = this.require(conversationId);
    // Reconcile orphans before reporting the head so a crash between entry write
    // and index commit cannot leave recovered entries invisible to assemblers.
    return this.reconcileOrphanedEntries(this.readIndex(conversation.conversationId)).nextSeq - 1;
  }

  markRead(conversationId: string, seq: number): JournalCursor {
    const conversation = this.require(conversationId);
    if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('seq must be a non-negative safe integer');
    const lastSeq = this.readIndex(conversation.conversationId).nextSeq - 1;
    const lastReadSeq = Math.max(this.readLastReadSeq(conversation.conversationId), Math.min(seq, lastSeq));
    writeJsonRecord(journalCursorPath(this.journalRoot, conversation.conversationId), {
      conversationId: conversation.conversationId,
      lastReadSeq,
    });
    return this.buildCursor(conversation.conversationId, lastReadSeq);
  }

  private resolveAuthor(conversation: ConversationRef, input: AppendJournalEntryInput): string | undefined {
    if (input.kind === 'user') {
      if (input.authorBotId !== undefined) throw new Error('User entries have no Bot author');
      return undefined;
    }
    const authorBotId = input.authorBotId ?? conversation.soleAuthorBotId;
    if (authorBotId === undefined) {
      if (input.kind === 'bot' || input.kind === 'tool' || input.kind === 'handoff' || input.kind === 'approval') {
        throw new Error(`A ${input.kind} entry requires an author Bot`);
      }
      return undefined;
    }
    assertConversationId(authorBotId, 'authorBotId');
    if (conversation.soleAuthorBotId !== undefined && conversation.soleAuthorBotId !== authorBotId) {
      throw new Error(`Conversation ${conversation.conversationId} is not owned by bot ${authorBotId}`);
    }
    if (conversation.mayAuthor && !conversation.mayAuthor(authorBotId)) {
      throw new Error(`Bot ${authorBotId} may not author in conversation ${conversation.conversationId}`);
    }
    return authorBotId;
  }

  private commitIndex(index: JournalIndex, entry: JournalEntry): JournalEntry {
    // ponytail: full index rewrite per append is O(n) in entries. Fine at chat
    // volumes; upgrade path is an append-only index log plus periodic snapshot.
    const next: JournalIndex = {
      schemaVersion: CONVERSATION_SCHEMA_VERSION,
      conversationId: index.conversationId,
      nextSeq: entry.seq + 1,
      byIdempotencyKey: { ...index.byIdempotencyKey, [entry.idempotencyKey]: entry.entryId },
      entries: [...index.entries, { entryId: entry.entryId, seq: entry.seq }],
    };
    writeJsonRecord(journalIndexPath(this.journalRoot, index.conversationId), next);
    return entry;
  }

  /**
   * After a crash between entry write and index commit, entry files can exist
   * on disk while missing from the index. Fold those orphans into the index and
   * advance nextSeq past the highest on-disk seq before allocating a new one.
   */
  private reconcileOrphanedEntries(index: JournalIndex): JournalIndex {
    let files: string[];
    try {
      files = readdirSync(journalEntriesPath(this.journalRoot, index.conversationId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return index;
      throw error;
    }

    const indexedIds = new Set(index.entries.map((item) => item.entryId));
    let nextSeq = index.nextSeq;
    let byIdempotencyKey = index.byIdempotencyKey;
    let entries = index.entries;
    let changed = false;

    for (const file of files) {
      const match = ENTRY_FILENAME.exec(file);
      if (!match) continue;
      const seq = Number(match[1]);
      const entryId = match[2]!;
      if (!Number.isSafeInteger(seq) || seq < 1) continue;

      if (seq >= nextSeq) {
        nextSeq = seq + 1;
        changed = true;
      }
      if (indexedIds.has(entryId)) continue;

      const entry = this.requireEntry(index.conversationId, seq, entryId);
      if (!changed) {
        byIdempotencyKey = { ...index.byIdempotencyKey };
        entries = [...index.entries];
      }
      byIdempotencyKey = { ...byIdempotencyKey, [entry.idempotencyKey]: entry.entryId };
      entries = [...entries, { entryId: entry.entryId, seq: entry.seq }];
      indexedIds.add(entryId);
      changed = true;
    }

    if (!changed) return index;

    const reconciled: JournalIndex = {
      schemaVersion: CONVERSATION_SCHEMA_VERSION,
      conversationId: index.conversationId,
      nextSeq,
      byIdempotencyKey,
      entries: [...entries].sort((left, right) => left.seq - right.seq),
    };
    writeJsonRecord(journalIndexPath(this.journalRoot, index.conversationId), reconciled);
    return reconciled;
  }

  private buildCursor(conversationId: string, lastReadSeq: number): JournalCursor {
    const lastSeq = this.readIndex(conversationId).nextSeq - 1;
    return { conversationId, lastReadSeq, unreadCount: Math.max(0, lastSeq - lastReadSeq) };
  }

  private readLastReadSeq(conversationId: string): number {
    const raw = readJsonFile(journalCursorPath(this.journalRoot, conversationId)) as
      | Record<string, unknown>
      | null;
    if (!raw) return 0;
    const migrated = this.migrateLegacyCursor(raw, conversationId);
    if (!Number.isSafeInteger(migrated.lastReadSeq) || (migrated.lastReadSeq as number) < 0) {
      throw new Error(`Journal cursor for ${conversationId} is corrupt`);
    }
    if (migrated.rewritten) {
      writeJsonRecord(journalCursorPath(this.journalRoot, conversationId), {
        conversationId,
        lastReadSeq: migrated.lastReadSeq,
      });
    }
    return migrated.lastReadSeq as number;
  }

  private readIndex(conversationId: string): JournalIndex {
    const raw = readJsonFile(journalIndexPath(this.journalRoot, conversationId)) as
      | Record<string, unknown>
      | null;
    if (!raw) {
      return {
        schemaVersion: CONVERSATION_SCHEMA_VERSION,
        conversationId,
        nextSeq: 1,
        byIdempotencyKey: {},
        entries: [],
      };
    }
    const { index, migrated } = this.migrateLegacyIndex(raw, conversationId);
    if (index.schemaVersion !== CONVERSATION_SCHEMA_VERSION) {
      throw new Error(`Unsupported journal index for ${conversationId}`);
    }
    if (index.conversationId !== conversationId) {
      throw new Error(`Journal index identity mismatch for ${conversationId}`);
    }
    if (!Number.isSafeInteger(index.nextSeq) || index.nextSeq < 1) {
      throw new Error(`Journal index for ${conversationId} is corrupt`);
    }
    if (migrated) {
      writeJsonRecord(journalIndexPath(this.journalRoot, conversationId), index);
    }
    return index;
  }

  private requireEntry(conversationId: string, seq: number, entryId: string): JournalEntry {
    const path = journalEntryPath(this.journalRoot, conversationId, seq, entryId);
    const record = readJsonFile(path);
    if (!record) throw new Error(`Journal entry not found: ${entryId}`);
    const { record: normalized, migrated } = migrateLegacyJournalEntry(record);
    const entry = assertJournalEntry(normalized);
    if (migrated) writeJsonRecord(path, entry);
    if (entry.conversationId !== conversationId || entry.seq !== seq || entry.entryId !== entryId) {
      throw new Error(`Journal entry identity mismatch for ${entryId}`);
    }
    const conversation = this.require(conversationId);
    this.assertPersistedAuthor(conversation, entry);
    return entry;
  }

  private assertPersistedAuthor(conversation: ConversationRef, entry: JournalEntry): void {
    if (entry.kind === 'user') {
      if (entry.authorBotId !== undefined) throw new Error(`Persisted user entry ${entry.entryId} has a Bot author`);
      return;
    }
    const authorBotId = entry.authorBotId;
    if ((entry.kind === 'bot' || entry.kind === 'tool' || entry.kind === 'handoff') && authorBotId === undefined) {
      throw new Error(`Persisted ${entry.kind} entry ${entry.entryId} has no Bot author`);
    }
    if (authorBotId === undefined) return;
    if (conversation.soleAuthorBotId !== undefined && conversation.soleAuthorBotId !== authorBotId) {
      throw new Error(`Persisted entry ${entry.entryId} is authored by the wrong Bot`);
    }
  }

  private migrateLegacyIndex(
    raw: Record<string, unknown>,
    conversationId: string,
  ): { index: JournalIndex; migrated: boolean } {
    let migrated = false;
    const next: Record<string, unknown> = { ...raw };
    if (Object.hasOwn(next, 'chatId')) {
      if (typeof next.chatId !== 'string') {
        throw new Error(`Journal index for ${conversationId} is corrupt`);
      }
      if (next.conversationId === undefined) next.conversationId = next.chatId;
      else if (next.conversationId !== next.chatId) {
        throw new Error(`Journal index identity mismatch for ${conversationId}`);
      }
      delete next.chatId;
      migrated = true;
    }
    return {
      index: next as unknown as JournalIndex,
      migrated,
    };
  }

  private migrateLegacyCursor(
    raw: Record<string, unknown>,
    conversationId: string,
  ): { lastReadSeq: unknown; rewritten: boolean } {
    if (Object.hasOwn(raw, 'chatId')) {
      if (typeof raw.chatId !== 'string') {
        throw new Error(`Journal cursor for ${conversationId} is corrupt`);
      }
      if (raw.conversationId !== undefined && raw.conversationId !== raw.chatId) {
        throw new Error(`Journal cursor identity mismatch for ${conversationId}`);
      }
      if (raw.chatId !== conversationId) {
        throw new Error(`Journal cursor identity mismatch for ${conversationId}`);
      }
      return { lastReadSeq: raw.lastReadSeq, rewritten: true };
    }
    if (raw.conversationId !== undefined && raw.conversationId !== conversationId) {
      throw new Error(`Journal cursor identity mismatch for ${conversationId}`);
    }
    return { lastReadSeq: raw.lastReadSeq, rewritten: false };
  }

  private require(conversationId: string): ConversationRef {
    assertConversationId(conversationId, 'conversationId');
    const conversation = this.resolveConversation(conversationId);
    if (!conversation) throw new Error(`Conversation not found: ${conversationId}`);
    if (conversation.conversationId !== conversationId) {
      throw new Error(`Conversation identity mismatch for ${conversationId}`);
    }
    if (conversation.workspaceId !== this.workspaceId) {
      throw new Error(`Conversation ${conversationId} belongs to another workspace`);
    }
    ensureDurableDirectory(journalEntriesPath(this.journalRoot, conversationId));
    return conversation;
  }
}
