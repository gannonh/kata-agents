import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { assertDirectory } from './durable-fs.ts';

export const CURRENT_FILE = 'CURRENT';
export const RECORD_FILE = 'record.json';
export const GENERATION_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const GENERATION_NAME = /^g-(\d{10})-[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

function generationVersion(name: string): number | null {
  const match = GENERATION_NAME.exec(name);
  return match ? Number(match[1]) : null;
}

function removeEntry(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

/** Keep CURRENT plus its immediate prior committed generation and remove crash debris. */
export function reconcileTaskGenerations(
  taskPath: string,
  currentGeneration: string,
  priorGeneration?: string,
): void {
  assertDirectory(taskPath, 'spawned-task directory');
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

  let prior = priorGeneration;
  if (!prior) {
    const currentVersion = generationVersion(currentGeneration);
    if (currentVersion !== null) {
      prior = generationEntries
        .filter((entry) => !entry.isSymbolicLink() && entry.isDirectory())
        .map((entry) => ({ name: entry.name, version: generationVersion(entry.name) }))
        .filter((entry): entry is { name: string; version: number } => entry.version !== null && entry.version < currentVersion)
        .sort((left, right) => right.version - left.version)[0]?.name;
    }
  }

  for (const entry of readdirSync(generationsPath, { withFileTypes: true })) {
    if (entry.name.startsWith('.stage-')) continue;
    if (entry.name === currentGeneration || entry.name === prior) continue;
    if (entry.isSymbolicLink() || generationVersion(entry.name) !== null) {
      removeEntry(join(generationsPath, entry.name));
    }
  }

  const currentPath = join(generationsPath, currentGeneration);
  if (lstatSync(currentPath).isSymbolicLink()) {
    throw new Error('Current spawned-task generation must not be a symbolic link');
  }
}
