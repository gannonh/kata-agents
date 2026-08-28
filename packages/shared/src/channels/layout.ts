import { join } from 'node:path';

export function channelsRootPath(workspaceRoot: string): string {
  return join(workspaceRoot, 'channels');
}

export const channelsPath = (root: string): string => join(root, 'channels');
export const channelPath = (root: string, channelId: string): string => join(channelsPath(root), channelId);
export const channelRecordPath = (root: string, channelId: string): string => join(channelPath(root, channelId), 'record.json');
export const channelRoutesPath = (root: string, channelId: string): string => join(channelPath(root, channelId), 'routes');
export const channelRoutePath = (root: string, channelId: string, routeId: string): string => join(channelRoutesPath(root, channelId), `${routeId}.json`);
export const channelMemberPath = (root: string, channelId: string, botId: string): string => join(channelPath(root, channelId), 'members', botId);
export const channelProviderSessionPath = (root: string, channelId: string, botId: string): string => join(channelMemberPath(root, channelId, botId), 'provider-session');
export const channelIdempotencyPath = (root: string, keyHash: string): string => join(root, 'by-idempotency', keyHash);

