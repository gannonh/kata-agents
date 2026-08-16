import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import type { SpawnTask } from '@kata-sh/core';
import {
  assertDirectory,
  assertNotSymlink,
  assertRegularFile,
  isRegularFile,
  syncDirectory,
  writeDurableFile,
} from './durable-fs.ts';
import {
  assertGenerationName,
  CURRENT_FILE,
  RECORD_FILE,
  reconcileTaskGenerations,
  removeUnpublishedTask,
} from './generation-layout.ts';
import {
  SPAWN_TASK_RESULT_FILE,
  SPAWN_TASK_VERIFIED_RESULT_FILE,
} from './result-artifact.ts';
import { assertSpawnTaskId } from './validation.ts';

export type SpawnTaskStoreFaultPoint =
  | 'before-record-write'
  | 'after-record-write'
  | 'before-artifact-write'
  | 'after-artifact-write'
  | 'after-generation-publish'
  | 'before-current-publish'
  | 'after-current-publish'
  | 'before-current-rollback';

export interface PublishTaskGenerationInput {
  readonly tasksPath: string;
  readonly task: SpawnTask;
  readonly currentTask?: SpawnTask;
  readonly indexedGeneration?: string;
  readonly randomId: () => string;
  readonly faults?: (point: SpawnTaskStoreFaultPoint, task: SpawnTask) => void;
  readonly artifactFiles?: ReadonlyMap<string, Buffer | string>;
}

export interface PublishTaskGenerationResult {
  readonly generation: string;
  readonly reconciliationError?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const PUBLICATION_LOCK_DIRECTORY = '.publish-lock';

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquirePublicationLock(tasksPath: string): string {
  const lockPath = join(tasksPath, PUBLICATION_LOCK_DIRECTORY);
  const ownerPath = join(lockPath, 'owner');
  try {
    mkdirSync(lockPath);
    writeDurableFile(ownerPath, `${process.pid}\n`);
    return lockPath;
  } catch (error) {
    if (!existsSync(lockPath)) throw error;
    let ownerPid: number | undefined;
    try {
      const parsed = Number.parseInt(readFileSync(ownerPath, 'utf8').trim(), 10);
      if (Number.isSafeInteger(parsed) && parsed > 0) ownerPid = parsed;
    } catch {
      // A crashed writer may have created the directory before its owner file.
    }
    if (ownerPid !== undefined && isProcessAlive(ownerPid)) {
      throw new Error('Spawned-task store publication is locked by another writer');
    }
    rmSync(lockPath, { recursive: true, force: true });
    mkdirSync(lockPath);
    writeDurableFile(ownerPath, `${process.pid}\n`);
    return lockPath;
  }
}

function releasePublicationLock(lockPath: string): void {
  rmSync(lockPath, { recursive: true, force: true });
  syncDirectory(join(lockPath, '..'));
}

function rollbackPublishedCurrent(
  input: PublishTaskGenerationInput,
  taskPath: string,
  currentPath: string,
  currentTemp: string,
  priorGeneration: string | undefined,
): void {
  input.faults?.('before-current-rollback', input.task);
  if (!priorGeneration) {
    removeUnpublishedTask(taskPath);
    return;
  }

  writeDurableFile(currentTemp, `${priorGeneration}\n`);
  renameSync(currentTemp, currentPath);
  syncDirectory(taskPath);
}

function uncertainDurabilityError(publicationError: unknown, rollbackError: unknown): AggregateError {
  return new AggregateError(
    [publicationError, rollbackError],
    `Spawned-task durability is uncertain: ${errorMessage(publicationError)}; rollback failed: ${errorMessage(rollbackError)}`,
  );
}

function copyGenerationFiles(
  tasksPath: string,
  current: SpawnTask | undefined,
  currentGeneration: string | undefined,
  stagePath: string,
): void {
  if (!current || !currentGeneration) return;
  const source = join(tasksPath, current.taskId, 'generations', currentGeneration);
  assertDirectory(source, 'current spawned-task generation');
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (
      entry.isSymbolicLink()
      || !entry.isFile()
      || (entry.name !== SPAWN_TASK_RESULT_FILE && entry.name !== SPAWN_TASK_VERIFIED_RESULT_FILE)
    ) continue;
    const sourceFile = join(source, entry.name);
    assertRegularFile(sourceFile, `spawned-task artifact ${entry.name}`);
    writeDurableFile(join(stagePath, entry.name), readFileSync(sourceFile));
  }
}

function publishTaskGenerationLocked(input: PublishTaskGenerationInput): PublishTaskGenerationResult {
  const { task, currentTask, indexedGeneration, tasksPath } = input;
  const taskPath = join(tasksPath, task.taskId);
  const currentPath = join(taskPath, CURRENT_FILE);
  assertNotSymlink(taskPath, 'spawned-task directory');
  assertNotSymlink(currentPath, 'spawned-task CURRENT');
  if (existsSync(currentPath)) assertRegularFile(currentPath, 'spawned-task CURRENT');
  const diskGeneration = existsSync(currentPath) ? readFileSync(currentPath, 'utf8').trim() : undefined;
  if (diskGeneration !== indexedGeneration) {
    throw new Error(`Cannot replace spawned task ${task.taskId} from a stale store view`);
  }

  const generationsPath = join(taskPath, 'generations');
  assertNotSymlink(generationsPath, 'spawned-task generations directory');
  const nonce = assertSpawnTaskId(input.randomId(), 'generation nonce');
  const stagePath = join(generationsPath, `.stage-${nonce}`);
  const generation = `g-${String(task.version).padStart(10, '0')}-${nonce}`;
  assertGenerationName(generation);
  const generationPath = join(generationsPath, generation);
  const currentTemp = join(taskPath, `.CURRENT-${nonce}.tmp`);
  assertNotSymlink(stagePath, 'spawned-task staging path');
  assertNotSymlink(generationPath, 'spawned-task generation path');
  assertNotSymlink(currentTemp, 'spawned-task CURRENT staging path');

  // Recursive creation is safe after every existing segment was checked above.
  mkdirSync(generationsPath, { recursive: true });
  assertDirectory(taskPath, 'spawned-task directory');
  assertDirectory(generationsPath, 'spawned-task generations directory');

  try {
    input.faults?.('before-record-write', task);
    mkdirSync(stagePath);
    writeDurableFile(join(stagePath, RECORD_FILE), `${JSON.stringify(task, null, 2)}\n`);
    copyGenerationFiles(tasksPath, currentTask, indexedGeneration, stagePath);
    input.faults?.('after-record-write', task);
    if (input.artifactFiles) {
      input.faults?.('before-artifact-write', task);
      for (const [name, content] of input.artifactFiles) {
        if (name !== SPAWN_TASK_RESULT_FILE && name !== SPAWN_TASK_VERIFIED_RESULT_FILE) {
          throw new Error(`Unsupported spawned-task artifact file: ${name}`);
        }
        writeDurableFile(join(stagePath, name), content);
      }
      input.faults?.('after-artifact-write', task);
    }
    syncDirectory(stagePath);
    renameSync(stagePath, generationPath);
    syncDirectory(generationsPath);
    input.faults?.('after-generation-publish', task);
    writeDurableFile(currentTemp, `${generation}\n`);
    input.faults?.('before-current-publish', task);
    renameSync(currentTemp, currentPath);
  } catch (error) {
    rmSync(stagePath, { recursive: true, force: true });
    rmSync(currentTemp, { force: true });
    throw error;
  }

  try {
    input.faults?.('after-current-publish', task);
    syncDirectory(taskPath);
    if (!currentTask) syncDirectory(tasksPath);
  } catch (publicationError) {
    try {
      rollbackPublishedCurrent(input, taskPath, currentPath, currentTemp, diskGeneration);
    } catch (rollbackError) {
      throw uncertainDurabilityError(publicationError, rollbackError);
    }
    throw publicationError;
  }

  try {
    reconcileTaskGenerations(taskPath, generation, diskGeneration);
    return { generation };
  } catch (error) {
    return {
      generation,
      reconciliationError: errorMessage(error),
    };
  }
}

export function publishTaskGeneration(input: PublishTaskGenerationInput): PublishTaskGenerationResult {
  const lockPath = acquirePublicationLock(input.tasksPath);
  try {
    return publishTaskGenerationLocked(input);
  } finally {
    releasePublicationLock(lockPath);
  }
}

export function readTaskGenerationFile(
  tasksPath: string,
  taskId: string,
  generation: string,
  name: string,
): Buffer | null {
  const generationPath = join(tasksPath, taskId, 'generations', generation);
  const filePath = join(generationPath, name);
  try {
    assertDirectory(generationPath, 'current spawned-task generation');
    return isRegularFile(filePath) ? readFileSync(filePath) : null;
  } catch {
    return null;
  }
}
