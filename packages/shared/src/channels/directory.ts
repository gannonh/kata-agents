import { existsSync, readdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  CHANNEL_SCHEMA_VERSION,
  CHANNEL_LIMITS,
  type BotLifecycle,
  type ChannelLifecycle,
  type ChannelRecord,
} from '@kata-sh/core';
import { ensureDurableDirectory } from '../spawn-tasks/durable-fs.ts';
import { readJsonFile, removePointer, writeJsonIfAbsent, writeJsonRecord } from '../conversations/durable-json.ts';
import { idempotencyPointerName } from '../bots/ids.ts';
import { channelsRootPath, channelsPath, channelPath, channelRecordPath, channelIdempotencyPath } from './layout.ts';
import { reserveChannelId } from './ids.ts';
import {
  assertChannelId,
  assertChannelIdempotencyKey,
  assertChannelName,
  assertChannelRecord,
} from './validation.ts';

const MAX_RESERVATION_ATTEMPTS = 16;

export interface ChannelBotView {
  readonly botId: string;
  readonly name: string;
  readonly profile?: string;
  readonly lifecycle: BotLifecycle;
}

export interface ChannelDirectoryOptions {
  readonly workspaceRoot: string;
  readonly workspaceId: string;
  readonly resolveBot: (botId: string) => ChannelBotView | null;
  readonly clock?: () => string;
  readonly randomId?: () => string;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class ChannelDirectory {
  readonly rootPath: string;
  readonly workspaceId: string;

  private readonly clock: () => string;
  private readonly randomId: () => string;
  private readonly resolveBotInWorkspace: (botId: string) => ChannelBotView | null;
  private readonly channels = new Map<string, ChannelRecord>();

  constructor(options: ChannelDirectoryOptions) {
    assertChannelId(options.workspaceId, 'workspaceId');
    this.rootPath = channelsRootPath(options.workspaceRoot);
    this.workspaceId = options.workspaceId;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.randomId = options.randomId ?? randomUUID;
    this.resolveBotInWorkspace = options.resolveBot;
    ensureDurableDirectory(this.rootPath);
    ensureDurableDirectory(channelsPath(this.rootPath));
    ensureDurableDirectory(`${this.rootPath}/by-idempotency`);
    ensureDurableDirectory(`${this.rootPath}/journals`);
    this.reload();
  }

  createChannel(input: { name: string; idempotencyKey: string; botIds?: readonly string[] }): ChannelRecord {
    const name = assertChannelName(input.name);
    const idempotencyKey = assertChannelIdempotencyKey(input.idempotencyKey);
    const pointerPath = channelIdempotencyPath(this.rootPath, idempotencyPointerName(idempotencyKey));
    const pointedChannelId = this.readPointer(pointerPath);
    if (pointedChannelId) {
      const existing = this.getChannel(pointedChannelId);
      if (existing) return existing;
      removePointer(pointerPath);
    }

    const botIds = [...new Set(input.botIds ?? [])];
    if (botIds.length > CHANNEL_LIMITS.maxMembers) throw new Error(`members exceeds ${CHANNEL_LIMITS.maxMembers} entries`);
    const members = botIds.map((botId, priority) => {
      assertChannelId(botId, 'botId');
      const bot = this.resolveBot(botId);
      if (!bot) throw new Error(`Bot not found in workspace: ${botId}`);
      return { botId, priority, addedAt: this.clock() };
    });

    for (let attempt = 0; attempt < MAX_RESERVATION_ATTEMPTS; attempt += 1) {
      const channelId = reserveChannelId(this.randomId);
      assertChannelId(channelId);
      const now = this.clock();
      const record = assertChannelRecord({
        schemaVersion: CHANNEL_SCHEMA_VERSION,
        channelId,
        workspaceId: this.workspaceId,
        name,
        lifecycle: 'active',
        membershipRevision: 1,
        members,
        createdAt: now,
        updatedAt: now,
      });
      const recordPath = channelRecordPath(this.rootPath, channelId);
      if (!writeJsonIfAbsent(recordPath, record)) continue;
      if (writeJsonIfAbsent(pointerPath, channelId)) {
        this.channels.set(channelId, record);
        return clone(record);
      }
      rmSync(channelPath(this.rootPath, channelId), { recursive: true, force: true });
      const winner = this.readPointer(pointerPath);
      if (!winner) throw new Error('Channel idempotency pointer is unreadable');
      const existing = this.getChannel(winner);
      if (existing) return existing;
      throw new Error('Channel idempotency pointer targets a missing Channel');
    }
    throw new Error(`Unable to reserve unique Channel ID after ${MAX_RESERVATION_ATTEMPTS} attempts`);
  }

  getChannel(channelId: string): ChannelRecord | null {
    assertChannelId(channelId);
    const record = readJsonFile(channelRecordPath(this.rootPath, channelId));
    if (!record) {
      this.channels.delete(channelId);
      return null;
    }
    const channel = assertChannelRecord(record);
    if (channel.channelId !== channelId) throw new Error(`Channel identity mismatch for ${channelId}`);
    if (channel.workspaceId !== this.workspaceId) throw new Error(`Channel ${channelId} belongs to another workspace`);
    this.channels.set(channelId, channel);
    return clone(channel);
  }

  listChannels(filter?: { lifecycle?: ChannelLifecycle | 'all' }): ChannelRecord[] {
    const lifecycle = filter?.lifecycle ?? 'active';
    return [...this.channels.values()]
      .filter((channel) => lifecycle === 'all' || channel.lifecycle === lifecycle)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.channelId.localeCompare(right.channelId))
      .map(clone);
  }

  renameChannel(channelId: string, name: string): ChannelRecord {
    return this.commit({ ...this.require(channelId), name: assertChannelName(name) });
  }

  archiveChannel(channelId: string): ChannelRecord {
    const current = this.require(channelId);
    if (current.lifecycle === 'archived') return current;
    return this.commit({ ...current, lifecycle: 'archived', archivedAt: current.archivedAt ?? this.clock() });
  }

  reopenChannel(channelId: string): ChannelRecord {
    const current = this.require(channelId);
    if (current.lifecycle === 'active') return current;
    const { archivedAt: _archivedAt, ...rest } = current;
    return this.commit({ ...rest, lifecycle: 'active' });
  }

  deleteChannel(channelId: string): void {
    const current = this.require(channelId);
    const pointerDirectory = `${this.rootPath}/by-idempotency`;
    if (existsSync(pointerDirectory)) {
      for (const entry of readdirSync(pointerDirectory, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const path = `${pointerDirectory}/${entry.name}`;
        if (this.readPointer(path) === current.channelId) removePointer(path);
      }
    }
    rmSync(channelPath(this.rootPath, channelId), { recursive: true, force: true });
    rmSync(`${this.rootPath}/journals/${channelId}`, { recursive: true, force: true });
    this.channels.delete(channelId);
  }

  addMember(channelId: string, botId: string): ChannelRecord {
    assertChannelId(botId, 'botId');
    const current = this.require(channelId);
    const bot = this.resolveBot(botId);
    if (!bot) throw new Error(`Bot not found in workspace: ${botId}`);
    if (current.members.some((member) => member.botId === botId)) return current;
    if (current.members.length >= CHANNEL_LIMITS.maxMembers) throw new Error(`members exceeds ${CHANNEL_LIMITS.maxMembers} entries`);
    const priority = Math.max(-1, ...current.members.map((member) => member.priority)) + 1;
    return this.commit({
      ...current,
      membershipRevision: current.membershipRevision + 1,
      members: [...current.members, { botId, priority, addedAt: this.clock() }],
    });
  }

  removeMember(channelId: string, botId: string): ChannelRecord {
    const current = this.require(channelId);
    if (!current.members.some((member) => member.botId === botId)) return current;
    return this.commit({
      ...current,
      membershipRevision: current.membershipRevision + 1,
      members: current.members.filter((member) => member.botId !== botId),
    });
  }

  isMember(channelId: string, botId: string): boolean {
    const channel = this.getChannel(channelId);
    return channel?.members.some((member) => member.botId === botId) ?? false;
  }

  resolveBot(botId: string): ChannelBotView | null {
    const bot = this.resolveBotInWorkspace(botId);
    if (!bot || bot.botId !== botId) return null;
    return bot;
  }

  reload(): void {
    this.channels.clear();
    for (const entry of readdirSync(channelsPath(this.rootPath), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const channel = this.getChannel(entry.name);
      if (channel) this.channels.set(channel.channelId, channel);
    }
  }

  private require(channelId: string): ChannelRecord {
    const channel = this.getChannel(channelId);
    if (!channel) throw new Error(`Channel not found: ${channelId}`);
    return channel;
  }

  private commit(next: ChannelRecord): ChannelRecord {
    const record = assertChannelRecord({ ...next, updatedAt: this.clock() });
    if (record.workspaceId !== this.workspaceId) throw new Error('Channel workspace ownership cannot change');
    writeJsonRecord(channelRecordPath(this.rootPath, record.channelId), record);
    this.channels.set(record.channelId, record);
    return clone(record);
  }

  private readPointer(path: string): string | null {
    const value = readJsonFile(path);
    if (value === null) return null;
    return assertChannelId(value, 'pointer');
  }
}
