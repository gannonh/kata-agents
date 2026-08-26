import { readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  ensureDurableDirectory,
} from '../spawn-tasks/durable-fs.ts';
import { readJsonFile, writeJsonIfAbsent, writeJsonRecord } from '../conversations/durable-json.ts';
import type { RouteRecord } from '@kata-sh/core';
import { channelsRootPath, channelRoutePath, channelRoutesPath } from './layout.ts';
import { assertChannelId, assertRouteRecord } from './validation.ts';

export interface RouteStoreOptions {
  readonly workspaceRoot: string;
  readonly workspaceId: string;
  readonly clock?: () => string;
}

export class RouteStore {
  readonly rootPath: string;
  readonly workspaceId: string;

  private readonly clock: () => string;

  constructor(options: RouteStoreOptions) {
    assertChannelId(options.workspaceId, 'workspaceId');
    this.rootPath = channelsRootPath(options.workspaceRoot);
    this.workspaceId = options.workspaceId;
    this.clock = options.clock ?? (() => new Date().toISOString());
    ensureDurableDirectory(this.rootPath);
  }

  get(channelId: string, routeId: string): RouteRecord | null {
    assertChannelId(channelId);
    const record = readJsonFile(channelRoutePath(this.rootPath, channelId, routeId));
    if (!record) return null;
    return this.assertOwned(record, channelId, routeId);
  }

  list(channelId: string, options?: { limit?: number }): RouteRecord[] {
    assertChannelId(channelId);
    const limit = options?.limit;
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) throw new Error('limit must be a non-negative safe integer');
    const directory = channelRoutesPath(this.rootPath, channelId);
    ensureDurableDirectory(directory);
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => this.assertOwned(readJsonFile(`${directory}/${entry.name}`), channelId, entry.name.slice(0, -5)))
      .sort((left, right) => right.routeSeq - left.routeSeq || right.routeId.localeCompare(left.routeId))
      .slice(0, limit);
  }

  commit(record: RouteRecord): RouteRecord {
    const validated = this.assertOwned(record, record.channelId, record.routeId);
    ensureDurableDirectory(channelRoutesPath(this.rootPath, validated.channelId));
    const path = channelRoutePath(this.rootPath, validated.channelId, validated.routeId);
    if (!writeJsonIfAbsent(path, validated)) {
      const existing = readJsonFile(path);
      if (!existing) throw new Error(`Route disappeared during commit: ${validated.routeId}`);
      return this.assertOwned(existing, validated.channelId, validated.routeId);
    }
    return validated;
  }

  update(record: RouteRecord): RouteRecord {
    const validated = this.assertOwned(record, record.channelId, record.routeId);
    const path = channelRoutePath(this.rootPath, validated.channelId, validated.routeId);
    if (!readJsonFile(path)) throw new Error(`Route not found: ${validated.routeId}`);
    writeJsonRecord(path, validated);
    return validated;
  }

  private assertOwned(value: unknown, channelId: string, routeId: string): RouteRecord {
    if (value === null) throw new Error(`Route not found: ${routeId}`);
    const record = assertRouteRecord(value);
    if (record.routeId !== routeId) throw new Error(`Route identity mismatch for ${routeId}`);
    if (record.channelId !== channelId) throw new Error(`Route ${routeId} belongs to another Channel`);
    if (record.workspaceId !== this.workspaceId) throw new Error(`Route ${routeId} belongs to another workspace`);
    return record;
  }
}

