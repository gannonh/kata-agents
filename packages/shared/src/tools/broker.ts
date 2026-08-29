import { randomUUID } from 'node:crypto'
import type {
  ApprovalPending,
  ApprovalRecord,
  PolicyVerdict,
  StandingRule,
  ToolInvocation,
} from '@kata-sh/core'
import { APPROVAL_LIMITS, APPROVAL_SCHEMA_VERSION } from '@kata-sh/core'
import type { PermissionMode } from '../agent/mode-types.ts'
import { classifyTool } from './classify.ts'
import { evaluatePolicy } from './evaluate.ts'
import { computeOperationHash } from './hash.ts'
import { sanitizeOperation } from './redact.ts'
import { ApprovalConflictError, ApprovalStore, StandingRuleStore } from './store.ts'

export interface ToolBrokerOptions {
  readonly workspaceId: string
  readonly clock?: () => string
  readonly now?: () => string
  readonly ttlMs?: number
  readonly randomId?: () => string
}

function block(reason: Extract<PolicyVerdict, { kind: 'block' }>['reason'], message: string): PolicyVerdict {
  return { kind: 'block', reason, message }
}

export class ToolBroker {
  private readonly clock: () => string
  private readonly ttlMs: number
  private readonly randomId: () => string

  constructor(
    readonly store: ApprovalStore,
    readonly rules: StandingRuleStore,
    private readonly options: ToolBrokerOptions,
  ) {
    this.clock = options.clock ?? options.now ?? (() => new Date().toISOString())
    this.ttlMs = options.ttlMs ?? APPROVAL_LIMITS.ttlMs
    this.randomId = options.randomId ?? randomUUID
  }

  authorize(
    invocation: ToolInvocation,
    mode: PermissionMode,
    standingRules: readonly StandingRule[] = this.rules.list(invocation.botId),
    existing?: ApprovalRecord,
  ): PolicyVerdict {
    if (invocation.workspaceId !== this.options.workspaceId) {
      return block('unauthorized', 'Workspace identity mismatch.')
    }
    const now = this.clock()
    const hash = computeOperationHash(invocation)
    const open = existing ?? this.store.findOpenByHash(hash)
    const due = open?.status === 'pending' ? this.store.expireIfDue(open.approvalId, now) : open
    const current = due && (due.status === 'pending' || due.status === 'allowed-once') ? due : existing
    const verdict = evaluatePolicy({
      invocation,
      mode,
      standingRules,
      existing: current,
      now,
    })
    if (verdict.kind !== 'ask') return verdict
    if (current?.status === 'pending') return { kind: 'ask', request: current }
    const classified = classifyTool(invocation.toolName, invocation.normalizedInput)
    const pending: ApprovalPending = {
      schemaVersion: APPROVAL_SCHEMA_VERSION,
      version: 1,
      approvalId: this.mintApprovalId(),
      workspaceId: invocation.workspaceId,
      botId: invocation.botId,
      conversationId: invocation.conversationId,
      runtimeId: invocation.runtimeId,
      toolName: invocation.toolName,
      toolSchemaVersion: invocation.toolSchemaVersion,
      operationHash: hash,
      targetFingerprint: invocation.target.fingerprint,
      sanitized: sanitizeOperation(
        invocation.toolName,
        invocation.target.value,
        invocation.normalizedInput,
        classified.sideEffect,
      ),
      policyRevision: invocation.policyRevision,
      attempt: invocation.attempt,
      expiresAt: new Date(Date.parse(now) + this.ttlMs).toISOString(),
      createdAt: now,
      updatedAt: now,
      status: 'pending',
    }
    return { kind: 'ask', request: this.store.createPending(pending) }
  }

  preExecute(approvalId: string, invocation: ToolInvocation): PolicyVerdict {
    let record: ApprovalRecord
    try {
      record = this.store.expireIfDue(approvalId, this.clock())
    } catch (error) {
      if (error instanceof ApprovalConflictError) return block(error.reason, error.message)
      throw error
    }
    if (
      record.workspaceId !== invocation.workspaceId
      || record.botId !== invocation.botId
      || record.conversationId !== invocation.conversationId
    ) {
      return block('unauthorized', 'Approval identity does not match this invocation.')
    }
    const hash = computeOperationHash(invocation)
    if (hash !== record.operationHash || invocation.target.fingerprint !== record.targetFingerprint) {
      this.store.markStale(approvalId, this.clock())
      return block('stale', 'The operation changed after approval.')
    }
    if (record.status === 'expired') return block('expired', 'This approval expired before execution.')
    if (record.status === 'denied') return block('denied', 'This operation was denied and cannot run.')
    if (record.status === 'consumed') return block('consumed', 'This one-time approval was already used.')
    if (record.status === 'stale') return block('stale', 'The operation changed after approval.')
    if (record.status === 'allowed-once') return { kind: 'allow', reason: 'one-time' }
    return block('mismatch', 'This approval is not an allowed execution decision.')
  }

  resolve(approvalId: string, expectedVersion: number, choice: 'deny' | 'allow-once' | 'denied' | 'allowed-once'): ApprovalRecord {
    const next = choice === 'deny' || choice === 'denied' ? 'deny' : 'allow-once'
    return this.store.resolve(approvalId, expectedVersion, next, this.clock())
  }

  claimExecution(approvalId: string, invocation: ToolInvocation): ApprovalRecord {
    return this.store.consume(approvalId, invocation, this.clock())
  }

  createStandingAllow(record: ApprovalRecord, effect: StandingRule['effect'] = 'allow'): StandingRule {
    const now = this.clock()
    return this.rules.create({
      schemaVersion: APPROVAL_SCHEMA_VERSION,
      version: 1,
      ruleId: `rule_${this.randomId()}`,
      workspaceId: record.workspaceId,
      botId: record.botId,
      toolName: record.toolName,
      target: record.sanitized.target,
      targetFingerprint: record.targetFingerprint,
      effect,
      state: 'active',
      createdAt: now,
      updatedAt: now,
    })
  }

  private mintApprovalId(): string {
    let id = `approval_${this.randomId()}`
    let suffix = 0
    while (true) {
      const existing = this.store.get(id)
      if (!existing || existing.status === 'pending') return id
      suffix += 1
      id = `approval_${this.randomId()}_${suffix}`
    }
  }
}
