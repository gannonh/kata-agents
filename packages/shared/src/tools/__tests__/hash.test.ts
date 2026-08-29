import { describe, expect, it } from 'bun:test';
import type { ToolInvocation } from '@kata-sh/core';
import { computeOperationHash, sanitizeOperation } from '../index.ts';

function invocation(overrides: Partial<ToolInvocation> = {}): ToolInvocation {
  return {
    workspaceId: 'ws_1',
    botId: 'bot_1',
    conversationId: 'chat_1',
    runtimeId: 'rt_1',
    toolName: 'Write',
    toolSchemaVersion: '1',
    normalizedInput: { path: '/tmp/a.txt', contents: 'hello' },
    attempt: 1,
    target: { kind: 'path', value: '/tmp/a.txt', fingerprint: 'fp_a' },
    policyRevision: 'pol_1',
    ...overrides,
  };
}

describe('operation hash and preview redaction', () => {
  it('changes the operation hash when normalized input changes and ignores preview redaction', () => {
    const base = invocation();
    const original = computeOperationHash(base);
    const changedInput = computeOperationHash(invocation({
      normalizedInput: { path: '/tmp/a.txt', contents: 'hello!' },
    }));
    expect(changedInput).not.toBe(original);

    const withSecret = invocation({
      normalizedInput: { path: '/tmp/a.txt', contents: 'hello', password: 's3cret' },
    });
    const hashedWithSecret = computeOperationHash(withSecret);
    expect(hashedWithSecret).not.toBe(original);

    const preview = sanitizeOperation(
      withSecret.toolName,
      withSecret.target.value,
      withSecret.normalizedInput,
      'write',
    );
    expect(preview.preview).not.toContain('s3cret');
    expect(hashedWithSecret).toBe(computeOperationHash(withSecret));
  });

  it('omits password and token fields from the preview', () => {
    const sanitized = sanitizeOperation(
      'Write',
      '/tmp/a.txt',
      { path: '/tmp/a.txt', password: 'hunter2', token: 'tok_abc', nested: { api_key: 'k', body: 'ok' } },
      'write',
    );
    expect(sanitized.preview).not.toContain('hunter2');
    expect(sanitized.preview).not.toContain('tok_abc');
    expect(sanitized.preview).not.toContain('"k"');
    expect(sanitized.preview).toContain('ok');
    expect(sanitized.preview).toContain('/tmp/a.txt');
  });
});
