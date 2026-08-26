import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  BOT_SCHEMA_VERSION,
  type BotLifecycle,
  type BotPermissionMode,
  type BotProviderConfig,
  type BotRecord,
  type CreationIntent,
  type DirectChatRecord,
} from '@kata-sh/core';
import {
  ensureDurableDirectory,
  syncDirectory,
  writeDurableFileIfAbsent,
} from '../spawn-tasks/durable-fs.ts';
import { reserveBotIds } from './ids.ts';
import {
  botChatPointerPath,
  botRecordPath,
  botsPath,
  botsRootPath,
  chatRecordPath,
  idempotencyPointerPath,
  intentRecordPath,
  intentsPath,
  legacySessionPointerPath,
} from './layout.ts';
import { readJsonFile, removePointer, writeJsonRecord } from '../conversations/index.ts';
import {
  assertBotId,
  assertBotName,
  assertBotProfile,
  assertBotProviderConfig,
  assertBotRecord,
  assertCreationIntent,
  assertDirectChatRecord,
  assertIdempotencyKey,
} from './validation.ts';

const MAX_RESERVATION_ATTEMPTS = 16;

export interface BotDirectoryOptions {
  readonly workspaceRoot: string;
  readonly workspaceId: string;
  readonly clock?: () => string;
  readonly randomId?: () => string;
}

export interface CreateBotInput {
  readonly name: string;
  readonly permissionMode: BotPermissionMode;
  readonly providerConfig: BotProviderConfig;
  readonly profile?: string;
  readonly idempotencyKey: string;
  readonly legacySessionId?: string;
}

export interface UpdateBotInput {
  readonly profile?: string;
  readonly permissionMode?: BotPermissionMode;
  readonly providerConfig?: BotProviderConfig;
}

export interface BotRecoveryReport {
  readonly published: string[];
  readonly abandoned: string[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class BotDirectory {
  readonly rootPath: string;
  readonly workspaceId: string;

  private readonly clock: () => string;
  private readonly randomId: () => string;
  private readonly bots = new Map<string, BotRecord>();
  private readonly botByChat = new Map<string, string>();
  private readonly loadErrors = new Map<string, string>();

  constructor(options: BotDirectoryOptions) {
    assertBotId(options.workspaceId, 'workspaceId');
    this.rootPath = botsRootPath(options.workspaceRoot);
    this.workspaceId = options.workspaceId;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.randomId = options.randomId ?? randomUUID;
    ensureDurableDirectory(this.rootPath);
    ensureDurableDirectory(botsPath(this.rootPath));
    ensureDurableDirectory(intentsPath(this.rootPath));
    for (const directory of ['chats', 'by-idempotency', 'by-bot-chat', 'by-legacy-session', 'dispositions']) {
      ensureDurableDirectory(join(this.rootPath, directory));
    }
    this.reload();
  }

  createBot(input: CreateBotInput): BotRecord {
    const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
    assertBotName(input.name);
    if (input.profile !== undefined) assertBotProfile(input.profile);
    assertBotProviderConfig(input.providerConfig);
    if (input.legacySessionId !== undefined) assertBotId(input.legacySessionId, 'legacySessionId');

    const pointerPath = idempotencyPointerPath(this.rootPath, idempotencyKey);
    const pointedBotId = this.readPointer(pointerPath);
    if (pointedBotId) {
      const existing = this.getBot(pointedBotId);
      if (existing) return existing;
      return this.publish(this.requireIntentForBot(pointedBotId, idempotencyKey));
    }

    for (let attempt = 0; attempt < MAX_RESERVATION_ATTEMPTS; attempt += 1) {
      const ids = reserveBotIds(this.randomId);
      assertBotId(ids.intentId, 'intentId');
      assertBotId(ids.botId, 'botId');
      assertBotId(ids.directChatId, 'directChatId');
      if (this.bots.has(ids.botId) || this.botByChat.has(ids.directChatId)) continue;
      if (existsSync(intentRecordPath(this.rootPath, ids.intentId))) continue;
      if (existsSync(botRecordPath(this.rootPath, ids.botId))) continue;
      if (existsSync(chatRecordPath(this.rootPath, ids.directChatId))) continue;

      const now = this.clock();
      const intent: CreationIntent = assertCreationIntent({
        schemaVersion: BOT_SCHEMA_VERSION,
        intentId: ids.intentId,
        workspaceId: this.workspaceId,
        botId: ids.botId,
        directChatId: ids.directChatId,
        idempotencyKey,
        name: input.name,
        ...(input.profile !== undefined ? { profile: input.profile } : {}),
        permissionMode: input.permissionMode,
        providerConfig: input.providerConfig,
        ...(input.legacySessionId !== undefined ? { legacySessionId: input.legacySessionId } : {}),
        state: 'reserved',
        createdAt: now,
        updatedAt: now,
      });
      writeJsonRecord(intentRecordPath(this.rootPath, intent.intentId), intent);

      const claimed = writeDurableFileIfAbsent(pointerPath, `${intent.botId}\n`);
      if (!claimed) {
        const winner = this.readPointer(pointerPath);
        if (!winner) throw new Error('Bot idempotency pointer is unreadable');
        this.abandon(intent);
        const existing = this.getBot(winner);
        return existing ?? this.publish(this.requireIntentForBot(winner, idempotencyKey));
      }
      syncDirectory(`${this.rootPath}/by-idempotency`);
      return this.publish(intent);
    }

    throw new Error(`Unable to reserve unique bot IDs after ${MAX_RESERVATION_ATTEMPTS} attempts`);
  }

  getBot(botId: string): BotRecord | null {
    assertBotId(botId, 'botId');
    const bot = this.bots.get(botId);
    return bot ? clone(bot) : null;
  }

  getBotByChat(chatId: string): BotRecord | null {
    assertBotId(chatId, 'chatId');
    const botId = this.botByChat.get(chatId);
    return botId ? this.getBot(botId) : null;
  }

  getBotByLegacySession(sessionId: string): BotRecord | null {
    assertBotId(sessionId, 'sessionId');
    const botId = this.readPointer(legacySessionPointerPath(this.rootPath, sessionId));
    return botId ? this.getBot(botId) : null;
  }

  listBots(filter?: { lifecycle?: BotLifecycle | 'all' }): BotRecord[] {
    const lifecycle = filter?.lifecycle ?? 'active';
    return [...this.bots.values()]
      .filter((bot) => lifecycle === 'all' || bot.lifecycle === lifecycle)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.botId.localeCompare(right.botId))
      .map(clone);
  }

  renameBot(botId: string, name: string): BotRecord {
    assertBotName(name);
    return this.commit({ ...this.require(botId), name });
  }

  updateBot(botId: string, patch: UpdateBotInput): BotRecord {
    const current = this.require(botId);
    if (patch.profile !== undefined) assertBotProfile(patch.profile);
    if (patch.providerConfig !== undefined) assertBotProviderConfig(patch.providerConfig);
    return this.commit({
      ...current,
      ...(patch.profile !== undefined ? { profile: patch.profile } : {}),
      ...(patch.permissionMode !== undefined ? { permissionMode: patch.permissionMode } : {}),
      ...(patch.providerConfig !== undefined ? { providerConfig: patch.providerConfig } : {}),
    });
  }

  hideBot(botId: string): BotRecord {
    const current = this.require(botId);
    return this.commit({ ...current, lifecycle: 'hidden', hiddenAt: current.hiddenAt ?? this.clock() });
  }

  archiveBot(botId: string): BotRecord {
    const current = this.require(botId);
    return this.commit({ ...current, lifecycle: 'archived', archivedAt: current.archivedAt ?? this.clock() });
  }

  reopenBot(botId: string): BotRecord {
    const current = this.require(botId);
    if (current.lifecycle === 'active') return clone(current);
    const { hiddenAt: _hiddenAt, archivedAt: _archivedAt, ...rest } = current;
    return this.commit({ ...rest, lifecycle: 'active' });
  }

  getDirectChatId(botId: string): string {
    return this.require(botId).directChatId;
  }

  recover(): BotRecoveryReport {
    const published: string[] = [];
    const abandoned: string[] = [];
    for (const entry of readdirSync(intentsPath(this.rootPath), { withFileTypes: true })) {
      if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
      let intent: CreationIntent;
      try {
        intent = this.requireIntent(entry.name);
      } catch {
        abandoned.push(entry.name);
        continue;
      }
      if (intent.state !== 'reserved' || intent.workspaceId !== this.workspaceId) continue;
      try {
        this.publish(intent);
        published.push(intent.intentId);
      } catch {
        this.abandon(intent);
        abandoned.push(intent.intentId);
      }
    }
    return { published, abandoned };
  }

  reload(): void {
    this.bots.clear();
    this.botByChat.clear();
    this.loadErrors.clear();
    for (const entry of readdirSync(botsPath(this.rootPath), { withFileTypes: true })) {
      if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
      try {
        this.index(this.requireBot(entry.name));
      } catch (error) {
        this.loadErrors.set(entry.name, error instanceof Error ? error.message : String(error));
      }
    }
  }

  getLoadErrors(): Readonly<Record<string, string>> {
    return Object.freeze(Object.fromEntries(this.loadErrors));
  }

  private publish(intent: CreationIntent): BotRecord {
    if (intent.workspaceId !== this.workspaceId) {
      throw new Error(`Bot creation intent belongs to another workspace: ${intent.intentId}`);
    }
    if (intent.state === 'abandoned') {
      throw new Error(`Bot creation intent was abandoned: ${intent.intentId}`);
    }

    const existing = this.readBot(intent.botId);
    const bot: BotRecord = existing ?? assertBotRecord({
      schemaVersion: BOT_SCHEMA_VERSION,
      botId: intent.botId,
      workspaceId: intent.workspaceId,
      directChatId: intent.directChatId,
      name: intent.name,
      ...(intent.profile !== undefined ? { profile: intent.profile } : {}),
      permissionMode: intent.permissionMode,
      providerConfig: intent.providerConfig,
      ...(intent.legacySessionId !== undefined ? { legacySessionId: intent.legacySessionId } : {}),
      lifecycle: 'active',
      createdAt: intent.createdAt,
      updatedAt: intent.createdAt,
    });
    if (bot.directChatId !== intent.directChatId) {
      throw new Error(`Bot ${bot.botId} already owns a different direct chat`);
    }
    if (!existing) writeJsonRecord(botRecordPath(this.rootPath, bot.botId), bot);

    if (!this.readChat(intent.directChatId)) {
      const chat: DirectChatRecord = assertDirectChatRecord({
        schemaVersion: BOT_SCHEMA_VERSION,
        chatId: intent.directChatId,
        botId: intent.botId,
        workspaceId: intent.workspaceId,
        createdAt: intent.createdAt,
      });
      writeJsonRecord(chatRecordPath(this.rootPath, chat.chatId), chat);
    }

    const pointerPath = botChatPointerPath(this.rootPath, intent.botId);
    if (!writeDurableFileIfAbsent(pointerPath, `${intent.directChatId}\n`)) {
      const owned = this.readPointer(pointerPath);
      if (owned !== intent.directChatId) {
        throw new Error(`Bot ${intent.botId} already maps to direct chat ${owned}`);
      }
    } else {
      syncDirectory(dirname(pointerPath));
    }
    if (intent.legacySessionId) {
      const legacyPath = legacySessionPointerPath(this.rootPath, intent.legacySessionId);
      if (!writeDurableFileIfAbsent(legacyPath, `${intent.botId}\n`)) {
        const owned = this.readPointer(legacyPath);
        if (owned !== intent.botId) throw new Error(`Legacy session ${intent.legacySessionId} maps to another Bot`);
      } else {
        syncDirectory(dirname(legacyPath));
      }
    }

    if (intent.state !== 'published') {
      const at = this.clock();
      writeJsonRecord(
        intentRecordPath(this.rootPath, intent.intentId),
        assertCreationIntent({ ...intent, state: 'published', updatedAt: at, publishedAt: at }),
      );
    }

    this.index(bot);
    return clone(bot);
  }

  private abandon(intent: CreationIntent): void {
    const at = this.clock();
    writeJsonRecord(
      intentRecordPath(this.rootPath, intent.intentId),
      assertCreationIntent({ ...intent, state: 'abandoned', updatedAt: at }),
    );
    const pointerPath = idempotencyPointerPath(this.rootPath, intent.idempotencyKey);
    if (this.readPointer(pointerPath) === intent.botId) removePointer(pointerPath);
  }

  private commit(next: BotRecord): BotRecord {
    const record = assertBotRecord({ ...next, updatedAt: this.clock() });
    if (record.workspaceId !== this.workspaceId) throw new Error('Bot workspace ownership cannot change');
    writeJsonRecord(botRecordPath(this.rootPath, record.botId), record);
    this.index(record);
    return clone(record);
  }

  private require(botId: string): BotRecord {
    assertBotId(botId, 'botId');
    const bot = this.bots.get(botId);
    if (!bot) throw new Error(`Bot not found: ${botId}`);
    return bot;
  }

  private requireBot(botId: string): BotRecord {
    const bot = this.readBot(botId);
    if (!bot) throw new Error(`Bot record not found: ${botId}`);
    return bot;
  }

  private requireIntent(intentId: string): CreationIntent {
    assertBotId(intentId, 'intentId');
    const record = readJsonFile(intentRecordPath(this.rootPath, intentId));
    if (!record) throw new Error(`Bot creation intent not found: ${intentId}`);
    return assertCreationIntent(record);
  }

  private requireIntentForBot(botId: string, idempotencyKey: string): CreationIntent {
    for (const entry of readdirSync(intentsPath(this.rootPath), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const intent = this.requireIntent(entry.name);
        if (
          intent.state === 'reserved'
          && intent.botId === botId
          && intent.idempotencyKey === idempotencyKey
          && intent.workspaceId === this.workspaceId
        ) return intent;
      } catch {
        continue;
      }
    }
    throw new Error(`No reserved creation intent exists for Bot ${botId}`);
  }

  private readPointer(path: string): string | null {
    try {
      return assertBotId(readFileSync(path, 'utf8').trim(), 'pointer');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  private readBot(botId: string): BotRecord | null {
    const record = readJsonFile(botRecordPath(this.rootPath, botId));
    if (!record) return null;
    const bot = assertBotRecord(record);
    if (bot.botId !== botId) throw new Error(`Bot record identity mismatch for ${botId}`);
    if (bot.workspaceId !== this.workspaceId) throw new Error(`Bot ${botId} belongs to another workspace`);
    return bot;
  }

  private readChat(chatId: string): DirectChatRecord | null {
    const record = readJsonFile(chatRecordPath(this.rootPath, chatId));
    return record ? assertDirectChatRecord(record) : null;
  }

  private index(bot: BotRecord): void {
    const owner = this.botByChat.get(bot.directChatId);
    if (owner && owner !== bot.botId) throw new Error(`Direct chat ${bot.directChatId} is already owned by ${owner}`);
    this.bots.set(bot.botId, clone(bot));
    this.botByChat.set(bot.directChatId, bot.botId);
  }
}
