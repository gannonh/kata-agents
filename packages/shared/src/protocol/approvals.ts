import type { ApprovalRecord, StandingRule } from '@kata-sh/core'

export interface ApprovalCardView {
  readonly approvalId: string
  readonly conversationId: string
  readonly botId: string
  readonly status: ApprovalRecord['status']
  readonly version: number
  readonly toolName: string
  readonly target: string
  readonly preview: string
  readonly sideEffect: ApprovalRecord['sanitized']['sideEffect']
  readonly expiresAt: string
  readonly createdAt: string
}

export interface GetApprovalsInput {
  readonly conversationId: string
}

export interface ResolveApprovalInput {
  readonly approvalId: string
  readonly expectedVersion: number
  readonly choice: 'deny' | 'allow-once'
  readonly createStandingAllow?: boolean
}

export interface ListStandingRulesInput {
  readonly botId?: string
}

export interface DisableStandingRuleInput {
  readonly ruleId: string
  readonly expectedVersion: number
}

export interface DeleteStandingRuleInput {
  readonly ruleId: string
}

export interface ApprovalInvalidatedEvent {
  readonly workspaceId: string
  readonly conversationId: string
  readonly approvalId: string
  readonly botId: string
}

export function toApprovalCardView(record: ApprovalRecord): ApprovalCardView {
  return {
    approvalId: record.approvalId,
    conversationId: record.conversationId,
    botId: record.botId,
    status: record.status,
    version: record.version,
    toolName: record.toolName,
    target: record.sanitized.target,
    preview: record.sanitized.preview,
    sideEffect: record.sanitized.sideEffect,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
  }
}

export type { StandingRule }
