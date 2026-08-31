import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  rmSync,
  statSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

const DURABLE_LOCK_STALE_MS = 30_000;

export function writeDurableFile(path: string, content: Buffer | string): void {
  const descriptor = openSync(path, 'w');
  try {
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function writeDurableFileIfAbsent(path: string, content: Buffer | string): boolean {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'wx');
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
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

type DurableLockOwner = { token: string; pid: number; acquiredAt: number }

type ObservedDurableLock = { owner: DurableLockOwner; raw: string; ownerPath: string }

function lockOwnerPath(path: string): string { return join(path, 'owner.json') }
function lockClaimPath(path: string, token: string): string { return `${path}.claim-${token}` }

function readDurableLockOwner(path: string): ObservedDurableLock | null {
  try {
    assertDirectory(path, path)
    const ownerPath = lockOwnerPath(path)
    const raw = readFileSync(ownerPath, 'utf8')
    const owner = JSON.parse(raw) as Partial<DurableLockOwner>
    if (typeof owner.token !== 'string' || !owner.token || typeof owner.pid !== 'number' || !Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.acquiredAt !== 'number' || !Number.isFinite(owner.acquiredAt)) return null
    return { owner: { token: owner.token, pid: owner.pid as number, acquiredAt: owner.acquiredAt as number }, raw, ownerPath }
  } catch {
    return null
  }
}

function processIsAlive(pid: number): boolean | null {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    return null
  }
}

function restoreDurableLock(path: string, movedPath: string): void {
  try { renameSync(movedPath, path) } catch { /* another owner may have replaced the path */ }
}

function breakStaleDurableLock(path: string): boolean {
  const observed = readDurableLockOwner(path)
  let mtimeMs: number
  try { mtimeMs = statSync(path).mtimeMs } catch { return true }
  if (Date.now() - mtimeMs <= DURABLE_LOCK_STALE_MS) return false
  if (observed && processIsAlive(observed.owner.pid) === true) return false
  if (observed) {
    const confirmed = readDurableLockOwner(path)
    if (!confirmed || confirmed.owner.token !== observed.owner.token || confirmed.raw !== observed.raw) return false
  }
  const movedPath = `${path}.reclaim-${randomUUID()}`
  try {
    renameSync(path, movedPath)
    const moved = readDurableLockOwner(movedPath)
    const movedMtimeMs = statSync(movedPath).mtimeMs
    if (movedMtimeMs !== mtimeMs || (observed && (!moved || moved.owner.token !== observed.owner.token || moved.raw !== observed.raw)) || (!observed && moved)) {
      restoreDurableLock(path, movedPath)
      return false
    }
    rmSync(movedPath, { recursive: true, force: true })
    syncDirectory(dirname(path))
    return true
  } catch {
    restoreDurableLock(path, movedPath)
    return false
  }
}

function claimDurableLock(path: string, owner: DurableLockOwner): boolean {
  const claimPath = lockClaimPath(path, owner.token)
  try {
    mkdirSync(claimPath)
    writeDurableFile(join(claimPath, 'owner.json'), JSON.stringify(owner))
    syncDirectory(claimPath)
    try {
      if (existsSync(path)) return false
      renameSync(claimPath, path)
      syncDirectory(dirname(path))
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY' && code !== 'EPERM' && code !== 'EACCES') throw error
      return false
    }
  } finally {
    rmSync(claimPath, { recursive: true, force: true })
  }
}

export function assertDurableLock(path: string, token: string): void {
  const observed = readDurableLockOwner(path)
  if (!observed || observed.owner.token !== token) throw new Error(`Durable lock lost: ${path}`)
}

function releaseDurableLock(path: string, owner: DurableLockOwner): void {
  const observed = readDurableLockOwner(path)
  if (!observed || observed.owner.token !== owner.token) return
  const confirmed = readDurableLockOwner(path)
  if (!confirmed || confirmed.owner.token !== owner.token || confirmed.raw !== observed.raw) return
  const movedPath = `${path}.release-${randomUUID()}`
  try {
    renameSync(path, movedPath)
    const moved = readDurableLockOwner(movedPath)
    if (!moved || moved.owner.token !== owner.token || moved.raw !== observed.raw) {
      restoreDurableLock(path, movedPath)
      return
    }
    rmSync(movedPath, { recursive: true, force: true })
    syncDirectory(dirname(path))
  } catch {
    restoreDurableLock(path, movedPath)
  }
}

function acquireDurableLock(path: string): DurableLockOwner {
  ensureDurableDirectory(dirname(path))
  assertNotSymlink(path, path)
  const owner: DurableLockOwner = { token: `lock_${randomUUID()}`, pid: process.pid, acquiredAt: Date.now() }
  if (!claimDurableLock(path, owner) && (!breakStaleDurableLock(path) || !claimDurableLock(path, owner))) throw new Error(`Durable lock is busy: ${path}`)
  return owner
}

export function withDurableLock<T>(path: string, operation: (token: string) => T): T {
  const owner = acquireDurableLock(path)
  try {
    return operation(owner.token)
  } finally {
    try { releaseDurableLock(path, owner) } catch {
      // A stale owner must not remove a newer lock.
    }
  }
}

export async function withDurableLockAsync<T>(path: string, operation: (token: string) => Promise<T>): Promise<T> {
  const owner = acquireDurableLock(path)
  try {
    return await operation(owner.token)
  } finally {
    try { releaseDurableLock(path, owner) } catch {
      // A stale owner must not remove a newer lock.
    }
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
