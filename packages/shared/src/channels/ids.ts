import { createHash, randomUUID } from 'node:crypto';

export function reserveChannelId(randomId: () => string = randomUUID): string {
  return `channel_${randomId()}`;
}

export function deriveRouteId(channelId: string, messageEntryId: string): string {
  const digest = createHash('sha256')
    .update(`${channelId}\0${messageEntryId}`, 'utf8')
    .digest('hex');
  return `route_${digest.slice(0, 32)}`;
}

export function stageId(routeId: string, index: number): string {
  return `${routeId}.s${index}`;
}

export function dispatchIdempotencyKey(stage: string): string {
  return `dispatch.${stage}`;
}

