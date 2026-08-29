import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APPROVAL_SCHEMA_VERSION, type StandingRule, type ToolInvocation } from '@kata-sh/core'
import {
  ApprovalConflictError,
  ApprovalStore,
  StandingRuleStore,
  ToolBroker,
  classifyTool,
  computeOperationHash,
  evaluatePolicy,
  redactValue,
  sanitizeOperation,
} from '../index.ts'

const at = '2026-08-29T20:00:00.000Z'
const later = '2026-08-29T20:03:00.000Z'
const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'tool-approval-'))
  tempRoots.push(root)
  return root
}

function invocation(overrides: Partial<ToolInvocation> = {}): ToolInvocation {
  return {
    workspaceId: 'ws_1',
    botId: 'bot_source',
    conversationId: 'chat_1',
    runtimeId: 'session_1',
    toolName: 'Write',
    toolSchemaVersion: '1',
    normalizedInput: { file_path: '/tmp/bounded.txt', content: 'hello' },
    attempt: 1,
    target: { kind: 'file', value: '/tmp/bounded.txt', fingerprint: 'fp_write' },
    policyRevision: 'rev_1',
    ...overrides,
  }
}

function rule(overrides: Partial<StandingRule> = {}): StandingRule {
  return {
    schemaVersion: APPROVAL_SCHEMA_VERSION,
    version: 1,
    ruleId: 'rule_1',
    workspaceId: 'ws_1',
    botId: 'bot_source',
    toolName: 'Write',
    target: '/tmp/bounded.txt',
    effect: 'allow',
    state: 'active',
    createdAt: at,
    updatedAt: at,
    ...overrides,
  }
}

describe('classifyTool conformance', () => {
  const cases: Array<{ name: string; input?: Record<string, unknown>; class: 'read' | 'consequential'; sideEffect: import('@kata-sh/core').ToolSideEffect }> = [
    { name: 'Read', class: 'read', sideEffect: 'read' },
    { name: 'Write', class: 'consequential', sideEffect: 'write' },
    { name: 'send_handoff', class: 'consequential', sideEffect: 'send' },
    { name: 'mcp__docs__publish_page', class: 'consequential', sideEffect: 'publish' },
    { name: 'mcp__shop__purchase_item', class: 'consequential', sideEffect: 'purchase' },
    { name: 'mcp__files__delete_file', class: 'consequential', sideEffect: 'delete' },
    { name: 'source_oauth_trigger', class: 'consequential', sideEffect: 'credential' },
    { name: 'set_session_labels', class: 'consequential', sideEffect: 'permission' },
    { name: 'Bash', input: { command: 'git push origin main' }, class: 'consequential', sideEffect: 'git' },
    { name: 'Bash', input: { command: 'echo hi' }, class: 'consequential', sideEffect: 'shell' },
    { name: 'browser_tool', input: { command: 'snapshot' }, class: 'read', sideEffect: 'read' },
    { name: 'browser_tool', input: { command: 'click @e1' }, class: 'consequential', sideEffect: 'browser' },
  ]

  for (const entry of cases) {
    it(`classifies ${entry.name} ${JSON.stringify(entry.input ?? {})} as ${entry.sideEffect}`, () => {
      const result = classifyTool(entry.name, entry.input ?? {})
      expect(result.class).toBe(entry.class)
      expect(result.sideEffect).toBe(entry.sideEffect)
    })
  }
})

describe('evaluatePolicy', () => {
  it('allows Read and blocks Write in safe mode', () => {
    const read = evaluatePolicy({ invocation: invocation({ toolName: 'Read', normalizedInput: { file_path: '/tmp/a' } }), mode: 'safe', standingRules: [] })
    const write = evaluatePolicy({ invocation: invocation(), mode: 'safe', standingRules: [] })
    expect(read).toEqual({ kind: 'allow', reason: 'safe-read' })
    expect(write.kind).toBe('block')
    if (write.kind === 'block') expect(write.reason).toBe('safe-mode')
  })

  it('asks for Write in ask mode', () => {
    expect(evaluatePolicy({ invocation: invocation(), mode: 'ask', standingRules: [] }).kind).toBe('ask')
  })

  it('allows Write in allow-all unless a require-approval rule matches', () => {
    expect(evaluatePolicy({ invocation: invocation(), mode: 'allow-all', standingRules: [] })).toEqual({ kind: 'allow', reason: 'allow-all' })
    const paused = evaluatePolicy({
      invocation: invocation(),
      mode: 'allow-all',
      standingRules: [rule({ effect: 'require-approval' })],
    })
    expect(paused.kind).toBe('ask')
  })

  it('matches a standing allow only on the exact tool and target', () => {
    const allowed = evaluatePolicy({ invocation: invocation(), mode: 'ask', standingRules: [rule()] })
    const otherPath = evaluatePolicy({
      invocation: invocation({ target: { kind: 'file', value: '/tmp/other.txt', fingerprint: 'fp_other' } }),
      mode: 'ask',
      standingRules: [rule()],
    })
    expect(allowed).toEqual({ kind: 'allow', reason: 'standing-allow' })
    expect(otherPath.kind).toBe('ask')
  })

  it('uses the target Bot id for standing rules on a handoff-shaped invocation', () => {
    const targetInvocation = invocation({ botId: 'bot_target' })
    const sourceRule = rule({ botId: 'bot_source' })
    const targetRule = rule({ botId: 'bot_target' })
    expect(evaluatePolicy({ invocation: targetInvocation, mode: 'ask', standingRules: [sourceRule] }).kind).toBe('ask')
    expect(evaluatePolicy({ invocation: targetInvocation, mode: 'ask', standingRules: [targetRule] })).toEqual({ kind: 'allow', reason: 'standing-allow' })
  })
})

describe('operation hash and redaction', () => {
  it('changes when unredacted input changes and stays stable across preview redaction', () => {
    const secret = invocation({ normalizedInput: { file_path: '/tmp/a', password: 'hunter2', content: 'same' } })
    const changed = invocation({ normalizedInput: { file_path: '/tmp/a', password: 'hunter2', content: 'other' } })
    const preview = sanitizeOperation('Write', '/tmp/a', secret.normalizedInput, 'write')
    expect(computeOperationHash(secret)).not.toBe(computeOperationHash(changed))
    expect(JSON.stringify(redactValue(secret.normalizedInput))).not.toContain('hunter2')
    expect(preview.preview).not.toContain('hunter2')
    expect(computeOperationHash(secret)).toBe(computeOperationHash({
      ...secret,
      normalizedInput: { file_path: '/tmp/a', password: 'hunter2', content: 'same' },
    }))
  })
})

describe('ApprovalStore and ToolBroker', () => {
  function broker(root: string, clock = () => at): ToolBroker {
    const store = new ApprovalStore({ workspaceRoot: root, workspaceId: 'ws_1', clock })
    const rules = new StandingRuleStore({ workspaceRoot: root, workspaceId: 'ws_1', clock })
    let n = 0
    return new ToolBroker(store, rules, { workspaceId: 'ws_1', clock, randomId: () => `id_${n++}` })
  }

  it('resolves deny then fails closed on a second resolve', () => {
    const owner = broker(tempWorkspace())
    const asked = owner.authorize(invocation(), 'ask')
    expect(asked.kind).toBe('ask')
    if (asked.kind !== 'ask') return
    const denied = owner.resolve(asked.request.approvalId, asked.request.version, 'deny')
    expect(denied.status).toBe('denied')
    expect(() => owner.resolve(asked.request.approvalId, asked.request.version + 1, 'allow-once')).toThrow(ApprovalConflictError)
  })

  it('lets only one concurrent allow-once win', async () => {
    const root = tempWorkspace()
    const first = broker(root)
    const asked = first.authorize(invocation(), 'ask')
    expect(asked.kind).toBe('ask')
    if (asked.kind !== 'ask') return
    const second = new ToolBroker(
      new ApprovalStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at }),
      new StandingRuleStore({ workspaceRoot: root, workspaceId: 'ws_1', clock: () => at }),
      { workspaceId: 'ws_1', clock: () => at, randomId: () => 'other' },
    )
    const outcomes = await Promise.allSettled([
      Promise.resolve().then(() => first.resolve(asked.request.approvalId, asked.request.version, 'allow-once')),
      Promise.resolve().then(() => second.resolve(asked.request.approvalId, asked.request.version, 'allow-once')),
    ])
    const succeeded = outcomes.filter((outcome) => outcome.status === 'fulfilled')
    expect(succeeded).toHaveLength(1)
    if (succeeded[0]?.status === 'fulfilled') expect(succeeded[0].value.status).toBe('allowed-once')
  })

  it('consumes once and treats a changed input as stale', () => {
    const owner = broker(tempWorkspace())
    const call = invocation()
    const asked = owner.authorize(call, 'ask')
    expect(asked.kind).toBe('ask')
    if (asked.kind !== 'ask') return
    owner.resolve(asked.request.approvalId, asked.request.version, 'allow-once')
    const consumed = owner.claimExecution(asked.request.approvalId, call)
    expect(consumed.status).toBe('consumed')
    expect(() => owner.claimExecution(asked.request.approvalId, call)).toThrow(ApprovalConflictError)
    const again = owner.authorize(call, 'ask')
    expect(again.kind).toBe('ask')
    if (again.kind !== 'ask') return
    owner.resolve(again.request.approvalId, again.request.version, 'allow-once')
    const mutated = invocation({ normalizedInput: { file_path: '/tmp/bounded.txt', content: 'mutated' } })
    expect(() => owner.claimExecution(again.request.approvalId, mutated)).toThrow(ApprovalConflictError)
    const stale = owner.preExecute(again.request.approvalId, mutated)
    expect(stale.kind).toBe('block')
    if (stale.kind === 'block') expect(stale.reason).toBe('stale')
  })

  it('lets expiry win over a later allow-once', () => {
    let now = at
    const owner = broker(tempWorkspace(), () => now)
    const asked = owner.authorize(invocation(), 'ask')
    expect(asked.kind).toBe('ask')
    if (asked.kind !== 'ask') return
    now = later
    expect(() => owner.resolve(asked.request.approvalId, asked.request.version, 'allow-once')).toThrow(ApprovalConflictError)
    const expired = owner.store.get(asked.request.approvalId)
    expect(expired?.status).toBe('expired')
    expect(expired && 'expiresAt' in expired ? expired.expiresAt : '').toBe(asked.request.expiresAt)
  })
})
