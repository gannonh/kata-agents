/**
 * ChannelSessionResolver
 *
 * Deterministic mapping from channel thread identifiers to daemon session keys.
 * Produces collision-resistant session IDs using SHA-256 hashing.
 */
import { createHash } from 'crypto';

export class ChannelSessionResolver {
  /**
   * Derive a stable session key from channel + thread context.
   *
   * Format: daemon-{channelSlug}-{hash12}
   * where hash12 is the first 12 hex characters of SHA-256("{channelSlug}:{workspaceId}:{threadKey}").
   * threadKey is threadId if defined, otherwise channelSourceId.
   */
  static resolveSessionKey(
    channelSlug: string,
    workspaceId: string,
    threadId: string | undefined,
    channelSourceId: string,
  ): string {
    const threadKey = threadId ?? channelSourceId;
    const input = `${channelSlug}:${workspaceId}:${threadKey}`;
    const hash = createHash('sha256').update(input).digest('hex').slice(0, 12);
    return `daemon-${channelSlug}-${hash}`;
  }
}
