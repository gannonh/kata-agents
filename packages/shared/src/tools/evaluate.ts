import {
  APPROVAL_SCHEMA_VERSION,
  type ApprovalPending,
  type ApprovalRecord,
  type PolicyVerdict,
  type StandingRule,
  type ToolInvocation,
} from '@kata-sh/core'
import type { PermissionMode } from '../agent/mode-types.ts'
import { shouldAllowToolInMode } from '../agent/mode-manager.ts'
import { classifyTool } from './classify.ts'
import { computeOperationHash } from './hash.ts'
import { sanitizeOperation } from './redact.ts'

export interface EvaluatePolicyInput {
  readonly invocation: ToolInvocation
  readonly mode: PermissionMode
  readonly standingRules: readonly StandingRule[]
  readonly existing?: ApprovalRecord
  readonly now?: string
}

function matchesRule(rule: StandingRule, invocation: ToolInvocation): boolean {
  return rule.state === 'active'
    && rule.botId === invocation.botId
    && rule.workspaceId === invocation.workspaceId
    && rule.toolName === invocation.toolName
    && rule.targetFingerprint === invocation.target.fingerprint
}

function block(reason: Extract<PolicyVerdict, { kind: 'block' }>['reason'], message: string): PolicyVerdict {
  return { kind: 'block', reason, message }
}

function ask(invocation: ToolInvocation): PolicyVerdict {
  const classified = classifyTool(invocation.toolName, invocation.normalizedInput)
  const request: ApprovalPending = {
    schemaVersion: APPROVAL_SCHEMA_VERSION,
    version: 1,
    approvalId: 'approval_pending',
    workspaceId: invocation.workspaceId,
    botId: invocation.botId,
    conversationId: invocation.conversationId,
    runtimeId: invocation.runtimeId,
    toolName: invocation.toolName,
    toolSchemaVersion: invocation.toolSchemaVersion,
    operationHash: computeOperationHash(invocation),
    targetFingerprint: invocation.target.fingerprint,
    sanitized: sanitizeOperation(
      invocation.toolName,
      invocation.target.value,
      invocation.normalizedInput,
      classified.sideEffect,
    ),
    policyRevision: invocation.policyRevision,
    attempt: invocation.attempt,
    expiresAt: '',
    createdAt: '',
    updatedAt: '',
    status: 'pending',
  }
  return { kind: 'ask', request }
}

export function evaluatePolicy(input: EvaluatePolicyInput): PolicyVerdict {
  const { invocation, mode, standingRules, existing, now } = input
  const classified = classifyTool(invocation.toolName, invocation.normalizedInput)
  const requireRule = standingRules.some((rule) => rule.effect === 'require-approval' && matchesRule(rule, invocation))
  const allowRule = standingRules.some((rule) => rule.effect === 'allow' && matchesRule(rule, invocation))
  const modeCheck = mode === 'safe'
    ? shouldAllowToolInMode(invocation.toolName, invocation.normalizedInput, mode)
    : { allowed: true as const }

  if (existing?.status === 'denied') {
    return block('denied', 'This operation was denied and cannot run.')
  }
  if (existing?.status === 'consumed') {
    return block('consumed', 'This one-time approval was already used.')
  }
  if (existing?.status === 'expired') {
    return block('expired', 'This approval expired before execution.')
  }
  if (existing?.status === 'stale') {
    return block('stale', 'The operation changed after approval.')
  }
  if (existing?.status === 'pending' && now !== undefined && now >= existing.expiresAt) {
    return block('expired', 'This approval expired before execution.')
  }

  if (mode === 'safe' && classified.class === 'read' && !modeCheck.allowed) {
    return block('hard-restriction', 'reason' in modeCheck ? modeCheck.reason : 'This tool is blocked by Explore restrictions.')
  }

  if (requireRule && existing?.status !== 'allowed-once') return ask(invocation)

  if (mode === 'safe' && classified.class === 'consequential' && !modeCheck.allowed) {
    return block('safe-mode', 'This mutation is blocked in Explore mode.')
  }

  if (allowRule) return { kind: 'allow', reason: 'standing-allow' }

  if (existing?.status === 'allowed-once') {
    if (
      existing.operationHash !== computeOperationHash(invocation)
      || existing.targetFingerprint !== invocation.target.fingerprint
      || existing.attempt !== invocation.attempt
    ) {
      return block('stale', 'The operation changed after approval.')
    }
    return { kind: 'allow', reason: 'one-time' }
  }

  if (mode === 'allow-all') return { kind: 'allow', reason: 'allow-all' }
  if (classified.class === 'read') return { kind: 'allow', reason: 'safe-read' }
  if (mode === 'safe' && modeCheck.allowed) return { kind: 'allow', reason: 'safe-read' }
  if (mode === 'safe') return block('safe-mode', 'This mutation is blocked in Explore mode.')
  return ask(invocation)
}
