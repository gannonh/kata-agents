import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  SPAWN_TASK_DISPATCH_STATES,
  SPAWN_TASK_LIMITS,
  SPAWN_TASK_SCHEMA_VERSION,
  type SpawnTask,
  type SpawnTaskDispatchState,
  type SpawnTaskIntegrityView,
  type SpawnTaskJsonValue,
  type SpawnTaskResultChunkView,
  type SpawnTaskRuntimeState,
} from '@kata-sh/core';
import { getWorkspaceSpawnTasksPath } from '../workspaces/storage.ts';
import { reserveSpawnTaskIds, type SpawnTaskReservedIds } from './ids.ts';
import {
  isSpawnTaskTerminal,
  transitionSpawnTask,
  type SpawnTaskTransition,
} from './transitions.ts';
import {
  requestSpawnTaskCancellation,
  updateSpawnTaskMetadata,
  type SpawnTaskMetadataUpdate,
} from './metadata.ts';
import { assertSpawnTask, assertSpawnTaskId } from './validation.ts';
import { createSpawnTaskFailure } from './failures.ts';
import { finalizeRecoveredSpawnTask } from './recovery.ts';
import {
  assertDirectory,
  assertNotSymlink,
  assertRegularFile,
  ensureDurableDirectory,
  syncDirectory,
} from './durable-fs.ts';
import {
  assertGenerationName,
  CURRENT_FILE,
  RECORD_FILE,
  reconcileTaskGenerations,
  removeUnpublishedTask,
} from './generation-layout.ts';
import {
  publishTaskGeneration,
  readTaskGenerationFile,
  type SpawnTaskStoreFaultPoint,
} from './generation-storage.ts';
export type { SpawnTaskStoreFaultPoint } from './generation-storage.ts';
import {
  buildSpawnTaskResultArtifact,
  createSpawnTaskResultChunk,
  parseVerifiedResult,
  serializeVerifiedResult,
  SPAWN_TASK_RESULT_FILE,
  SPAWN_TASK_VERIFIED_RESULT_FILE,
  SpawnTaskResultTooLargeError,
  verifySpawnTaskResult,
  type BuildSpawnTaskResultOptions,
} from './result-artifact.ts';

const MAX_RESERVATION_ATTEMPTS = 16;

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

export interface SpawnTaskStartupChange {
  readonly taskId: string;
  readonly version: number;
}

export interface SpawnTaskFinalizedStartupChange extends SpawnTaskStartupChange {
  readonly previousRuntimeState: SpawnTaskRuntimeState;
}

export interface SpawnTaskStartupReport {
  readonly finalized: readonly SpawnTaskFinalizedStartupChange[];
  readonly integrityMarked: readonly SpawnTaskStartupChange[];
}

interface CommitOptions {
  readonly artifactFiles?: ReadonlyMap<string, Buffer | string>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function emptyStartupReport(): SpawnTaskStartupReport {
  return { finalized: [], integrityMarked: [] };
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

  private readonly workspaceRoot: string;
  private readonly clock: () => string;
  private readonly randomId: () => string;
  private readonly faults?: SpawnTaskStoreOptions['faults'];
  private readonly tasks = new Map<string, SpawnTask>();
  private readonly generations = new Map<string, string>();
  private readonly byParent = new Map<string, Set<string>>();
  private readonly byChild = new Map<string, string>();
  private readonly byMessage = new Map<string, string>();
  private readonly byDispatchAttempt = new Map<string, string>();
  private readonly loadErrors = new Map<string, string>();
  private lastStartupReport: SpawnTaskStartupReport = emptyStartupReport();

  constructor(options: SpawnTaskStoreOptions) {
    assertSpawnTaskId(options.workspaceId, 'workspaceId');
    this.workspaceRoot = options.workspaceRoot;
    this.rootPath = getWorkspaceSpawnTasksPath(options.workspaceRoot);
    this.workspaceId = options.workspaceId;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.randomId = options.randomId ?? randomUUID;
    this.faults = options.faults;
    ensureDurableDirectory(this.rootPath);
    ensureDurableDirectory(this.tasksPath());
    this.reload();
  }

  reserve(input: ReserveSpawnTaskInput): SpawnTask {
    assertSpawnTaskId(input.parentSessionId, 'parentSessionId');

    for (let attempt = 0; attempt < MAX_RESERVATION_ATTEMPTS; attempt += 1) {
      const ids = reserveSpawnTaskIds(this.randomId);
      if (!this.reservedIdsAvailable(ids)) continue;

      const now = this.clock();
      const task: SpawnTask = {
        schemaVersion: SPAWN_TASK_SCHEMA_VERSION,
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

    throw new Error(`Unable to reserve unique spawned-task IDs after ${MAX_RESERVATION_ATTEMPTS} attempts`);
  }

  get(taskId: string): SpawnTask | null {
    assertSpawnTaskId(taskId, 'taskId');
    const task = this.tasks.get(taskId);
    return task ? clone(task) : null;
  }

  getLoadErrors(): Readonly<Record<string, string>> {
    return Object.freeze(Object.fromEntries(this.loadErrors));
  }

  getLastStartupReport(): SpawnTaskStartupReport {
    return clone(this.lastStartupReport);
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
    if (transition.runtimeState === 'completed') {
      throw new Error('Use commitResult to atomically publish a completed spawned-task result');
    }
    const current = this.require(taskId);
    const next = transitionSpawnTask(current, transition);
    this.commit(next);
    return clone(next);
  }

  updateMetadata(taskId: string, update: SpawnTaskMetadataUpdate): SpawnTask {
    if (update.integrityError !== undefined) {
      throw new Error('Integrity metadata is store-owned; use repairResult to clear it');
    }
    const current = this.require(taskId);
    const next = updateSpawnTaskMetadata(current, update);
    this.commit(next);
    return clone(next);
  }

  requestCancellation(taskId: string, requestedAt: string, reason: string): SpawnTask {
    const current = this.require(taskId);
    const next = requestSpawnTaskCancellation(current, requestedAt, reason);
    if (next === current) return clone(current);
    this.commit(next);
    return clone(next);
  }

  commitResult(taskId: string, content: string, options: BuildSpawnTaskResultOptions): SpawnTask {
    const current = this.require(taskId);
    if (current.runtimeState !== 'processing') {
      throw new Error(`Cannot commit a result from spawned-task state ${current.runtimeState}`);
    }

    let artifact;
    try {
      artifact = buildSpawnTaskResultArtifact(content, options);
    } catch (error) {
      if (!(error instanceof SpawnTaskResultTooLargeError)) throw error;
      const byteLength = Buffer.byteLength(content, 'utf8');
      const failure = createSpawnTaskFailure({
        code: 'result_too_large',
        message: `Spawned-task result exceeds the ${SPAWN_TASK_LIMITS.resultBytes} byte limit.`,
        retryable: false,
        details: {
          byteLength,
          maxByteLength: SPAWN_TASK_LIMITS.resultBytes,
          ...(options.sourceMessageId ? { sourceMessageId: options.sourceMessageId } : {}),
        },
        committedAt: options.committedAt,
      });
      return this.transition(taskId, {
        runtimeState: 'failed',
        at: options.committedAt,
        failure,
      });
    }

    // Publish a verified artifact with the nonterminal record first. If the
    // process stops before terminal publication, startup can finalize it once.
    const artifactCommitted: SpawnTask = {
      ...current,
      version: current.version + 1,
      stateTimestamps: {
        ...current.stateTimestamps,
        updatedAt: options.committedAt,
      },
    };
    const files = new Map<string, Buffer | string>([
      [SPAWN_TASK_RESULT_FILE, artifact.bytes],
      [SPAWN_TASK_VERIFIED_RESULT_FILE, serializeVerifiedResult(artifact.result)],
    ]);
    this.commit(artifactCommitted, { artifactFiles: files });

    const completed = transitionSpawnTask(artifactCommitted, {
      runtimeState: 'completed',
      at: options.committedAt,
      result: artifact.result,
    });
    this.commit(completed);
    return clone(completed);
  }

  readResultChunk(
    taskId: string,
    offset: number,
    limit: number,
  ): SpawnTaskResultChunkView | SpawnTaskIntegrityView {
    let current = this.require(taskId);
    if (current.runtimeState !== 'completed' || !current.result) {
      throw new Error(`Spawned task ${taskId} has no completed result`);
    }
    const verified = this.readVerifiedArtifact(current);
    if (!verified) {
      current = this.markIntegrityError(current, 'Spawned-task result artifact is missing or does not match its digest.');
      return {
        taskId: current.taskId,
        runtimeState: 'completed',
        result: current.result!,
        integrityError: current.integrityError!,
      };
    }
    if (current.integrityError) {
      return {
        taskId: current.taskId,
        runtimeState: 'completed',
        result: current.result,
        integrityError: current.integrityError,
      };
    }
    return createSpawnTaskResultChunk(taskId, verified, current.result, offset, limit);
  }

  markResultRead(taskId: string, at: string): SpawnTask {
    return this.updateMetadata(taskId, { at, resultReadAt: at });
  }

  markParentDeleted(taskId: string, at: string): SpawnTask {
    return this.updateMetadata(taskId, { at, parentDeletedAt: at });
  }

  markChildDeleted(taskId: string, at: string): SpawnTask {
    return this.updateMetadata(taskId, { at, childDeletedAt: at });
  }

  repairResult(taskId: string, content: string, at: string): SpawnTask {
    const current = this.require(taskId);
    if (current.runtimeState !== 'completed' || !current.result || !current.integrityError) {
      throw new Error('Spawned-task result repair requires a completed task with an integrity error');
    }
    const bytes = Buffer.from(content, 'utf8');
    if (!verifySpawnTaskResult(bytes, current.result)) {
      throw new Error('Replacement artifact does not match the committed result digest and length');
    }
    const repaired = updateSpawnTaskMetadata(current, { at, integrityError: null });
    this.commit(repaired, {
      artifactFiles: new Map<string, Buffer | string>([
        [SPAWN_TASK_RESULT_FILE, bytes],
        [SPAWN_TASK_VERIFIED_RESULT_FILE, serializeVerifiedResult(current.result)],
      ]),
    });
    return clone(repaired);
  }

  purgeWorkspace(): void {
    rmSync(this.rootPath, { recursive: true, force: true });
    syncDirectory(this.workspaceRoot);
    ensureDurableDirectory(this.rootPath);
    ensureDurableDirectory(this.tasksPath());
    this.tasks.clear();
    this.generations.clear();
    this.byParent.clear();
    this.byChild.clear();
    this.byMessage.clear();
    this.byDispatchAttempt.clear();
    this.loadErrors.clear();
    this.lastStartupReport = emptyStartupReport();
  }

  validateArtifactsOnStartup(): SpawnTaskStartupReport {
    const finalized: SpawnTaskFinalizedStartupChange[] = [];
    const integrityMarked: SpawnTaskStartupChange[] = [];
    for (const snapshot of [...this.tasks.values()]) {
      try {
        if (snapshot.runtimeState === 'completed' && snapshot.result) {
          if (!this.readVerifiedArtifact(snapshot) && !snapshot.integrityError) {
            const marked = this.markIntegrityError(
              snapshot,
              'Spawned-task result artifact is missing or does not match its digest.',
            );
            integrityMarked.push({ taskId: marked.taskId, version: marked.version });
          }
          continue;
        }

        if (isSpawnTaskTerminal(snapshot.runtimeState)) continue;
        const pending = this.readVerifiedManifest(snapshot);
        if (!pending) continue;
        const bytes = this.readCurrentFile(snapshot.taskId, SPAWN_TASK_RESULT_FILE);
        if (!bytes || !verifySpawnTaskResult(bytes, pending)) continue;
        const completed = finalizeRecoveredSpawnTask(snapshot, pending);
        this.commit(completed);
        finalized.push({
          taskId: completed.taskId,
          previousRuntimeState: snapshot.runtimeState,
          version: completed.version,
        });
      } catch (error) {
        this.loadErrors.set(snapshot.taskId, error instanceof Error ? error.message : String(error));
      }
    }
    const report: SpawnTaskStartupReport = { finalized, integrityMarked };
    this.lastStartupReport = clone(report);
    return clone(report);
  }

  updateDispatch(taskId: string, state: SpawnTaskDispatchState, at: string): SpawnTask {
    const current = this.require(taskId);
    if (isSpawnTaskTerminal(current.runtimeState)) {
      throw new Error(`Cannot update dispatch metadata after terminal state ${current.runtimeState}`);
    }
    const order: readonly SpawnTaskDispatchState[] = SPAWN_TASK_DISPATCH_STATES;
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

  reload(): SpawnTaskStartupReport {
    this.tasks.clear();
    this.generations.clear();
    this.byParent.clear();
    this.byChild.clear();
    this.byMessage.clear();
    this.byDispatchAttempt.clear();
    this.loadErrors.clear();

    for (const entry of readdirSync(this.tasksPath(), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) {
        this.loadErrors.set(entry.name, 'Spawned-task directory must not be a symbolic link');
        continue;
      }
      if (!entry.isDirectory()) continue;
      try {
        assertSpawnTaskId(entry.name, 'task directory');
        const taskPath = join(this.tasksPath(), entry.name);
        assertDirectory(taskPath, 'spawned-task directory');
        const currentPath = join(taskPath, CURRENT_FILE);
        assertNotSymlink(currentPath, 'spawned-task CURRENT');
        if (!existsSync(currentPath)) {
          removeUnpublishedTask(taskPath);
          continue;
        }
        assertRegularFile(currentPath, 'spawned-task CURRENT');
        const generation = readFileSync(currentPath, 'utf8').trim();
        assertGenerationName(generation);
        const generationsPath = join(taskPath, 'generations');
        assertDirectory(generationsPath, 'spawned-task generations directory');
        const generationPath = join(generationsPath, generation);
        assertDirectory(generationPath, 'current spawned-task generation');
        reconcileTaskGenerations(taskPath, generation);
        const recordPath = join(generationPath, RECORD_FILE);
        assertRegularFile(recordPath, 'spawned-task record');
        const task = assertSpawnTask(JSON.parse(readFileSync(recordPath, 'utf8')));
        if (task.taskId !== entry.name || task.workspaceId !== this.workspaceId) {
          throw new Error(`Spawned-task ownership mismatch for ${entry.name}`);
        }
        this.index(task, generation);
      } catch (error) {
        this.loadErrors.set(entry.name, error instanceof Error ? error.message : String(error));
      }
    }

    return this.validateArtifactsOnStartup();
  }

  private reservedIdsAvailable(ids: SpawnTaskReservedIds): boolean {
    assertSpawnTaskId(ids.taskId, 'taskId');
    assertSpawnTaskId(ids.childSessionId, 'childSessionId');
    assertSpawnTaskId(ids.messageId, 'dispatch.messageId');
    assertSpawnTaskId(ids.dispatchAttemptId, 'dispatch.dispatchAttemptId');
    const taskPath = join(this.tasksPath(), ids.taskId);
    assertNotSymlink(taskPath, 'spawned-task reservation path');
    return !this.tasks.has(ids.taskId)
      && !existsSync(taskPath)
      && !this.byChild.has(ids.childSessionId)
      && !this.byMessage.has(ids.messageId)
      && !this.byDispatchAttempt.has(ids.dispatchAttemptId);
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

  /**
   * SessionManager is the sole task writer and mutations are synchronous, so
   * calls cannot interleave in-process. CURRENT comparison rejects stale store
   * instances; cross-process multi-writer locking is intentionally out of scope.
   */
  private commit(task: SpawnTask, options: CommitOptions = {}): void {
    assertSpawnTask(task);
    if (task.workspaceId !== this.workspaceId) throw new Error('Spawned-task workspace ownership cannot change');
    const current = this.tasks.get(task.taskId);
    if (current) {
      if (!sameIdentity(current, task)) throw new Error('Spawned-task immutable identity cannot change');
      if (task.version !== current.version + 1) throw new Error('Spawned-task version must increase by exactly one');
    } else if (task.version !== 1) {
      throw new Error('A new spawned task must start at version 1');
    }

    const published = publishTaskGeneration({
      tasksPath: this.tasksPath(),
      task,
      currentTask: current,
      indexedGeneration: this.generations.get(task.taskId),
      randomId: this.randomId,
      faults: this.faults,
      artifactFiles: options.artifactFiles,
    });
    this.index(task, published.generation);
    const warnings = [published.postCommitWarning, published.reconciliationError].filter(Boolean);
    if (warnings.length > 0) this.loadErrors.set(task.taskId, warnings.join('; '));
  }

  private readCurrentFile(taskId: string, name: string): Buffer | null {
    const generation = this.generations.get(taskId);
    return generation
      ? readTaskGenerationFile(this.tasksPath(), taskId, generation, name)
      : null;
  }

  private readVerifiedManifest(task: SpawnTask) {
    const manifest = this.readCurrentFile(task.taskId, SPAWN_TASK_VERIFIED_RESULT_FILE);
    if (!manifest) return null;
    try {
      return parseVerifiedResult(manifest.toString('utf8'));
    } catch {
      return null;
    }
  }

  private readVerifiedArtifact(task: SpawnTask): Buffer | null {
    if (!task.result) return null;
    const bytes = this.readCurrentFile(task.taskId, SPAWN_TASK_RESULT_FILE);
    return bytes && verifySpawnTaskResult(bytes, task.result) ? bytes : null;
  }

  private markIntegrityError(task: SpawnTask, message: string): SpawnTask {
    if (task.integrityError) return task;
    const detectedAt = this.clock();
    const next = updateSpawnTaskMetadata(task, {
      at: detectedAt,
      integrityError: {
        code: 'result_persist_failed',
        message,
        detectedAt,
      },
    });
    this.commit(next);
    return next;
  }

  private index(task: SpawnTask, generation: string): void {
    const uniqueIndexes: ReadonlyArray<readonly [string, Map<string, string>, string]> = [
      ['childSessionId', this.byChild, task.childSessionId],
      ['messageId', this.byMessage, task.dispatch.messageId],
      ['dispatchAttemptId', this.byDispatchAttempt, task.dispatch.dispatchAttemptId],
    ];
    for (const [field, index, value] of uniqueIndexes) {
      const owner = index.get(value);
      if (owner && owner !== task.taskId) {
        throw new Error(`Duplicate spawned-task ${field}: ${value}`);
      }
    }

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
    this.byMessage.set(task.dispatch.messageId, task.taskId);
    this.byDispatchAttempt.set(task.dispatch.dispatchAttemptId, task.taskId);
  }
}
