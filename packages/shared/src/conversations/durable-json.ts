import { readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ensureDurableDirectory,
  syncDirectory,
  writeDurableFile,
  writeDurableFileIfAbsent,
} from '../spawn-tasks/durable-fs.ts';

export function readJsonFile(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function writeJsonRecord(path: string, value: unknown): void {
  ensureDurableDirectory(dirname(path));
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeDurableFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
  syncDirectory(dirname(path));
}

/** Compare-and-set write. Returns false when the path already exists. */
export function writeJsonIfAbsent(path: string, value: unknown): boolean {
  ensureDurableDirectory(dirname(path));
  const written = writeDurableFileIfAbsent(path, `${JSON.stringify(value, null, 2)}\n`);
  if (written) syncDirectory(dirname(path));
  return written;
}

export function removePointer(path: string): void {
  rmSync(path, { force: true });
  syncDirectory(dirname(path));
}
