import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotDirectory, convertSessionToBot, createDirectChatJournal, toBotPublicDto } from '../src/bots/index.ts';

const at = '2026-08-26T00:00:00.000Z';
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'bot-convert-'));
  tempRoots.push(root);
  return root;
}

function provider() {
  return { providerId: 'openai-codex', modelId: 'gpt-5' };
}

const messages = [
  { role: 'user', text: 'first', createdAt: '2026-08-01T00:00:01.000Z' },
  { role: 'assistant', text: 'second', createdAt: '2026-08-01T00:00:02.000Z' },
  { role: 'user', text: 'third', createdAt: '2026-08-01T00:00:03.000Z' },
];

function pair(root: string, workspaceId = 'ws_1') {
  return {
    directory: new BotDirectory({ workspaceRoot: root, workspaceId, clock: () => at }),
    journal: createDirectChatJournal({ workspaceRoot: root, workspaceId, clock: () => at }),
  };
}

function convert(root: string, sessionId: string, overrides: Record<string, unknown> = {}) {
  const { directory, journal } = pair(root);
  return convertSessionToBot(directory, journal, {
    sessionId,
    idempotencyKey: 'convert-key',
    name: 'Converted Bot',
    permissionMode: 'ask',
    providerConfig: provider(),
    messages,
    ...overrides,
  });
}

describe('convertSessionToBot', () => {
  it('imports history in order behind a lifecycle cutover marker', () => {
    const root = tempWorkspace();

    const result = convert(root, 'session_alpha');

    expect(result.bot.legacySessionId).toBe('session_alpha');
    expect(result.chatId).toBe(result.bot.directChatId);
    expect(result.entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
    expect(result.entries.map((entry) => entry.kind)).toEqual(['user', 'bot', 'user', 'lifecycle']);
    expect(result.entries.slice(0, 3).map((entry) => entry.body)).toEqual(['first', 'second', 'third']);
    expect(result.entries.slice(0, 3).map((entry) => entry.createdAt)).toEqual(
      messages.map((message) => message.createdAt),
    );
    expect(result.disposition.disposition).toBe('converted');
    expect(result.disposition.cutoverMarkerEntryId).toBe(result.entries[3]!.entryId);
  });

  it('never deletes the legacy session transcript', () => {
    const root = tempWorkspace();
    const transcript = join(root, 'session_beta.jsonl');
    writeFileSync(transcript, '{"role":"user"}\n');

    convert(root, 'session_beta');

    expect(existsSync(transcript)).toBe(true);
  });

  it('is idempotent across retries with a different caller key', () => {
    const root = tempWorkspace();

    const first = convert(root, 'session_gamma');
    const retry = convert(root, 'session_gamma', {
      idempotencyKey: 'convert-key-retry',
      name: 'Different Name',
      permissionMode: 'allow-all',
    });

    expect(retry.bot.botId).toBe(first.bot.botId);
    expect(retry.bot.name).toBe('Converted Bot');
    expect(retry.entries.map((entry) => `${entry.seq}:${entry.entryId}:${entry.body}`)).toEqual(
      first.entries.map((entry) => `${entry.seq}:${entry.entryId}:${entry.body}`),
    );
  });

  it('is restart-safe and does not duplicate or reorder entries', () => {
    const root = tempWorkspace();
    const first = convert(root, 'session_delta');

    const { directory, journal } = pair(root);
    const afterRestart = convertSessionToBot(directory, journal, {
      sessionId: 'session_delta',
      idempotencyKey: 'convert-after-restart',
      name: 'Ignored',
      permissionMode: 'safe',
      providerConfig: provider(),
      messages,
    });

    expect(afterRestart.bot.botId).toBe(first.bot.botId);
    expect(journal.list(first.chatId)).toHaveLength(4);
    expect(afterRestart.entries.map((entry) => `${entry.seq}:${entry.body}`)).toEqual(
      first.entries.map((entry) => `${entry.seq}:${entry.body}`),
    );
    expect(directory.listBots()).toHaveLength(1);
  });

  it('converges a half-written conversion when the append loop was interrupted', () => {
    const root = tempWorkspace();
    const { directory, journal } = pair(root);
    const bot = directory.createBot({
      name: 'Converted Bot',
      permissionMode: 'ask',
      providerConfig: provider(),
      idempotencyKey: 'convert:bot:session_epsilon',
      legacySessionId: 'session_epsilon',
    });
    journal.append({
      conversationId: bot.directChatId,
      kind: 'user',
      body: 'first',
      idempotencyKey: 'convert.session_epsilon.0',
      entryId: 'entry_convert_session_epsilon_0',
      createdAt: messages[0]!.createdAt,
    });

    const resumed = convert(root, 'session_epsilon');

    expect(resumed.bot.botId).toBe(bot.botId);
    expect(resumed.entries.map((entry) => `${entry.seq}:${entry.body}`)).toEqual([
      '1:first',
      '2:second',
      '3:third',
      `4:${resumed.entries[3]!.body}`,
    ]);
    expect(resumed.entries[3]!.kind).toBe('lifecycle');
  });

  it('keeps the legacy session ID out of the public DTO', () => {
    const root = tempWorkspace();
    const result = convert(root, 'session_zeta');

    const dto = toBotPublicDto(result.bot);
    expect(Object.keys(dto).sort()).toEqual([
      'botId',
      'createdAt',
      'directChatId',
      'lifecycle',
      'name',
      'permissionMode',
      'providerConfig',
      'updatedAt',
      'workspaceId',
    ]);
    expect(JSON.stringify(dto)).not.toContain('session_zeta');
  });

  it('refuses to convert into a foreign workspace', () => {
    const root = tempWorkspace();
    const { directory, journal } = pair(root);

    expect(() => convertSessionToBot(directory, journal, {
      sessionId: 'session_eta',
      workspaceId: 'ws_other',
      idempotencyKey: 'convert-foreign',
      name: 'Nope',
      permissionMode: 'ask',
      providerConfig: provider(),
      messages,
    })).toThrow(/another workspace/);
  });
});
