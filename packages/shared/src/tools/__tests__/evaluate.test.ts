import { describe, expect, it } from 'bun:test';
import type { StandingRule, ToolInvocation } from '@kata-sh/core';
import { APPROVAL_SCHEMA_VERSION } from '@kata-sh/core';
import { evaluatePolicy } from '../index.ts';

function invocation(overrides: Partial<ToolInvocation> = {}): ToolInvocation {
  return {
    workspaceId: 'ws_1',
    botId: 'bot_1',
    conversationId: 'chat_1',
    runtimeId: 'rt_1',
    toolName: 'Read',
    toolSchemaVersion: '1',
    normalizedInput: {},
    attempt: 1,
    target: { kind: 'path', value: '/tmp/a.txt', fingerprint: 'fp_a' },
    policyRevision: 'pol_1',
    ...overrides,
  };
}

function standingRule(overrides: Partial<StandingRule> & Pick<StandingRule, 'effect' | 'toolName' | 'target'>): StandingRule {
  return {
    schemaVersion: APPROVAL_SCHEMA_VERSION,
    version: 1,
    ruleId: 'rule_1',
    workspaceId: 'ws_1',
    botId: 'bot_1',
    state: 'active',
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:00:00.000Z',
    ...overrides,
  };
}

describe('evaluatePolicy', () => {
  it('safe allows Read and blocks Write with reason safe-mode', () => {
    const read = evaluatePolicy({
      invocation: invocation({ toolName: 'Read', normalizedInput: { file_path: '/tmp/a.txt' } }),
      mode: 'safe',
      standingRules: [],
    });
    expect(read).toEqual({ kind: 'allow', reason: 'safe-read' });

    const write = evaluatePolicy({
      invocation: invocation({ toolName: 'Write', normalizedInput: { path: '/tmp/a.txt' } }),
      mode: 'safe',
      standingRules: [],
    });
    expect(write.kind).toBe('block');
    if (write.kind !== 'block') return;
    expect(write.reason).toBe('safe-mode');
  });

  it('ask on Write returns ask and does not execute', () => {
    const verdict = evaluatePolicy({
      invocation: invocation({ toolName: 'Write', normalizedInput: { path: '/tmp/a.txt' } }),
      mode: 'ask',
      standingRules: [],
    });
    expect(verdict.kind).toBe('ask');
  });

  it('allow-all allows Write unless a require-approval standing rule matches', () => {
    const allowed = evaluatePolicy({
      invocation: invocation({ toolName: 'Write', normalizedInput: { path: '/tmp/a.txt' } }),
      mode: 'allow-all',
      standingRules: [],
    });
    expect(allowed).toEqual({ kind: 'allow', reason: 'allow-all' });
  });

  it('standing allow matches only the exact tool and target', () => {
    const rule = standingRule({
      effect: 'allow',
      toolName: 'Write',
      target: '/tmp/a.txt',
    });
    const matched = evaluatePolicy({
      invocation: invocation({ toolName: 'Write', normalizedInput: { path: '/tmp/a.txt' } }),
      mode: 'ask',
      standingRules: [rule],
    });
    expect(matched).toEqual({ kind: 'allow', reason: 'standing-allow' });

    const otherTarget = evaluatePolicy({
      invocation: invocation({
        toolName: 'Write',
        normalizedInput: { path: '/tmp/b.txt' },
        target: { kind: 'path', value: '/tmp/b.txt', fingerprint: 'fp_b' },
      }),
      mode: 'ask',
      standingRules: [rule],
    });
    expect(otherTarget.kind).toBe('ask');
  });

  it('require-approval standing rule pauses even in allow-all', () => {
    const verdict = evaluatePolicy({
      invocation: invocation({ toolName: 'Write', normalizedInput: { path: '/tmp/a.txt' } }),
      mode: 'allow-all',
      standingRules: [standingRule({ effect: 'require-approval', toolName: 'Write', target: '/tmp/a.txt' })],
    });
    expect(verdict.kind).toBe('ask');
  });

  it('handoff-shaped invocation uses the supplied botId for standing rules', () => {
    const targetRule = standingRule({
      ruleId: 'rule_target',
      botId: 'bot_target',
      effect: 'allow',
      toolName: 'Write',
      target: '/tmp/a.txt',
    });
    const sourceRule = standingRule({
      ruleId: 'rule_source',
      botId: 'bot_source',
      effect: 'allow',
      toolName: 'Write',
      target: '/tmp/a.txt',
    });
    const matched = evaluatePolicy({
      invocation: invocation({
        botId: 'bot_target',
        toolName: 'Write',
        normalizedInput: { path: '/tmp/a.txt', sourceBotId: 'bot_source' },
      }),
      mode: 'ask',
      standingRules: [targetRule],
    });
    expect(matched).toEqual({ kind: 'allow', reason: 'standing-allow' });

    const bypass = evaluatePolicy({
      invocation: invocation({
        botId: 'bot_target',
        toolName: 'Write',
        normalizedInput: { path: '/tmp/a.txt', sourceBotId: 'bot_source' },
      }),
      mode: 'ask',
      standingRules: [sourceRule],
    });
    expect(bypass.kind).toBe('ask');
  });
});
