import { createHash } from 'node:crypto'
import { APPROVAL_LIMITS, type ToolTarget } from '@kata-sh/core'
import { isBrowserToolNameOrAlias } from '../agent/browser-tool-names.ts'

function truncate(value: string): string {
  const buffer = Buffer.from(value, 'utf8')
  if (buffer.byteLength <= APPROVAL_LIMITS.targetBytes) return value
  return buffer.subarray(0, APPROVAL_LIMITS.targetBytes).toString('utf8')
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value
    if (Array.isArray(value) && typeof value[0] === 'string' && value[0].trim()) {
      return value.map((part) => String(part)).join(' ')
    }
  }
  return ''
}

export function resolveToolTarget(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
): ToolTarget {
  const kind = isBrowserToolNameOrAlias(toolName)
    ? 'browser'
    : toolName === 'Bash' || toolName === 'KillShell'
      ? 'command'
      : toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'NotebookEdit'
        ? 'file'
        : 'tool'
  const raw = firstString(
    input.file_path,
    input.notebook_path,
    input.path,
    input.command,
    input.target,
    input.targetBot,
    input.url,
    input.name,
  ) || toolName
  return {
    kind,
    value: truncate(raw),
    fingerprint: createHash('sha256').update(raw, 'utf8').digest('hex'),
  }
}
