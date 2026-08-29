import { APPROVAL_LIMITS, type SanitizedOperation, type ToolSideEffect } from '@kata-sh/core'
import { truncateUtf8 } from '../spawn-tasks/utf8.ts'

const SECRET_KEY = /credential|password|token|secret|authorization|api[_-]?key/i

export function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue)
  if (value === null || typeof value !== 'object') return value
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(key)) continue
    result[key] = redactValue(entry)
  }
  return result
}

export function sanitizeOperation(
  toolName: string,
  target: string,
  input: Readonly<Record<string, unknown>>,
  sideEffect: ToolSideEffect,
): SanitizedOperation {
  const redacted = redactValue(input)
  return {
    toolName,
    target: truncateUtf8(target, APPROVAL_LIMITS.targetBytes),
    preview: truncateUtf8(JSON.stringify(redacted), APPROVAL_LIMITS.previewBytes),
    sideEffect,
  }
}
