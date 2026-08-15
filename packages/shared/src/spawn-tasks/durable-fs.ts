import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export function writeDurableFile(path: string, content: Buffer | string): void {
  const descriptor = openSync(path, 'w');
  try {
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function syncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'r');
    fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EISDIR') throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function assertNotSymlink(path: string, label: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function assertRegularFile(path: string, label: string): void {
  const status = lstatSync(path);
  if (status.isSymbolicLink() || !status.isFile()) throw new Error(`${label} must be a regular file`);
}

export function assertDirectory(path: string, label: string): void {
  const status = lstatSync(path);
  if (status.isSymbolicLink() || !status.isDirectory()) throw new Error(`${label} must be a real directory`);
}

export function isRegularFile(path: string): boolean {
  try {
    const status = lstatSync(path);
    return !status.isSymbolicLink() && status.isFile();
  } catch {
    return false;
  }
}

export function ensureDurableDirectory(path: string): void {
  const existed = existsSync(path);
  assertNotSymlink(path, path);
  mkdirSync(path, { recursive: true });
  assertDirectory(path, path);
  syncDirectory(path);
  if (!existed) syncDirectory(dirname(path));
}
