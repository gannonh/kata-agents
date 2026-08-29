import { SESSION_TOOL_DEFS } from '@kata-sh/session-tools-core'
import {
  isBrowserToolNameOrAlias,
  normalizeBrowserToolName,
} from '../agent/browser-tool-names.ts'
import type { ToolConsequenceClass, ToolSideEffect } from '@kata-sh/core'

export interface ToolClassification {
  readonly class: ToolConsequenceClass
  readonly sideEffect: ToolSideEffect
}

const READ: ToolClassification = { class: 'read', sideEffect: 'read' }

const SESSION_SIDE_EFFECT: Record<string, ToolSideEffect> = {
  source_oauth_trigger: 'credential',
  source_google_oauth_trigger: 'credential',
  source_slack_oauth_trigger: 'credential',
  source_microsoft_oauth_trigger: 'credential',
  source_credential_prompt: 'credential',
  update_user_preferences: 'permission',
  set_session_labels: 'permission',
  set_session_status: 'permission',
  send_handoff: 'send',
  spawn_session: 'send',
  send_agent_message: 'send',
  unbind_messaging_channel: 'permission',
}

const READ_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'SubmitPlan',
  'Task',
  'TaskOutput',
  'LSP',
])

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

const DELETE_TOOLS = new Set(['Delete', 'delete_file', 'rm'])

const BROWSER_READ_COMMANDS = new Set([
  'snapshot',
  'screenshot',
  'console',
  'network',
  'downloads',
  'wait',
  'read',
  'accessibility',
])

const GIT_MUTATIONS = /\bgit\s+(push|commit|reset|rebase|checkout|merge|tag|stash|clean)\b/i

function canonicalToolName(toolName: string): string {
  return toolName.replace(/^(mcp__session__|session__|mcp__[^_]+__)/, '')
}

function firstToken(command: unknown): string {
  if (Array.isArray(command) && typeof command[0] === 'string') return command[0].trim().split(/\s+/)[0] ?? ''
  if (typeof command === 'string') return command.trim().split(/\s+/)[0] ?? ''
  return ''
}

function sessionClassification(name: string): ToolClassification | null {
  const def = SESSION_TOOL_DEFS.find((entry) => entry.name === name)
  if (!def) return null
  if (def.safeMode === 'allow' || def.readOnly) return READ
  const sideEffect = SESSION_SIDE_EFFECT[name] ?? 'permission'
  return { class: 'consequential', sideEffect }
}

function browserClassification(input: Readonly<Record<string, unknown>>): ToolClassification {
  const command = firstToken(input.command ?? input.action)
  const normalized = command.replace(/^browser_/, '').toLowerCase()
  if (BROWSER_READ_COMMANDS.has(normalized) || normalized === 'snapshot') return READ
  return { class: 'consequential', sideEffect: 'browser' }
}

function bashClassification(input: Readonly<Record<string, unknown>>): ToolClassification {
  const command = typeof input.command === 'string' ? input.command : ''
  if (GIT_MUTATIONS.test(command)) return { class: 'consequential', sideEffect: 'git' }
  return { class: 'consequential', sideEffect: 'shell' }
}

function mcpClassification(toolName: string, input: Readonly<Record<string, unknown>>): ToolClassification {
  const method = String(input.method ?? '').toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return READ
  if (method === 'DELETE') return { class: 'consequential', sideEffect: 'delete' }
  const lower = toolName.toLowerCase()
  if (/(^|__)(get_|list_|search_|read_|inspect_|describe_)/.test(lower)) return READ
  if (/purchase|buy|checkout/.test(lower)) return { class: 'consequential', sideEffect: 'purchase' }
  if (/publish|post_/.test(lower)) return { class: 'consequential', sideEffect: 'publish' }
  if (/delete|remove|destroy/.test(lower)) return { class: 'consequential', sideEffect: 'delete' }
  if (/send_|message|email/.test(lower)) return { class: 'consequential', sideEffect: 'send' }
  if (/credential|oauth|secret/.test(lower)) return { class: 'consequential', sideEffect: 'credential' }
  return { class: 'consequential', sideEffect: 'write' }
}

export function classifyTool(
  toolName: string,
  input: Readonly<Record<string, unknown>> = {},
): ToolClassification {
  const name = canonicalToolName(toolName)
  if (READ_TOOLS.has(name)) return READ
  if (WRITE_TOOLS.has(name)) return { class: 'consequential', sideEffect: 'write' }
  if (DELETE_TOOLS.has(name)) return { class: 'consequential', sideEffect: 'delete' }
  if (name === 'Bash' || name === 'KillShell') return bashClassification(input)
  if (name === 'browser_tool' || isBrowserToolNameOrAlias(toolName) || normalizeBrowserToolName(toolName)) {
    if (name !== 'browser_tool' && /snapshot|screenshot|console|network/.test(name)) return READ
    return browserClassification(input)
  }
  const session = sessionClassification(name)
  if (session) {
    if (name === 'browser_tool') return browserClassification(input)
    return session
  }
  if (toolName.includes('__') || name.includes('__')) return mcpClassification(toolName, input)
  return { class: 'consequential', sideEffect: 'write' }
}
