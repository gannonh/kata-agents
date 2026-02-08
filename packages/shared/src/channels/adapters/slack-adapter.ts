/**
 * Slack Channel Adapter
 *
 * Polls Slack conversations.history with oldest timestamp tracking,
 * filters bot messages to prevent self-reply loops, and converts
 * Slack messages to ChannelMessage format.
 */

import { WebClient } from '@slack/web-api';
import type { ChannelAdapter, ChannelConfig, ChannelMessage } from '../types.ts';

/** Callbacks for persisting polling state across adapter restarts */
export interface PollingStateFns {
  get: (adapterId: string, channelSourceId: string) => string | null;
  set: (adapterId: string, channelSourceId: string, ts: string) => void;
}

/**
 * Slack channel adapter using conversations.history polling.
 * Requires configure() before start().
 */
export class SlackChannelAdapter implements ChannelAdapter {
  readonly name = 'Slack';
  readonly type = 'poll' as const;

  private _id = '';
  private client: WebClient | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastTimestamps: Map<string, string> = new Map();
  private botUserId: string | null = null;
  private botId: string | null = null;
  private healthy = false;
  private lastErrorMsg: string | null = null;
  private pollingStateFns: PollingStateFns | null = null;

  get id(): string {
    return this._id;
  }

  /**
   * Configure the adapter with a Slack bot token and optional polling state persistence.
   * Must be called before start().
   */
  configure(token: string, pollingState?: PollingStateFns): void {
    this.client = new WebClient(token, { retryConfig: { retries: 3 } });
    this.pollingStateFns = pollingState ?? null;
  }

  async start(config: ChannelConfig, onMessage: (msg: ChannelMessage) => void): Promise<void> {
    if (!this.client) {
      throw new Error('SlackChannelAdapter.configure() must be called before start()');
    }

    this._id = config.slug;

    // Resolve bot identity to filter self-messages
    const authResult = await this.client.auth.test();
    this.botUserId = (authResult.user_id as string) ?? null;
    this.botId = (authResult.bot_id as string) ?? null;

    // Load persisted polling state for each channel
    if (this.pollingStateFns) {
      for (const channelId of config.filter?.channelIds ?? []) {
        const ts = this.pollingStateFns.get(this._id, channelId);
        if (ts) {
          this.lastTimestamps.set(channelId, ts);
        }
      }
    }

    this.healthy = true;

    // Start periodic polling
    const intervalMs = config.pollIntervalMs ?? 10_000;
    this.pollTimer = setInterval(() => this.poll(config, onMessage), intervalMs);

    // Run initial poll immediately
    await this.poll(config, onMessage);
  }

  private async poll(config: ChannelConfig, onMessage: (msg: ChannelMessage) => void): Promise<void> {
    const channelIds = config.filter?.channelIds ?? [];

    for (const channelId of channelIds) {
      try {
        const oldest = this.lastTimestamps.get(channelId);
        const result = await this.client!.conversations.history({
          channel: channelId,
          oldest,
          inclusive: false,
          limit: 100,
        });

        const messages = result.messages ?? [];
        if (messages.length === 0) continue;

        // Track newest timestamp (messages arrive newest-first)
        const newestTs = messages[0]!.ts!;

        // Filter out bot's own messages
        const filtered = messages.filter(
          (msg) => msg.bot_id !== this.botId && msg.user !== this.botUserId,
        );

        // Reverse to process chronologically (oldest first)
        const chronological = [...filtered].reverse();

        for (const msg of chronological) {
          onMessage(this.toChannelMessage(channelId, msg));
        }

        // Update tracking state
        this.lastTimestamps.set(channelId, newestTs);
        if (this.pollingStateFns) {
          this.pollingStateFns.set(this._id, channelId, newestTs);
        }
      } catch (err) {
        this.healthy = false;
        this.lastErrorMsg = err instanceof Error ? err.message : String(err);
      }
    }
  }

  private toChannelMessage(
    slackChannelId: string,
    msg: { ts?: string; user?: string; text?: string; thread_ts?: string; team?: string },
  ): ChannelMessage {
    return {
      id: msg.ts!,
      channelId: this._id,
      source: msg.user ?? 'unknown',
      timestamp: parseFloat(msg.ts!) * 1000,
      content: msg.text ?? '',
      metadata: { slackChannel: slackChannelId, team: msg.team },
      replyTo:
        msg.thread_ts && msg.thread_ts !== msg.ts
          ? {
              threadId: msg.thread_ts,
              messageId: msg.ts!,
            }
          : undefined,
    };
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.client = null;
    this.healthy = false;
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  getLastError(): string | null {
    return this.lastErrorMsg;
  }
}
