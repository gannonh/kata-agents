export const APPROVAL_SCHEMA_VERSION = 1 as const
export const APPROVAL_LIMITS = Object.freeze({
  previewBytes: 8 * 1024,
  targetBytes: 4 * 1024,
  ruleTargetBytes: 4 * 1024,
  ttlMs: 120_000,
})

/** `approval_<uuid>` */
export type ApprovalId = string
/** `rule_<uuid>` */
export type StandingRuleId = string
/** `attempt_<n>` monotonic per invocation identity */
export type ExecutionAttempt = number

export const TOOL_CONSEQUENCE_CLASSES = ['read', 'consequential'] as const
export type ToolConsequenceClass = (typeof TOOL_CONSEQUENCE_CLASSES)[number]

export const TOOL_SIDE_EFFECTS = [
  'read', 'write', 'send', 'publish', 'purchase', 'delete',
  'credential', 'permission', 'git', 'shell', 'browser',
] as const
export type ToolSideEffect = (typeof TOOL_SIDE_EFFECTS)[number]

export const APPROVAL_STATUSES = [
  'pending', 'denied', 'allowed-once', 'consumed', 'expired', 'stale',
] as const
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]

export const STANDING_RULE_EFFECTS = ['allow', 'require-approval'] as const
export type StandingRuleEffect = (typeof STANDING_RULE_EFFECTS)[number]

export const STANDING_RULE_STATES = ['active', 'disabled'] as const
export type StandingRuleState = (typeof STANDING_RULE_STATES)[number]

export const POLICY_BLOCK_REASONS = [
  'hard-restriction',
  'safe-mode',
  'require-approval',
  'denied',
  'expired',
  'stale',
  'unauthorized',
  'mismatch',
  'consumed',
] as const
export type PolicyBlockReason = (typeof POLICY_BLOCK_REASONS)[number]

export const POLICY_ALLOW_REASONS = [
  'safe-read',
  'standing-allow',
  'one-time',
  'allow-all',
] as const
export type PolicyAllowReason = (typeof POLICY_ALLOW_REASONS)[number]

export type PolicyVerdict =
  | { readonly kind: 'allow'; readonly reason: PolicyAllowReason }
  | { readonly kind: 'block'; readonly reason: PolicyBlockReason; readonly message: string }
  | { readonly kind: 'ask'; readonly request: ApprovalRequest }

export interface ToolTarget {
  readonly kind: string
  readonly value: string
  readonly fingerprint: string
}

export interface ToolInvocation {
  readonly workspaceId: string
  readonly botId: string
  readonly conversationId: string
  readonly runtimeId: string
  readonly toolName: string
  readonly toolSchemaVersion: string
  readonly normalizedInput: Readonly<Record<string, unknown>>
  readonly attempt: ExecutionAttempt
  readonly target: ToolTarget
  readonly policyRevision: string
}

export interface SanitizedOperation {
  readonly toolName: string
  readonly target: string
  readonly preview: string
  readonly sideEffect: ToolSideEffect
}

export type ApprovalRecord =
  | ApprovalPending
  | ApprovalDenied
  | ApprovalAllowedOnce
  | ApprovalConsumed
  | ApprovalExpired
  | ApprovalStale

interface ApprovalBase {
  readonly schemaVersion: typeof APPROVAL_SCHEMA_VERSION
  readonly version: number
  readonly approvalId: ApprovalId
  readonly workspaceId: string
  readonly botId: string
  readonly conversationId: string
  readonly runtimeId: string
  readonly toolName: string
  readonly toolSchemaVersion: string
  readonly operationHash: string
  readonly targetFingerprint: string
  readonly sanitized: SanitizedOperation
  readonly policyRevision: string
  readonly attempt: ExecutionAttempt
  readonly expiresAt: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface ApprovalPending extends ApprovalBase {
  readonly status: 'pending'
}
export type ApprovalRequest = ApprovalPending
export interface ApprovalDenied extends ApprovalBase {
  readonly status: 'denied'
  readonly resolvedAt: string
}
export interface ApprovalAllowedOnce extends ApprovalBase {
  readonly status: 'allowed-once'
  readonly resolvedAt: string
}
export interface ApprovalConsumed extends ApprovalBase {
  readonly status: 'consumed'
  readonly consumedAt: string
}
export interface ApprovalExpired extends ApprovalBase {
  readonly status: 'expired'
  readonly expiredAt: string
}
export interface ApprovalStale extends ApprovalBase {
  readonly status: 'stale'
  readonly staleAt: string
}

export interface StandingRule {
  readonly schemaVersion: typeof APPROVAL_SCHEMA_VERSION
  readonly version: number
  readonly ruleId: StandingRuleId
  readonly workspaceId: string
  readonly botId: string
  readonly toolName: string
  readonly target: string
  readonly targetFingerprint: string
  readonly effect: StandingRuleEffect
  readonly state: StandingRuleState
  readonly createdAt: string
  readonly updatedAt: string
  readonly disabledAt?: string
}
