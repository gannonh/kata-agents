import { join } from 'node:path';
import { getWorkspaceBotsPath } from '../workspaces/storage.ts';
import { idempotencyPointerName } from './ids.ts';

export function botsRootPath(workspaceRoot: string): string {
  return getWorkspaceBotsPath(workspaceRoot);
}

export const botsPath = (root: string): string => join(root, 'bots');
export const intentsPath = (root: string): string => join(root, 'intents');
export const botRecordPath = (root: string, botId: string): string => join(botsPath(root), botId, 'record.json');
export const botProviderSessionPath = (workspaceRoot: string, botId: string): string => join(botsRootPath(workspaceRoot), botId, 'provider-session');
export const chatRecordPath = (root: string, chatId: string): string => join(root, 'chats', chatId, 'record.json');
export const intentRecordPath = (root: string, intentId: string): string => join(intentsPath(root), intentId, 'record.json');
export const idempotencyPointerPath = (root: string, key: string): string => join(root, 'by-idempotency', idempotencyPointerName(key));
export const botChatPointerPath = (root: string, botId: string): string => join(root, 'by-bot-chat', botId);
export const legacySessionPointerPath = (root: string, sessionId: string): string => join(root, 'by-legacy-session', sessionId);
export const dispositionPath = (root: string, sessionId: string): string => join(root, 'dispositions', `${sessionId}.json`);

