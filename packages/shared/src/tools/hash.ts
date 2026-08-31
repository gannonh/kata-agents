import { createHash } from 'node:crypto'
import type { ToolInvocation } from '@kata-sh/core'

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}

export function computeOperationHash(invocation: ToolInvocation): string {
  const material = {
    attempt: invocation.attempt,
    botId: invocation.botId,
    conversationId: invocation.conversationId,
    normalizedInput: invocation.normalizedInput,
    policyRevision: invocation.policyRevision,
    runtimeId: invocation.runtimeId,
    targetFingerprint: invocation.target.fingerprint,
    targetValue: invocation.target.value,
    toolName: invocation.toolName,
    toolSchemaVersion: invocation.toolSchemaVersion,
    workspaceId: invocation.workspaceId,
  }
  return createHash('sha256').update(canonical(material), 'utf8').digest('hex')
}
