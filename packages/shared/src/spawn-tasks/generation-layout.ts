import { lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { assertDirectory, isRegularFile, syncDirectory } from './durable-fs.ts';
import { assertSpawnTask } from './validation.ts';

export const CURRENT_FILE = 'CURRENT';
export const RECORD_FILE = 'record.json';
const GENERATION_NAME = /^g-(\d{10,16})-[A-Za-z0-9][A-Za-z0-9._-]{0,230}$/;

export function assertGenerationName(name: string): void {
  if (!GENERATION_NAME.test(name)) throw new Error(`Invalid spawned-task generation name: ${name}`);
}

function generationVersion(name: string): number | null {
  const match = GENERATION_NAME.exec(name);
  return match ? Number(match[1]) : null;
}

function removeEntry(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function isValidPriorGeneration(taskPath: string, name: string, expectedVersion: number): boolean {
  const generationPath = join(taskPath, 'generations', name);
  const recordPath = join(generationPath, RECORD_FILE);
  try {
    assertDirectory(generationPath, 'prior spawned-task generation');
    if (!isRegularFile(recordPath)) return false;
    const task = assertSpawnTask(JSON.parse(readFileSync(recordPath, 'utf8')));
    return task.version === expectedVersion && task.taskId === basename(taskPath);
  } catch {
    return false;
  }
}

export function removeUnpublishedTask(taskPath: string): void {
  assertDirectory(taskPath, 'unpublished spawned-task directory');
  removeEntry(taskPath);
  syncDirectory(dirname(taskPath));
}

/** Keep CURRENT plus its immediate prior committed generation and remove crash debris. */
export function reconcileTaskGenerations(
  taskPath: string,
  currentGeneration: string,
  priorGeneration?: string,
): void {
  assertDirectory(taskPath, 'spawned-task directory');
  assertGenerationName(currentGeneration);
  const generationsPath = join(taskPath, 'generations');
  assertDirectory(generationsPath, 'spawned-task generations directory');

  for (const entry of readdirSync(taskPath, { withFileTypes: true })) {
    if (entry.name.startsWith('.CURRENT-') && entry.name.endsWith('.tmp')) {
      removeEntry(join(taskPath, entry.name));
    }
  }

  const generationEntries = readdirSync(generationsPath, { withFileTypes: true });
  for (const entry of generationEntries) {
    if (entry.name.startsWith('.stage-')) removeEntry(join(generationsPath, entry.name));
  }

  const currentVersion = generationVersion(currentGeneration)!;
  let prior = priorGeneration;
  if (prior && !isValidPriorGeneration(taskPath, prior, currentVersion - 1)) prior = undefined;
  if (!prior) {
    const candidates = generationEntries
      .filter((entry) => !entry.isSymbolicLink() && entry.isDirectory())
      .filter((entry) => generationVersion(entry.name) === currentVersion - 1)
      .filter((entry) => isValidPriorGeneration(taskPath, entry.name, currentVersion - 1));
    if (candidates.length === 1) prior = candidates[0]!.name;
  }

  for (const entry of readdirSync(generationsPath, { withFileTypes: true })) {
    if (entry.name === currentGeneration) continue;
    if (entry.name === prior && !entry.isSymbolicLink() && entry.isDirectory()) continue;
    removeEntry(join(generationsPath, entry.name));
  }

  const currentPath = join(generationsPath, currentGeneration);
  if (lstatSync(currentPath).isSymbolicLink()) {
    throw new Error('Current spawned-task generation must not be a symbolic link');
  }
}
