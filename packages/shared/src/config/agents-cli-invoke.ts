import { RPC_CHANNELS } from '../protocol/channels.ts'

export interface BashPatternRule {
  pattern: string
  comment: string
}

/**
 * RPC channels safe to invoke via `kata-agents-cli invoke` in Explore mode.
 */
export const AGENTS_CLI_READ_ONLY_INVOKE_CHANNELS = [
  RPC_CHANNELS.labels.LIST,
  RPC_CHANNELS.sources.GET,
  RPC_CHANNELS.sources.GET_PERMISSIONS,
  RPC_CHANNELS.skills.GET,
  RPC_CHANNELS.automations.GET,
  RPC_CHANNELS.automations.GET_HISTORY,
  RPC_CHANNELS.automations.GET_LAST_EXECUTED,
  RPC_CHANNELS.workspace.GET_PERMISSIONS,
  RPC_CHANNELS.permissions.GET_DEFAULTS,
  RPC_CHANNELS.workspace.SETTINGS_GET,
  RPC_CHANNELS.system.HOME_DIR,
] as const

/**
 * RPC channels whose handler expects `workspaceId` as its first positional arg.
 * `kata-agents-cli invoke` injects the active workspace for these channels.
 */
export const AGENTS_CLI_WORKSPACE_SCOPED_INVOKE_CHANNELS = [
  RPC_CHANNELS.labels.LIST,
  RPC_CHANNELS.labels.CREATE,
  RPC_CHANNELS.labels.DELETE,
  RPC_CHANNELS.sources.GET,
  RPC_CHANNELS.sources.CREATE,
  RPC_CHANNELS.sources.DELETE,
  RPC_CHANNELS.sources.GET_PERMISSIONS,
  RPC_CHANNELS.sources.GET_MCP_TOOLS,
  RPC_CHANNELS.sources.SAVE_CREDENTIALS,
  RPC_CHANNELS.skills.GET,
  RPC_CHANNELS.skills.GET_FILES,
  RPC_CHANNELS.skills.DELETE,
  RPC_CHANNELS.skills.OPEN_EDITOR,
  RPC_CHANNELS.skills.OPEN_FINDER,
  RPC_CHANNELS.automations.GET,
  RPC_CHANNELS.automations.GET_HISTORY,
  RPC_CHANNELS.automations.GET_LAST_EXECUTED,
  RPC_CHANNELS.automations.DELETE,
  RPC_CHANNELS.automations.SET_ENABLED,
  RPC_CHANNELS.automations.DUPLICATE,
  RPC_CHANNELS.automations.REPLAY,
  RPC_CHANNELS.workspace.GET_PERMISSIONS,
  RPC_CHANNELS.workspace.SETTINGS_GET,
  RPC_CHANNELS.workspace.SETTINGS_UPDATE,
] as const

const workspaceScopedInvokeChannels = new Set<string>(AGENTS_CLI_WORKSPACE_SCOPED_INVOKE_CHANNELS)

export function isWorkspaceScopedInvokeChannel(channel: string): boolean {
  return workspaceScopedInvokeChannels.has(channel)
}

/** Build positional args for an invoke call, injecting workspace first when scoped. */
export function buildAgentsCliInvokeArgs(
  channel: string,
  userArgs: unknown[],
  workspaceId: string | undefined,
): unknown[] {
  return workspaceId && isWorkspaceScopedInvokeChannel(channel)
    ? [workspaceId, ...userArgs]
    : userArgs
}

export function getAgentsCliReadOnlyInvokeChannelAlternation(): string {
  return AGENTS_CLI_READ_ONLY_INVOKE_CHANNELS.join('|')
}

/** Explore-mode bash allowlist patterns for `kata-agents-cli invoke`. */
export function getAgentsCliReadOnlyInvokeBashPatterns(): BashPatternRule[] {
  const channelAlternation = getAgentsCliReadOnlyInvokeChannelAlternation()
  return [
    {
      pattern: `^kata-agents-cli\\s+invoke\\s+(${channelAlternation})(\\s+.*)?$`,
      comment: 'kata-agents-cli invoke read-only RPC channels',
    },
    {
      pattern: '^kata-agents-cli\\s+--help$',
      comment: 'kata-agents-cli help',
    },
  ]
}
