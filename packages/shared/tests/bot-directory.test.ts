import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotDirectory, ConversationJournal, convertSessionToBot, toBotPublicDto } from '../src/bots/index.ts';

const at = '2026-08-26T00:00:00.000Z';
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'bot-directory-'));
  tempRoots.push(root);
  return root;
}

function provider() {
  return { providerId: 'openai-codex', modelId: 'gpt-5' };
}

describe('BotDirectory', () => {
  it('creates exactly one DirectChat mapping per Bot', () => {
    const directory = new BotDirectory({ workspaceRoot: tempWorkspace(), workspaceId: 'ws_1', clock: () => at });
    const bot = directory.createBot({
      name: 'Research',
      permissionMode: 'ask',
      providerConfig: provider(),
      idempotencyKey: 'create-1',
    });
    expect(bot.directChatId.startsWith('chat_')).toBe(true);
    expect(directory.getDirectChatId(bot.botId)).toBe(bot.directChatId);
    expect(directory.getBotByChat(bot.directChatId)?.botId).toBe(bot.botId);
    expect(directory.listBots()).toHaveLength(1);
  });

  it('retries with the same idempotency key return the same Bot', () => {
    const directory = new BotDirectory({ workspaceRoot: tempWorkspace(), workspaceId: 'ws_1', clock: () => at });
    const first = directory.createBot({
      name: 'Research',
      permissionMode: 'safe',
      providerConfig: provider(),
      idempotencyKey: 'same-key',
    });
    const second = directory.createBot({
      name: 'Other',
      permissionMode: 'allow-all',
      providerConfig: provider(),
      idempotencyKey: 'same-key',
    });
    expect(second.botId).toBe(first.botId);
    expect(second.name).toBe('Research');
    expect(directory.listBots()).toHaveLength(1);
  });

  it('renames, hides, archives, and reopens a Bot', () => {
    const directory = new BotDirectory({ workspaceRoot: tempWorkspace(), workspaceId: 'ws_1', clock: () => at });
    const bot = directory.createBot({
      name: 'Alpha',
      permissionMode: 'ask',
      providerConfig: provider(),
      idempotencyKey: 'lifecycle-1',
    });
    expect(directory.renameBot(bot.botId, 'Beta').name).toBe('Beta');
    expect(directory.hideBot(bot.botId).lifecycle).toBe('hidden');
    expect(directory.listBots()).toHaveLength(0);
    expect(directory.listBots({ lifecycle: 'hidden' })).toHaveLength(1);
    expect(directory.archiveBot(bot.botId).lifecycle).toBe('archived');
    expect(directory.reopenBot(bot.botId).lifecycle).toBe('active');
  });

  it('reloads persisted bots', () => {
    const root = tempWorkspace();
    const directory = new BotDirectory({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at });
    const bot = directory.createBot({
      name: 'Persisted',
      permissionMode: 'ask',
      providerConfig: provider(),
      idempotencyKey: 'recover-1',
    });
    const reloaded = new BotDirectory({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at });
    expect(reloaded.getBot(bot.botId)?.directChatId).toBe(bot.directChatId);
  });

  it('fails closed across workspaces', () => {
    const root = tempWorkspace();
    const a = new BotDirectory({ workspaceRoot: root, workspaceId: 'ws_a', clock: () => at });
    const bot = a.createBot({
      name: 'A',
      permissionMode: 'ask',
      providerConfig: provider(),
      idempotencyKey: 'ws-a',
    });
    const b = new BotDirectory({ workspaceRoot: root, workspaceId: 'ws_b', clock: () => at });
    expect(b.getBot(bot.botId)).toBeNull();
  });

  it('strips legacySessionId from public DTOs', () => {
    const directory = new BotDirectory({ workspaceRoot: tempWorkspace(), workspaceId: 'ws_1', clock: () => at });
    const bot = directory.createBot({
      name: 'Converted',
      permissionMode: 'ask',
      providerConfig: provider(),
      idempotencyKey: 'dto-1',
      legacySessionId: 'session_legacy_1',
    });
    const dto = toBotPublicDto(bot);
    expect('legacySessionId' in dto).toBe(false);
    expect(JSON.stringify(dto)).not.toContain('session_legacy_1');
  });

  it('abandons corrupt unpublished intents', () => {
    const directory = new BotDirectory({ workspaceRoot: tempWorkspace(), workspaceId: 'ws_1', clock: () => at });
    const intentDir = join(directory.rootPath, 'intents', 'intent_corrupt');
    mkdirSync(intentDir, { recursive: true });
    writeFileSync(join(intentDir, 'record.json'), '{not-json');
    expect(directory.recover().abandoned).toContain('intent_corrupt');
  });
});

describe('ConversationJournal', () => {
  it('appends ordered entries and dedupes by idempotency key', () => {
    const root = tempWorkspace();
    const directory = new BotDirectory({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at });
    const journal = new ConversationJournal({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at });
    const bot = directory.createBot({
      name: 'Chat',
      permissionMode: 'ask',
      providerConfig: provider(),
      idempotencyKey: 'journal-bot',
    });
    const first = journal.append({
      chatId: bot.directChatId,
      botId: bot.botId,
      kind: 'user',
      body: 'hello',
      idempotencyKey: 'msg-1',
    });
    const again = journal.append({
      chatId: bot.directChatId,
      botId: bot.botId,
      kind: 'user',
      body: 'hello again',
      idempotencyKey: 'msg-1',
    });
    const second = journal.append({
      chatId: bot.directChatId,
      botId: bot.botId,
      kind: 'bot',
      body: 'hi',
      idempotencyKey: 'msg-2',
    });
    expect(again.entryId).toBe(first.entryId);
    expect(again.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(journal.list(bot.directChatId).map((entry) => entry.body)).toEqual(['hello', 'hi']);
  });

  it('survives directory reload', () => {
    const root = tempWorkspace();
    const directory = new BotDirectory({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at });
    const journal = new ConversationJournal({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at });
    const bot = directory.createBot({
      name: 'Chat',
      permissionMode: 'ask',
      providerConfig: provider(),
      idempotencyKey: 'reload-bot',
    });
    journal.append({
      chatId: bot.directChatId,
      botId: bot.botId,
      kind: 'user',
      body: 'persist me',
      idempotencyKey: 'reload-msg',
    });
    const reloaded = new ConversationJournal({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at });
    expect(reloaded.list(bot.directChatId)[0]!.body).toBe('persist me');
  });
});

describe('convertSessionToBot', () => {
  it('converts once and retries without duplicating or reordering', () => {
    const root = tempWorkspace();
    const directory = new BotDirectory({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at });
    const journal = new ConversationJournal({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at });
    const messages = [
      { role: 'user' as const, text: 'one', createdAt: '2026-08-26T00:00:01.000Z' },
      { role: 'assistant' as const, text: 'two', createdAt: '2026-08-26T00:00:02.000Z' },
      { role: 'user' as const, text: 'three', createdAt: '2026-08-26T00:00:03.000Z' },
    ];
    const first = convertSessionToBot(directory, journal, {
      sessionId: 'session_legacy_convert',
      idempotencyKey: 'convert-1',
      name: 'Legacy Bot',
      permissionMode: 'ask',
      providerConfig: provider(),
      messages,
    });
    const second = convertSessionToBot(directory, journal, {
      sessionId: 'session_legacy_convert',
      idempotencyKey: 'convert-1-retry',
      name: 'Legacy Bot Again',
      permissionMode: 'allow-all',
      providerConfig: provider(),
      messages,
    });
    expect(second.bot.botId).toBe(first.bot.botId);
    expect(second.entries.map((entry) => entry.body)).toEqual(first.entries.map((entry) => entry.body));
    expect(second.entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);

    const reloadedDir = new BotDirectory({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at });
    const reloadedJournal = new ConversationJournal({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at });
    const third = convertSessionToBot(reloadedDir, reloadedJournal, {
      sessionId: 'session_legacy_convert',
      idempotencyKey: 'convert-after-restart',
      name: 'Nope',
      permissionMode: 'safe',
      providerConfig: provider(),
      messages,
    });
    expect(third.bot.botId).toBe(first.bot.botId);
    expect(third.entries.map((entry) => `${entry.seq}:${entry.body}`)).toEqual(
      first.entries.map((entry) => `${entry.seq}:${entry.body}`),
    );
  });
});
