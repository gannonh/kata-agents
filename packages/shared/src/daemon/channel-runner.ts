/**
 * Channel Runner
 *
 * Orchestrates the lifecycle of channel adapters within the daemon process.
 * Creates adapters from config, applies trigger filtering, resolves session keys,
 * and enqueues inbound messages into the MessageQueue.
 */

import type { ChannelAdapter, ChannelConfig, ChannelMessage } from '../channels/types.ts';
import { TriggerMatcher } from '../channels/trigger-matcher.ts';
import { ChannelSessionResolver } from '../channels/session-resolver.ts';
import { createAdapter as defaultCreateAdapter } from '../channels/adapters/index.ts';
import type { SlackChannelAdapter } from '../channels/adapters/slack-adapter.ts';
import type { MessageQueue } from './message-queue.ts';
import type { DaemonEvent } from './types.ts';

/** Factory function that creates an adapter instance for a given type identifier */
export type AdapterFactory = (type: string) => ChannelAdapter | null;

interface WorkspaceChannelConfig {
  workspaceId: string;
  configs: ChannelConfig[];
  tokens: Map<string, string>;
}

interface RunningAdapter {
  adapter: ChannelAdapter;
  workspaceId: string;
  config: ChannelConfig;
}

/**
 * Manages the lifecycle of channel adapters within the daemon process.
 * Handles adapter creation, trigger filtering, session resolution, and message enqueuing.
 */
export class ChannelRunner {
  private adapters: Map<string, RunningAdapter> = new Map();
  private triggerMatchers: Map<string, TriggerMatcher> = new Map();
  private adapterFactory: AdapterFactory;

  constructor(
    private queue: MessageQueue,
    private emit: (event: DaemonEvent) => void,
    private workspaceConfigs: Map<string, WorkspaceChannelConfig>,
    private log: (msg: string) => void = () => {},
    adapterFactory?: AdapterFactory,
  ) {
    this.adapterFactory = adapterFactory ?? defaultCreateAdapter;
  }

  async startAll(): Promise<void> {
    let startedCount = 0;

    for (const [, wsConfig] of this.workspaceConfigs) {
      for (const config of wsConfig.configs) {
        if (!config.enabled) continue;

        const adapter = this.adapterFactory(config.adapter);
        if (!adapter) {
          this.emit({
            type: 'plugin_error',
            pluginId: config.adapter,
            error: `Unknown adapter type: ${config.adapter}`,
          });
          continue;
        }

        // Configure adapter if it supports the configure method (duck-type check)
        if ('configure' in adapter && typeof (adapter as SlackChannelAdapter).configure === 'function') {
          const token = wsConfig.tokens.get(config.credentials.sourceSlug);
          if (!token) {
            this.emit({
              type: 'plugin_error',
              pluginId: config.slug,
              error: `No token found for source: ${config.credentials.sourceSlug}`,
            });
            continue;
          }
          (adapter as SlackChannelAdapter).configure(token, {
            get: (aid, cid) => this.queue.getPollingState(aid, cid),
            set: (aid, cid, ts) => this.queue.setPollingState(aid, cid, ts),
          });
        }

        // Create trigger matcher for this adapter
        const matcher = new TriggerMatcher(config.filter?.triggerPatterns ?? []);
        this.triggerMatchers.set(config.slug, matcher);

        try {
          await adapter.start(config, (msg) =>
            this.handleMessage(config.slug, wsConfig.workspaceId, msg),
          );
          this.adapters.set(config.slug, {
            adapter,
            workspaceId: wsConfig.workspaceId,
            config,
          });
          startedCount++;
          this.log(`Started adapter: ${config.slug} (${config.adapter})`);
        } catch (err) {
          this.emit({
            type: 'plugin_error',
            pluginId: config.slug,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    this.log(`Started ${startedCount} adapter(s)`);
  }

  private handleMessage(slug: string, workspaceId: string, msg: ChannelMessage): void {
    // Check trigger filter
    const matcher = this.triggerMatchers.get(slug);
    if (matcher && !matcher.matches(msg.content)) {
      this.log(`Message ${msg.id} skipped by trigger filter for ${slug}`);
      return;
    }

    // Resolve session key
    const channelSourceId = (msg.metadata.slackChannel as string) ?? msg.channelId;
    const sessionKey = ChannelSessionResolver.resolveSessionKey(
      slug,
      workspaceId,
      msg.replyTo?.threadId,
      channelSourceId,
    );
    msg.metadata.sessionKey = sessionKey;

    // Enqueue the message
    this.queue.enqueue('inbound', slug, msg);

    // Emit event
    this.emit({ type: 'message_received', channelId: slug, messageId: msg.id });
  }

  async stopAll(): Promise<void> {
    for (const [slug, { adapter }] of this.adapters) {
      try {
        await adapter.stop();
        this.log(`Stopped adapter: ${slug}`);
      } catch (err) {
        this.log(`Error stopping adapter ${slug}: ${err}`);
      }
    }
    this.adapters.clear();
    this.triggerMatchers.clear();
  }
}
