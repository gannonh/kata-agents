import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { BotDirectory, createDirectChatJournal } from '../src/bots/index.ts';
import { journalEntriesPath, journalEntryPath, journalIndexPath, readJsonFile } from '../src/conversations/index.ts';

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
  });
});
