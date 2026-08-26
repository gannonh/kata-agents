import { readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getWorkspaceBotsPath } from '../workspaces/storage.ts';
import {
  ensureDurableDirectory,
  syncDirectory,
  writeDurableFile,
  writeDurableFileIfAbsent,
} from '../spawn-tasks/durable-fs.ts';
import { idempotencyPointerName } from './ids.ts';

export function botsRootPath(workspaceRoot: string): string {
  return getWorkspaceBotsPath(workspaceRoot);
}

export const botsPath = (root: string): string => join(root, 'bots');
export const intentsPath = (root: string): string => join(root, 'intents');
export const botRecordPath = (root: string, botId: string): string => join(botsPath(root), botId, 'record.json');
export const chatRecordPath = (root: string, chatId: string): string => join(root, 'chats', chatId, 'record.json');
export const intentRecordPath = (root: string, intentId: string): string => join(intentsPath(root), intentId, 'record.json');
export const idempotencyPointerPath = (root: string, key: string): string => join(root, 'by-idempotency', idempotencyPointerName(key));
export const botChatPointerPath = (root: string, botId: string): string => join(root, 'by-bot-chat', botId);
export const legacySessionPointerPath = (root: string, sessionId: string): string => join(root, 'by-legacy-session', sessionId);
export const dispositionPath = (root: string, sessionId: string): string => join(root, 'dispositions', `${sessionId}.json`);
export const journalEntriesPath = (root: string, chatId: string): string => join(root, 'journals', chatId, 'entries');
export const journalIndexPath = (root: string, chatId: string): string => join(root, 'journals', chatId, 'index.json');
export const journalCursorPath = (root: string, chatId: string): string => join(root, 'journals', chatId, 'cursor.json');
export const journalEntryPath = (root: string, chatId: string, seq: number, entryId: string): string =>
  join(journalEntriesPath(root, chatId), `${String(seq).padStart(12, '0')}-${entryId}.json`);

export function readJsonFile(path: string, _label: string): unknown | null {
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
