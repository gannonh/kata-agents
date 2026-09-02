/**
 * Ordered public conversation history.
 *
 * `ConversationJournal` is the single authority for public entries. A
 * conversation is either a Bot DirectChat or a Channel; both append here and
 * neither keeps a second ordered history. Provider Session transcripts stay
 * hidden execution records.
 */

import type { ApprovalId } from './tool-approval.ts';
import type { HandoffId } from './handoff.ts';

/** Opaque SpawnTask identity used on public task journal entries. */
export type TaskId = string;

export const CONVERSATION_SCHEMA_VERSION = 1 as const;

/** Bounds are UTF-8 byte counts, not JavaScript string lengths. */
export const CONVERSATION_LIMITS = Object.freeze({
  entryBytes: 256 * 1024,
  idempotencyKeyBytes: 512,
});

export const JOURNAL_ENTRY_KINDS = ['user', 'bot', 'tool', 'error', 'lifecycle', 'handoff', 'approval', 'task'] as const;
export type JournalEntryKind = (typeof JOURNAL_ENTRY_KINDS)[number];

/** `chat_<uuid>` or `channel_<uuid>` */
export type ConversationId = string;
/** `entry_<hash>` */
export type JournalEntryId = string;

export interface JournalEntry {
  readonly schemaVersion: typeof CONVERSATION_SCHEMA_VERSION;
  readonly entryId: JournalEntryId;
  readonly conversationId: ConversationId;
  /** Author of a Bot-produced entry. Absent on user entries. */
  readonly authorBotId?: string;
  /** Handoff this entry announces. Required on handoff entries; absent otherwise. */
  readonly handoffId?: HandoffId;
  /** Approval this entry announces. Required on approval entries; absent otherwise. */
  readonly approvalId?: ApprovalId;
  /** Spawned task this entry announces. Required on task entries; absent otherwise. */
  readonly taskId?: TaskId;
  readonly seq: number;
  readonly kind: JournalEntryKind;
  readonly idempotencyKey: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface JournalCursor {
  readonly conversationId: ConversationId;
  readonly lastReadSeq: number;
  readonly unreadCount: number;
}
