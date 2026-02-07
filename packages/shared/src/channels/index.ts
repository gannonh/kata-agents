/**
 * Channels Module
 *
 * Public exports for channel adapters and shared channel infrastructure.
 */

export type {
  ChannelAdapter,
  ChannelMessage,
  ChannelFilter,
  ChannelConfig,
} from './types.ts';

export { TriggerMatcher } from './trigger-matcher.ts';
export { ChannelSessionResolver } from './session-resolver.ts';
