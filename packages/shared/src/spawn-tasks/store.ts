import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  SpawnTask,
  SpawnTaskDispatchState,
  SpawnTaskJsonValue,
} from '@kata-sh/core';
import { getWorkspaceSpawnTasksPath } from '../workspaces/storage.ts';
import { reserveSpawnTaskIds } from './ids.ts';
import { transitionSpawnTask, type SpawnTaskTransition } from './transitions.ts';
import { updateSpawnTaskMetadata, type SpawnTaskMetadataUpdate } from './metadata.ts';
import { assertSpawnTask, assertSpawnTaskId } from './validation.ts';

const CURRENT_FILE = 'CURRENT';
const RECORD_FILE = 'record.json';
const GENERATION_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);

export type SpawnTaskStoreFaultPoint =
  | 'before-record-write'
  | 'after-record-write'
  | 'after-generation-publish'
  | 'before-current-publish';

export interface SpawnTaskStoreOptions {
  readonly workspaceRoot: string;
  readonly workspaceId: string;
  readonly clock?: () => string;
  readonly randomId?: () => string;
  readonly faults?: (point: SpawnTaskStoreFaultPoint, task: SpawnTask) => void;
}

export interface ReserveSpawnTaskInput {
  readonly parentSessionId: string;
  readonly delegatedPrompt: string;
  readonly childConfig: Readonly<Record<string, SpawnTaskJsonValue>>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sameIdentity(left: SpawnTask, right: SpawnTask): boolean {
  return left.taskId === right.taskId
    && left.workspaceId === right.workspaceId
    && left.parentSessionId === right.parentSessionId
    && left.childSessionId === right.childSessionId
    && left.delegatedPrompt === right.delegatedPrompt
    && JSON.stringify(left.childConfig) === JSON.stringify(right.childConfig);
}

export class SpawnTaskStore {
  readonly rootPath: string;
  readonly workspaceId: string;

  private readonly clock: () => string;
  private readonly randomId: () => string;
  private readonly faults?: SpawnTaskStoreOptions['faults'];
  private readonly tasks = new Map<string, SpawnTask>();
  private readonly generations = new Map<string, string>();
  private readonly byParent = new Map<string, Set<string>>();
  private readonly byChild = new Map<string, string>();

  constructor(options: SpawnTaskStoreOptions) {
    assertSpawnTaskId(options.workspaceId, 'workspaceId');
    this.rootPath = getWorkspaceSpawnTasksPath(options.workspaceRoot);
    this.workspaceId = options.workspaceId;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.randomId = options.randomId ?? randomUUID;
    this.faults = options.faults;
    mkdirSync(this.tasksPath(), { recursive: true });
    this.reload();
  }

  reserve(input: ReserveSpawnTaskInput): SpawnTask {
    assertSpawnTaskId(input.parentSessionId, 'parentSessionId');
    const ids = reserveSpawnTaskIds(this.randomId);
    const now = this.clock();
    const task: SpawnTask = {
      schemaVersion: 1,
      version: 1,
      taskId: ids.taskId,
      workspaceId: this.workspaceId,
      parentSessionId: input.parentSessionId,
      childSessionId: ids.childSessionId,
      delegatedPrompt: input.delegatedPrompt,
      childConfig: clone(input.childConfig),
      runtimeState: 'queued',
      stateTimestamps: {
        createdAt: now,
        updatedAt: now,
        queuedAt: now,
      },
      dispatch: {
        state: 'reserved',
        dispatchAttemptId: ids.dispatchAttemptId,
        messageId: ids.messageId,
        reservedAt: now,
      },
    };
    assertSpawnTask(task);
    this.commit(task);
    return clone(task);
  }

  get(taskId: string): SpawnTask | null {
    assertSpawnTaskId(taskId, 'taskId');
    const task = this.tasks.get(taskId);
    return task ? clone(task) : null;
  }

  listAll(): SpawnTask[] {
    return [...this.tasks.values()]
      .sort((left, right) => left.stateTimestamps.createdAt.localeCompare(right.stateTimestamps.createdAt)
        || left.taskId.localeCompare(right.taskId))
      .map(clone);
  }

  listByParentSessionId(parentSessionId: string): SpawnTask[] {
    assertSpawnTaskId(parentSessionId, 'parentSessionId');
    return [...(this.byParent.get(parentSessionId) ?? [])]
      .map((taskId) => this.tasks.get(taskId))
      .filter((task): task is SpawnTask => task !== undefined)
      .sort((left, right) => left.taskId.localeCompare(right.taskId))
      .map(clone);
  }

  getByChildSessionId(childSessionId: string): SpawnTask | null {
    assertSpawnTaskId(childSessionId, 'childSessionId');
    const taskId = this.byChild.get(childSessionId);
    return taskId ? this.get(taskId) : null;
  }

  transition(taskId: string, transition: SpawnTaskTransition): SpawnTask {
    const current = this.require(taskId);
    const next = transitionSpawnTask(current, transition);
    this.commit(next);
    return clone(next);
  }

  updateMetadata(taskId: string, update: SpawnTaskMetadataUpdate): SpawnTask {
    const current = this.require(taskId);
    const next = updateSpawnTaskMetadata(current, update);
    this.commit(next);
    return clone(next);
  }

  updateDispatch(taskId: string, state: SpawnTaskDispatchState, at: string): SpawnTask {
    const current = this.require(taskId);
    if (TERMINAL_STATES.has(current.runtimeState)) {
      throw new Error(`Cannot update dispatch metadata after terminal state ${current.runtimeState}`);
    }
    const order: readonly SpawnTaskDispatchState[] = ['reserved', 'ready', 'claimed', 'sent'];
    if (order.indexOf(state) !== order.indexOf(current.dispatch.state) + 1) {
      throw new Error(`Illegal spawned-task dispatch transition: ${current.dispatch.state} -> ${state}`);
    }
    const timestampField = state === 'ready' ? 'readyAt' : state === 'claimed' ? 'claimedAt' : 'sentAt';
    const next: SpawnTask = {
      ...current,
      version: current.version + 1,
      stateTimestamps: { ...current.stateTimestamps, updatedAt: at },
      dispatch: { ...current.dispatch, state, [timestampField]: at },
    };
    this.commit(next);
    return clone(next);
  }

  reload(): void {
    this.tasks.clear();
    this.generations.clear();
    this.byParent.clear();
    this.byChild.clear();

    for (const entry of readdirSync(this.tasksPath(), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      assertSpawnTaskId(entry.name, 'task directory');
      const taskPath = join(this.tasksPath(), entry.name);
      const currentPath = join(taskPath, CURRENT_FILE);
      if (!existsSync(currentPath)) continue;
      const generation = readFileSync(currentPath, 'utf8').trim();
      if (!GENERATION_SEGMENT.test(generation) || generation === '.' || generation === '..') {
        throw new Error(`Invalid spawned-task generation pointer for ${entry.name}`);
      }
      const recordPath = join(taskPath, 'generations', generation, RECORD_FILE);
      const task = assertSpawnTask(JSON.parse(readFileSync(recordPath, 'utf8')));
      if (task.taskId !== entry.name || task.workspaceId !== this.workspaceId) {
        throw new Error(`Spawned-task ownership mismatch for ${entry.name}`);
      }
      this.index(task, generation);
    }
  }

  private tasksPath(): string {
    return join(this.rootPath, 'tasks');
  }

  private require(taskId: string): SpawnTask {
    assertSpawnTaskId(taskId, 'taskId');
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Spawned task not found: ${taskId}`);
    return task;
  }

  private commit(task: SpawnTask): void {
    assertSpawnTask(task);
    if (task.workspaceId !== this.workspaceId) throw new Error('Spawned-task workspace ownership cannot change');
    const current = this.tasks.get(task.taskId);
    if (current) {
      if (!sameIdentity(current, task)) throw new Error('Spawned-task immutable identity cannot change');
      if (task.version !== current.version + 1) throw new Error('Spawned-task version must increase by exactly one');
    } else if (task.version !== 1) {
      throw new Error('A new spawned task must start at version 1');
    }

    const taskPath = join(this.tasksPath(), task.taskId);
    const generationsPath = join(taskPath, 'generations');
    mkdirSync(generationsPath, { recursive: true });
    const nonce = this.randomId();
    const stageName = `.stage-${nonce}`;
    const stagePath = join(generationsPath, stageName);
    const generation = `g-${String(task.version).padStart(10, '0')}-${nonce}`;
    const generationPath = join(generationsPath, generation);
    const currentTemp = join(taskPath, `.CURRENT-${nonce}.tmp`);

    try {
      this.faults?.('before-record-write', task);
      mkdirSync(stagePath);
      writeFileSync(join(stagePath, RECORD_FILE), `${JSON.stringify(task, null, 2)}\n`, 'utf8');
      this.copyGenerationFiles(current, stagePath);
      this.faults?.('after-record-write', task);
      renameSync(stagePath, generationPath);
      this.faults?.('after-generation-publish', task);
      writeFileSync(currentTemp, `${generation}\n`, 'utf8');
      this.faults?.('before-current-publish', task);
      renameSync(currentTemp, join(taskPath, CURRENT_FILE));
    } catch (error) {
      rmSync(stagePath, { recursive: true, force: true });
      rmSync(currentTemp, { force: true });
      throw error;
    }

    this.index(task, generation);
  }

  private copyGenerationFiles(current: SpawnTask | undefined, stagePath: string): void {
    if (!current) return;
    // Result artifact files are added by the result layer. Record-only updates
    // preserve them by copying every non-record file from the committed generation.
    const generation = this.generations.get(current.taskId);
    if (!generation) return;
    const source = join(this.tasksPath(), current.taskId, 'generations', generation);
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name === RECORD_FILE) continue;
      writeFileSync(join(stagePath, entry.name), readFileSync(join(source, entry.name)));
    }
  }

  private index(task: SpawnTask, generation: string): void {
    const previous = this.tasks.get(task.taskId);
    if (previous && previous.parentSessionId !== task.parentSessionId) {
      this.byParent.get(previous.parentSessionId)?.delete(task.taskId);
    }
    this.tasks.set(task.taskId, clone(task));
    this.generations.set(task.taskId, generation);
    const parentTasks = this.byParent.get(task.parentSessionId) ?? new Set<string>();
    parentTasks.add(task.taskId);
    this.byParent.set(task.parentSessionId, parentTasks);
    this.byChild.set(task.childSessionId, task.taskId);
  }
}
