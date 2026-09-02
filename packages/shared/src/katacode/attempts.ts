import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  KATACODE_ATTEMPT_SCHEMA_VERSION,
  KATACODE_ATTEMPT_STATES,
  type KatacodeAttempt,
  type KatacodeAttemptState,
  type KatacodeWorktreeSummary,
} from '@kata-sh/core';
import { getWorkspaceSpawnTasksPath } from '../workspaces/storage.ts';
import { readJsonFile, writeJsonIfAbsent, writeJsonRecord } from '../conversations/durable-json.ts';
import { assertDirectory, ensureDurableDirectory } from '../spawn-tasks/durable-fs.ts';
import { assertSpawnTaskId } from '../spawn-tasks/validation.ts';
import { canAdvanceKatacodeAttempt } from './mapping.ts';

const ATTEMPTS_DIRECTORY = 'attempts';
const INDEX_DIRECTORY = 'by-katacode';

export class KatacodeAttemptError extends Error {
  readonly code: 'stale_fence' | 'illegal_transition' | 'uncertain_blocks_retry';

  constructor(code: KatacodeAttemptError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export interface KatacodeAttemptStoreOptions {
  readonly workspaceRoot: string;
  readonly workspaceId: string;
  readonly clock?: () => string;
  readonly randomId?: () => string;
}

export interface CreateKatacodeAttemptInput {
  readonly taskId: string;
  readonly conversationId: string;
  readonly ownerBotId: string;
  readonly clientIdempotencyKey: string;
  readonly worktree: KatacodeWorktreeSummary;
  readonly taskVersion: number;
}

function hashKey(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertAttempt(value: unknown): KatacodeAttempt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Katacode attempt must be an object');
  }
  const attempt = value as KatacodeAttempt;
  if (attempt.schemaVersion !== KATACODE_ATTEMPT_SCHEMA_VERSION) {
    throw new TypeError('Unsupported Katacode attempt schema');
  }
  if (!(KATACODE_ATTEMPT_STATES as readonly string[]).includes(attempt.state)) {
    throw new TypeError('Unknown Katacode attempt state');
  }
  return attempt;
}

export class KatacodeAttemptStore {
  readonly workspaceId: string;
  private readonly rootPath: string;
  private readonly clock: () => string;
  private readonly randomId: () => string;

  constructor(options: KatacodeAttemptStoreOptions) {
    this.workspaceId = options.workspaceId;
    this.rootPath = getWorkspaceSpawnTasksPath(options.workspaceRoot);
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.randomId = options.randomId ?? randomUUID;
    ensureDurableDirectory(this.rootPath);
    ensureDurableDirectory(this.indexRoot());
  }

  createPending(input: CreateKatacodeAttemptInput): KatacodeAttempt {
    assertSpawnTaskId(input.taskId, 'taskId');
    const existing = this.getByIdempotencyKey(input.conversationId, input.clientIdempotencyKey);
    if (existing) return existing;

    const now = this.clock();
    const attempt: KatacodeAttempt = {
      schemaVersion: KATACODE_ATTEMPT_SCHEMA_VERSION,
      attemptId: `katacode_${this.randomId()}`,
      taskId: input.taskId,
      workspaceId: this.workspaceId,
      conversationId: input.conversationId,
      ownerBotId: input.ownerBotId,
      clientIdempotencyKey: input.clientIdempotencyKey,
      state: 'pending',
      fence: { attemptNonce: this.randomId(), taskVersion: input.taskVersion },
      worktree: input.worktree,
      createdAt: now,
    };
    const path = this.attemptPath(input.taskId, attempt.attemptId);
    if (!writeJsonIfAbsent(path, attempt)) {
      return this.require(input.taskId, attempt.attemptId);
    }
    writeJsonIfAbsent(this.indexPath(input.conversationId, input.clientIdempotencyKey), {
      taskId: input.taskId,
      attemptId: attempt.attemptId,
    });
    return attempt;
  }

  get(taskId: string, attemptId: string): KatacodeAttempt | null {
    const raw = readJsonFile(this.attemptPath(taskId, attemptId));
    return raw === null ? null : assertAttempt(raw);
  }

  currentForTask(taskId: string): KatacodeAttempt | null {
    const directory = join(this.taskPath(taskId), ATTEMPTS_DIRECTORY);
    if (!existsSync(directory)) return null;
    assertDirectory(directory, 'katacode attempts');
    const attempts = readdirSync(directory)
      .filter((name) => name.endsWith('.json'))
      .map((name) => this.get(taskId, name.replace(/\.json$/, '')))
      .filter((attempt): attempt is KatacodeAttempt => attempt !== null)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return attempts.at(-1) ?? null;
  }

  listForTask(taskId: string): readonly KatacodeAttempt[] {
    const directory = join(this.taskPath(taskId), ATTEMPTS_DIRECTORY);
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .filter((name) => name.endsWith('.json'))
      .map((name) => this.get(taskId, name.replace(/\.json$/, '')))
      .filter((attempt): attempt is KatacodeAttempt => attempt !== null)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getByIdempotencyKey(conversationId: string, key: string): KatacodeAttempt | null {
    const pointer = readJsonFile(this.indexPath(conversationId, key));
    if (!pointer || typeof pointer !== 'object') return null;
    const record = pointer as { taskId?: string; attemptId?: string };
    if (!record.taskId || !record.attemptId) return null;
    return this.get(record.taskId, record.attemptId);
  }

  transition(
    taskId: string,
    attemptId: string,
    expectedFence: string,
    next: KatacodeAttemptState,
    patch: Partial<KatacodeAttempt> = {},
  ): KatacodeAttempt {
    const current = this.require(taskId, attemptId);
    if (current.fence.attemptNonce !== expectedFence) {
      throw new KatacodeAttemptError('stale_fence', `Stale Katacode attempt fence for ${attemptId}`);
    }
    if (!canAdvanceKatacodeAttempt(current.state, next)) {
      throw new KatacodeAttemptError(
        'illegal_transition',
        `Cannot move Katacode attempt ${current.state} → ${next}`,
      );
    }
    const now = this.clock();
    const updated: KatacodeAttempt = {
      ...current,
      ...patch,
      state: next,
      sentAt: next === 'sent' ? now : current.sentAt,
      acknowledgedAt: next === 'acknowledged' ? now : current.acknowledgedAt,
      uncertainAt: next === 'uncertain' ? now : current.uncertainAt,
      reconciledAt: next === 'reconciled' ? now : current.reconciledAt,
      failedAt: next === 'failed' ? now : current.failedAt,
    };
    writeJsonRecord(this.attemptPath(taskId, attemptId), updated);
    return updated;
  }

  createRetryAttempt(input: CreateKatacodeAttemptInput & { readonly priorAttemptId: string }): KatacodeAttempt {
    const prior = this.require(input.taskId, input.priorAttemptId);
    if (prior.state === 'uncertain') {
      throw new KatacodeAttemptError('uncertain_blocks_retry', 'Retry is unavailable while acceptance is uncertain');
    }
    if (prior.state !== 'failed' && prior.state !== 'reconciled') {
      throw new KatacodeAttemptError('illegal_transition', 'Retry requires a terminal prior attempt');
    }
    const retryKey = `${input.clientIdempotencyKey}::retry::${this.randomId()}`;
    return this.createPending({ ...input, clientIdempotencyKey: retryKey });
  }

  private require(taskId: string, attemptId: string): KatacodeAttempt {
    const attempt = this.get(taskId, attemptId);
    if (!attempt) throw new Error(`Katacode attempt not found: ${attemptId}`);
    return attempt;
  }

  private taskPath(taskId: string): string {
    return join(this.rootPath, 'tasks', taskId);
  }

  private attemptPath(taskId: string, attemptId: string): string {
    return join(this.taskPath(taskId), ATTEMPTS_DIRECTORY, `${attemptId}.json`);
  }

  private indexRoot(): string {
    return join(this.rootPath, INDEX_DIRECTORY);
  }

  private indexPath(conversationId: string, key: string): string {
    return join(this.indexRoot(), conversationId, `${hashKey(key)}.json`);
  }
}
