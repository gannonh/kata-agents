/**
 * Channel Config Delivery
 *
 * Bridges channel configuration on disk with the running daemon process.
 * Loads all workspace channel configs, resolves credentials, and sends
 * a configure_channels command to the daemon.
 *
 * Called on two trigger points:
 * 1. Daemon reaches 'running' state (initial delivery)
 * 2. Channel IPC mutations (CHANNELS_UPDATE, CHANNELS_DELETE, CHANNEL_CREDENTIAL_SET)
 */

import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { DaemonManager } from './daemon-manager'
import type { ChannelConfig } from '@craft-agent/shared/channels'
import { getWorkspaces } from '@craft-agent/shared/config'
import type { CredentialManager } from '@craft-agent/shared/credentials'

/** Slug validation (matches ipc.ts isValidSlug) */
const VALID_SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/

/**
 * Load all enabled channel configs across all workspaces, resolve their
 * credentials, and send a configure_channels command to the daemon.
 *
 * Always sends the command even if no workspaces have channels, so the
 * daemon can clear previously running adapters.
 *
 * @param daemonManager - The daemon manager instance
 * @param credentialManagerGetter - Getter to avoid circular dependency
 */
export async function deliverChannelConfigs(
  daemonManager: DaemonManager,
  credentialManagerGetter: () => CredentialManager,
): Promise<void> {
  if (daemonManager.getState() !== 'running') {
    return
  }

  const workspaces = getWorkspaces()
  const credManager = credentialManagerGetter()

  const workspacePayloads: Array<{
    workspaceId: string
    configs: ChannelConfig[]
    tokens: Record<string, string>
    enabledPlugins: string[]
  }> = []

  for (const workspace of workspaces) {
    const rootPath = workspace.rootPath.replace(/^~/, homedir())
    const channelsDir = join(rootPath, 'channels')

    if (!existsSync(channelsDir)) {
      continue
    }

    let slugs: string[]
    try {
      slugs = readdirSync(channelsDir)
    } catch {
      continue
    }

    const configs: ChannelConfig[] = []
    const tokens: Record<string, string> = {}

    for (const slug of slugs) {
      if (!VALID_SLUG_RE.test(slug)) {
        continue
      }

      const configPath = join(channelsDir, slug, 'config.json')
      if (!existsSync(configPath)) {
        continue
      }

      let config: ChannelConfig
      try {
        const raw = readFileSync(configPath, 'utf-8')
        config = JSON.parse(raw) as ChannelConfig
      } catch (err) {
        console.error(`[channel-config-delivery] Skipping malformed config for "${slug}":`, err)
        continue
      }

      if (!config.enabled) {
        continue
      }

      // Resolve credential: channelSlug (preferred) then sourceSlug (legacy fallback)
      if (config.credentials.channelSlug) {
        const token = await credManager.getChannelCredential(workspace.id, config.credentials.channelSlug)
        if (token) {
          tokens[config.credentials.channelSlug] = token
        }
      } else if (config.credentials.sourceSlug) {
        const cred = await credManager.get({
          type: 'source_apikey',
          workspaceId: workspace.id,
          sourceId: config.credentials.sourceSlug,
        })
        if (cred?.value) {
          tokens[config.credentials.sourceSlug] = cred.value
        }
      }

      configs.push(config)
    }

    if (configs.length > 0) {
      // Derive enabledPlugins from adapter types
      const adapterTypes = new Set(configs.map((c) => c.adapter))
      workspacePayloads.push({
        workspaceId: workspace.id,
        configs,
        tokens,
        enabledPlugins: [...adapterTypes],
      })
    }
  }

  // Always send, even if empty (clears previously running adapters)
  daemonManager.sendCommand({
    type: 'configure_channels',
    workspaces: workspacePayloads,
  })
}
