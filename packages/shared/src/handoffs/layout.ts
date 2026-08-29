import { join } from 'node:path';

export function getWorkspaceHandoffsPath(workspaceRoot: string): string {
  return join(workspaceRoot, 'handoffs');
}

export const handoffDeliveriesPath = (root: string): string => join(root, 'deliveries');
export const handoffDeliveryVersionsPath = (root: string, deliveryId: string): string =>
  join(handoffDeliveriesPath(root), deliveryId, 'versions');
export const handoffDeliveryVersionPath = (root: string, deliveryId: string, version: number): string =>
  join(handoffDeliveryVersionsPath(root, deliveryId), `${String(version).padStart(12, '0')}.json`);
export const handoffByHandoffPath = (root: string, handoffId: string): string =>
  join(root, 'by-handoff', `${handoffId}.json`);
export const handoffByConversationPath = (root: string, conversationId: string, deliveryId: string): string =>
  join(root, 'by-conversation', conversationId, `${deliveryId}.json`);

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/;

function fail(message: string): never {
  throw new TypeError(`Invalid handoff record: ${message}`);
}

export function assertHandoffPathId(value: unknown, field = 'id'): string {
  if (typeof value !== 'string') fail(`${field} must be a string`);
  if (!SAFE_ID.test(value) || value === '.' || value === '..') fail(`${field} is not an opaque path-safe ID`);
  return value;
}
