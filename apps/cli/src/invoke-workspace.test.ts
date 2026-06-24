import { describe, it, expect } from 'bun:test'
import { AGENTS_CLI_WORKSPACE_SCOPED_INVOKE_CHANNELS } from '@kata-sh/shared/config/agents-cli-invoke'
import { HANDLED_CHANNELS as LABEL_CHANNELS } from '@kata-sh/server-core/handlers/rpc/labels'
import { HANDLED_CHANNELS as SOURCE_CHANNELS } from '@kata-sh/server-core/handlers/rpc/sources'
import { HANDLED_CHANNELS as SKILL_CHANNELS } from '@kata-sh/server-core/handlers/rpc/skills'
import { HANDLED_CHANNELS as AUTOMATION_CHANNELS } from '@kata-sh/server-core/handlers/rpc/automations'
import { HANDLED_CHANNELS as SETTINGS_CHANNELS } from '@kata-sh/server-core/handlers/rpc/settings'

const workspaceFirstHandlerChannels = new Set<string>([
  ...LABEL_CHANNELS,
  ...SOURCE_CHANNELS,
  ...SKILL_CHANNELS,
  ...AUTOMATION_CHANNELS,
  ...SETTINGS_CHANNELS,
])

describe('agents-cli workspace-scoped invoke channels', () => {
  it('lists only channels registered on workspace-first RPC handlers', () => {
    for (const channel of AGENTS_CLI_WORKSPACE_SCOPED_INVOKE_CHANNELS) {
      expect(workspaceFirstHandlerChannels.has(channel)).toBe(true)
    }
  })
})
