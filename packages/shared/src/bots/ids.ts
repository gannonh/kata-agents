import { createHash, randomUUID } from 'node:crypto';

export interface BotReservedIds {
  readonly intentId: string;
  readonly botId: string;
  readonly directChatId: string;
}

export function reserveBotIds(randomId: () => string = randomUUID): BotReservedIds {
  return {
    intentId: `intent_${randomId()}`,
    botId: `bot_${randomId()}`,
    directChatId: `chat_${randomId()}`,
  };
}

export function idempotencyPointerName(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

