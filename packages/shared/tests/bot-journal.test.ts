import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { BotDirectory, createDirectChatJournal } from '../src/bots/index.ts';
import {
  ConversationJournal,
  journalCursorPath,
  journalEntriesPath,
  journalEntryPath,
  journalIndexPath,
  readJsonFile,
  writeJsonRecord,
} from '../src/conversations/index.ts';

const at = '2026-08-26T00:00:00.000Z';
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'bot-journal-'));
  tempRoots.push(root);
  return root;
}

function provider() {
  return { providerId: 'openai-codex', modelId: 'gpt-5' };
}

function setup(workspaceId = 'ws_1') {
  const root = tempWorkspace();
  const directory = new BotDirectory({ workspaceRoot: root, workspaceId, clock: () => at });
  const journal = createDirectChatJournal({ workspaceRoot: root, workspaceId, clock: () => at });
  const bot = directory.createBot({
    name: 'Journal Bot',
    permissionMode: 'ask',
    providerConfig: provider(),
    idempotencyKey: 'journal-setup',
  });
  return { root, directory, journal, bot };
}

describe('ConversationJournal ordering', () => {
  it('assigns monotonic sequence numbers and lists in order', () => {
    const { journal, bot } = setup();

    for (const index of [0, 1, 2, 3]) {
      journal.append({
        conversationId: bot.directChatId,
        kind: index % 2 === 0 ? 'user' : 'bot',
        body: `entry-${index}`,
        idempotencyKey: `key-${index}`,
      });
    }

    const entries = journal.list(bot.directChatId);
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
    expect(entries.map((entry) => entry.body)).toEqual(['entry-0', 'entry-1', 'entry-2', 'entry-3']);
    expect(journal.list(bot.directChatId, { afterSeq: 2 }).map((entry) => entry.seq)).toEqual([3, 4]);
    expect(journal.list(bot.directChatId, { limit: 2 }).map((entry) => entry.seq)).toEqual([1, 2]);
    expect(journal.list(bot.directChatId, { afterSeq: 1, limit: 1 }).map((entry) => entry.seq)).toEqual([2]);
  });

  it('commits the entry to disk before returning', () => {
    const { journal, bot } = setup();

    const entry = journal.append({
      conversationId: bot.directChatId,
      kind: 'user',
      body: 'durable',
      idempotencyKey: 'durable-1',
    });

    const botsRoot = journal.journalRoot;
    const files = readdirSync(journalEntriesPath(botsRoot, bot.directChatId));
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(basename(journalEntryPath(botsRoot, bot.directChatId, 1, entry.entryId)));
    expect(files[0]).toMatch(/^0+1-entry_[0-9a-f]{32}\.json$/);
    const index = readJsonFile(journalIndexPath(botsRoot, bot.directChatId), 'index') as {
      nextSeq: number;
      byIdempotencyKey: Record<string, string>;
    };
    expect(index.nextSeq).toBe(2);
    expect(index.byIdempotencyKey['durable-1']).toBe(entry.entryId);
  });

  it('returns the existing entry for a repeated idempotency key', () => {
    const { journal, bot } = setup();
    const input = {
      conversationId: bot.directChatId,
      kind: 'user' as const,
      idempotencyKey: 'once',
    };

    const first = journal.append({ ...input, body: 'first' });
    const second = journal.append({ ...input, body: 'second' });

    expect(second).toEqual(first);
    expect(journal.list(bot.directChatId)).toHaveLength(1);
  });

  it('reconciles an entry written before the index commit after a crash', () => {
    const { journal, bot } = setup();
    const botsRoot = journal.journalRoot;
    const orphanId = 'entry_orphan0123456789abcdef0123456';
    const orphanPath = journalEntryPath(botsRoot, bot.directChatId, 1, orphanId);

    // Simulate: entry file landed, then process died before index.json update.
    writeJsonRecord(orphanPath, {
      schemaVersion: 1,
      entryId: orphanId,
      conversationId: bot.directChatId,
      seq: 1,
      kind: 'user',
      idempotencyKey: 'crash-orphan',
      body: 'survived on disk',
      createdAt: at,
    });
    writeJsonRecord(journalIndexPath(botsRoot, bot.directChatId), {
      schemaVersion: 1,
      conversationId: bot.directChatId,
      nextSeq: 1,
      byIdempotencyKey: {},
      entries: [],
    });

    const next = journal.append({
      conversationId: bot.directChatId,
      kind: 'user',
      body: 'after crash',
      idempotencyKey: 'crash-followup',
    });
    expect(next.seq).toBe(2);

    const listed = journal.list(bot.directChatId);
    expect(listed.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(listed[0]?.entryId).toBe(orphanId);
    expect(listed[0]?.body).toBe('survived on disk');
    expect(listed[1]?.body).toBe('after crash');

    const sameKey = journal.append({
      conversationId: bot.directChatId,
      kind: 'user',
      body: 'ignored',
      idempotencyKey: 'crash-orphan',
    });
    expect(sameKey.entryId).toBe(orphanId);
    expect(journal.list(bot.directChatId)).toHaveLength(2);
  });

  it('reconciles orphaned entries before reporting the head sequence', () => {
    const { journal, bot } = setup();
    const botsRoot = journal.journalRoot;
    const orphanId = 'entry_orphanhead123456789abcdef01234';
    const orphanPath = journalEntryPath(botsRoot, bot.directChatId, 1, orphanId);

    writeJsonRecord(orphanPath, {
      schemaVersion: 1,
      entryId: orphanId,
      conversationId: bot.directChatId,
      seq: 1,
      kind: 'user',
      idempotencyKey: 'crash-orphan-head',
      body: 'survived on disk',
      createdAt: at,
    });
    writeJsonRecord(journalIndexPath(botsRoot, bot.directChatId), {
      schemaVersion: 1,
      conversationId: bot.directChatId,
      nextSeq: 1,
      byIdempotencyKey: {},
      entries: [],
    });

    expect(journal.getHeadSequence(bot.directChatId)).toBe(1);
    expect(journal.list(bot.directChatId)).toHaveLength(1);
    expect(journal.list(bot.directChatId)[0]?.entryId).toBe(orphanId);
  });

  it('preserves imported authorship timestamps', () => {
    const { journal, bot } = setup();

    const entry = journal.append({
      conversationId: bot.directChatId,
      kind: 'user',
      body: 'historical',
      idempotencyKey: 'historical-1',
      createdAt: '2020-01-02T03:04:05.000Z',
    });

    expect(entry.createdAt).toBe('2020-01-02T03:04:05.000Z');
  });
});

describe('ConversationJournal cursors', () => {
  it('tracks unread counts and never moves the cursor backwards', () => {
    const { journal, bot } = setup();
    for (const index of [0, 1, 2]) {
      journal.append({
        conversationId: bot.directChatId,
        kind: 'bot',
        body: `m${index}`,
        idempotencyKey: `cursor-${index}`,
      });
    }

    expect(journal.getCursor(bot.directChatId)).toEqual({
      conversationId: bot.directChatId,
      lastReadSeq: 0,
      unreadCount: 3,
    });
    expect(journal.markRead(bot.directChatId, 2).unreadCount).toBe(1);
    expect(journal.markRead(bot.directChatId, 1).lastReadSeq).toBe(2);
    expect(journal.markRead(bot.directChatId, 99).lastReadSeq).toBe(3);
    expect(journal.getCursor(bot.directChatId).unreadCount).toBe(0);
  });

  it('survives a restart', () => {
    const { root, journal, bot } = setup();
    journal.append({
      conversationId: bot.directChatId,
      kind: 'bot',
      body: 'persisted',
      idempotencyKey: 'restart-1',
    });
    journal.markRead(bot.directChatId, 1);

    const reloaded = createDirectChatJournal({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at });
    expect(reloaded.getCursor(bot.directChatId)).toEqual({
      conversationId: bot.directChatId,
      lastReadSeq: 1,
      unreadCount: 0,
    });
  });
});

describe('ConversationJournal boundaries', () => {
  it('rejects appends for an unknown chat, a foreign bot, and a foreign workspace', () => {
    const { root, journal, bot } = setup();

    expect(() => journal.append({
      conversationId: 'chat_missing',
      kind: 'user',
      body: 'nope',
      idempotencyKey: 'missing-chat',
    })).toThrow(/Conversation not found/);

    expect(() => journal.append({
      conversationId: bot.directChatId,
      authorBotId: 'bot_other',
      kind: 'bot',
      body: 'nope',
      idempotencyKey: 'foreign-bot',
    })).toThrow(/not owned by bot/);

    expect(() => journal.append({
      conversationId: bot.directChatId,
      authorBotId: bot.botId,
      kind: 'user',
      body: 'nope',
      idempotencyKey: 'authored-user',
    })).toThrow(/User entries have no Bot author/);

    const foreign = createDirectChatJournal({ workspaceRoot: root, workspaceId: 'ws_2', clock: () => at });
    expect(() => foreign.list(bot.directChatId)).toThrow(/belongs to another workspace/);

    const entryId = 'entry_foreign_author0123456789abcdef';
    writeJsonRecord(journalIndexPath(journal.journalRoot, bot.directChatId), {
      schemaVersion: 1,
      conversationId: bot.directChatId,
      nextSeq: 2,
      byIdempotencyKey: { foreign: entryId },
      entries: [{ entryId, seq: 1 }],
    });
    writeJsonRecord(journalEntryPath(journal.journalRoot, bot.directChatId, 1, entryId), {
      schemaVersion: 1,
      entryId,
      conversationId: bot.directChatId,
      authorBotId: 'bot_other',
      seq: 1,
      kind: 'bot',
      idempotencyKey: 'foreign',
      body: 'should not be readable',
      createdAt: at,
    });
    expect(() => journal.list(bot.directChatId)).toThrow(/wrong Bot/);
  });
});

describe('ConversationJournal handoff entries', () => {
  it('accepts a handoff entry carrying a handoffId and its authoring Bot', () => {
    const { journal, bot } = setup();

    const entry = journal.append({
      conversationId: bot.directChatId,
      kind: 'handoff',
      authorBotId: bot.botId,
      handoffId: 'handoff_0123456789abcdef0123456789abcdef',
      body: 'handoff announced',
      idempotencyKey: 'handoff-accepted',
    });

    expect(entry.kind).toBe('handoff');
    expect(entry.handoffId).toBe('handoff_0123456789abcdef0123456789abcdef');
    expect(entry.authorBotId).toBe(bot.botId);
    const listed = journal.list(bot.directChatId);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(entry);
  });

  it('rejects a handoff entry without a handoffId', () => {
    const { journal, bot } = setup();

    expect(() => journal.append({
      conversationId: bot.directChatId,
      kind: 'handoff',
      authorBotId: bot.botId,
      body: 'missing handoff id',
      idempotencyKey: 'handoff-missing-id',
    })).toThrow('handoff entries require handoffId');
  });

  it('rejects a handoff entry when no Bot may author the conversation', () => {
    const root = tempWorkspace();
    const journal = new ConversationJournal({
      journalRoot: root,
      workspaceId: 'ws_1',
      resolveConversation: (conversationId) => ({ conversationId, workspaceId: 'ws_1' }),
      clock: () => at,
    });

    expect(() => journal.append({
      conversationId: 'channel_open',
      kind: 'handoff',
      body: 'no author',
      idempotencyKey: 'handoff-no-author',
    })).toThrow('A handoff entry requires an author Bot');
  });

  it('rejects handoffId on non-handoff entries', () => {
    const { journal, bot } = setup();

    expect(() => journal.append({
      conversationId: bot.directChatId,
      kind: 'bot',
      handoffId: 'handoff_0123456789abcdef0123456789abcdef',
      body: 'stray handoff id',
      idempotencyKey: 'handoff-stray',
    })).toThrow('only handoff entries may carry handoffId');
  });

  it('rejects a handoff entry authored by a non-sole-author Bot in a DirectChat', () => {
    const { journal, bot } = setup();

    expect(() => journal.append({
      conversationId: bot.directChatId,
      kind: 'handoff',
      authorBotId: 'bot_other',
      handoffId: 'handoff_0123456789abcdef0123456789abcdef',
      body: 'foreign author',
      idempotencyKey: 'handoff-foreign-author',
    })).toThrow(/not owned by bot/);
  });
});

describe('ConversationJournal approval entries', () => {
  it('accepts an approval entry carrying an approvalId and its authoring Bot', () => {
    const { journal, bot } = setup();

    const entry = journal.append({
      conversationId: bot.directChatId,
      kind: 'approval',
      authorBotId: bot.botId,
      approvalId: 'approval_0123456789abcdef0123456789abcdef',
      body: 'Write /tmp/bounded.txt',
      idempotencyKey: 'approval-accepted',
    });

    expect(entry.kind).toBe('approval');
    expect(entry.approvalId).toBe('approval_0123456789abcdef0123456789abcdef');
    expect(journal.list(bot.directChatId)[0]).toEqual(entry);
  });

  it('rejects an approval entry without an approvalId', () => {
    const { journal, bot } = setup();

    expect(() => journal.append({
      conversationId: bot.directChatId,
      kind: 'approval',
      authorBotId: bot.botId,
      body: 'missing approval id',
      idempotencyKey: 'approval-missing-id',
    })).toThrow('approval entries require approvalId');
  });

  it('rejects approvalId on non-approval entries', () => {
    const { journal, bot } = setup();

    expect(() => journal.append({
      conversationId: bot.directChatId,
      kind: 'bot',
      approvalId: 'approval_0123456789abcdef0123456789abcdef',
      body: 'stray approval id',
      idempotencyKey: 'approval-stray',
    })).toThrow('only approval entries may carry approvalId');
  });
});

describe('ConversationJournal legacy Bot schema migration', () => {
  it('reads and rewrites old chatId/botId index, entry, and cursor records', () => {
    const { journal, bot } = setup();
    const botsRoot = journal.journalRoot;
    const entryId = 'entry_legacy0123456789abcdef012345';
    const entryPath = journalEntryPath(botsRoot, bot.directChatId, 1, entryId);

    writeJsonRecord(journalIndexPath(botsRoot, bot.directChatId), {
      schemaVersion: 1,
      chatId: bot.directChatId,
      nextSeq: 2,
      byIdempotencyKey: { 'legacy-1': entryId },
      entries: [{ entryId, seq: 1 }],
    });
    writeJsonRecord(entryPath, {
      schemaVersion: 1,
      entryId,
      chatId: bot.directChatId,
      botId: bot.botId,
      seq: 1,
      kind: 'bot',
      idempotencyKey: 'legacy-1',
      body: 'hello from legacy',
      createdAt: at,
    });
    writeJsonRecord(journalCursorPath(botsRoot, bot.directChatId), {
      chatId: bot.directChatId,
      lastReadSeq: 1,
    });

    const entries = journal.list(bot.directChatId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      schemaVersion: 1,
      entryId,
      conversationId: bot.directChatId,
      authorBotId: bot.botId,
      seq: 1,
      kind: 'bot',
      idempotencyKey: 'legacy-1',
      body: 'hello from legacy',
      createdAt: at,
    });
    expect(entries[0]).not.toHaveProperty('chatId');
    expect(entries[0]).not.toHaveProperty('botId');

    expect(journal.getCursor(bot.directChatId)).toEqual({
      conversationId: bot.directChatId,
      lastReadSeq: 1,
      unreadCount: 0,
    });

    const indexOnDisk = readJsonFile(journalIndexPath(botsRoot, bot.directChatId)) as Record<string, unknown>;
    expect(indexOnDisk.conversationId).toBe(bot.directChatId);
    expect(indexOnDisk).not.toHaveProperty('chatId');

    const entryOnDisk = readJsonFile(entryPath) as Record<string, unknown>;
    expect(entryOnDisk.conversationId).toBe(bot.directChatId);
    expect(entryOnDisk.authorBotId).toBe(bot.botId);
    expect(entryOnDisk).not.toHaveProperty('chatId');
    expect(entryOnDisk).not.toHaveProperty('botId');

    const cursorOnDisk = readJsonFile(journalCursorPath(botsRoot, bot.directChatId)) as Record<string, unknown>;
    expect(cursorOnDisk).toEqual({
      conversationId: bot.directChatId,
      lastReadSeq: 1,
    });

    const appended = journal.append({
      conversationId: bot.directChatId,
      kind: 'user',
      body: 'after migration',
      idempotencyKey: 'legacy-followup',
    });
    expect(appended.seq).toBe(2);
    expect(journal.list(bot.directChatId).map((entry) => entry.seq)).toEqual([1, 2]);
  });

  it('migrates legacy user entries without carrying botId into authorBotId', () => {
    const { journal, bot } = setup();
    const botsRoot = journal.journalRoot;
    const entryId = 'entry_legacyuser0123456789abcdef01';

    writeJsonRecord(journalIndexPath(botsRoot, bot.directChatId), {
      schemaVersion: 1,
      chatId: bot.directChatId,
      nextSeq: 2,
      byIdempotencyKey: { 'legacy-user': entryId },
      entries: [{ entryId, seq: 1 }],
    });
    writeJsonRecord(journalEntryPath(botsRoot, bot.directChatId, 1, entryId), {
      schemaVersion: 1,
      entryId,
      chatId: bot.directChatId,
      botId: bot.botId,
      seq: 1,
      kind: 'user',
      idempotencyKey: 'legacy-user',
      body: 'user said hi',
      createdAt: at,
    });

    const [entry] = journal.list(bot.directChatId);
    expect(entry?.kind).toBe('user');
    expect(entry?.conversationId).toBe(bot.directChatId);
    expect(entry).not.toHaveProperty('authorBotId');
    expect(entry).not.toHaveProperty('botId');
  });
});
