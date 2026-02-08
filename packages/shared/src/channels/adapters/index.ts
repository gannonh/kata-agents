/**
 * Channel Adapter Registry
 *
 * Factory function for creating adapter instances by type identifier.
 */

import type { ChannelAdapter } from '../types.ts';
import { SlackChannelAdapter } from './slack-adapter.ts';

export { SlackChannelAdapter } from './slack-adapter.ts';
export type { PollingStateFns } from './slack-adapter.ts';

/**
 * Create a new adapter instance for the given type.
 * Returns null for unknown adapter types.
 */
export function createAdapter(type: string): ChannelAdapter | null {
  switch (type) {
    case 'slack':
      return new SlackChannelAdapter();
    default:
      return null;
  }
}
