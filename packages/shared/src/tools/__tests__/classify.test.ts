import { describe, expect, it } from 'bun:test';
import type { ToolConsequenceClass, ToolSideEffect } from '@kata-sh/core';
import { classifyTool } from '../index.ts';

describe('tool consequence classifier', () => {
  it('classifies conformance examples and treats unknown tools as consequential', () => {
    const cases: ReadonlyArray<{
      toolName: string;
      input: Record<string, unknown>;
      class: ToolConsequenceClass;
      sideEffect: ToolSideEffect;
    }> = [
      { toolName: 'Read', input: { file_path: '/tmp/a' }, class: 'read', sideEffect: 'read' },
      { toolName: 'Glob', input: { pattern: '*.ts' }, class: 'read', sideEffect: 'read' },
      { toolName: 'Grep', input: { pattern: 'foo' }, class: 'read', sideEffect: 'read' },
      { toolName: 'inspect_handoff', input: { handoffId: 'h1' }, class: 'read', sideEffect: 'read' },
      { toolName: 'call_llm', input: { prompt: 'hi' }, class: 'read', sideEffect: 'read' },
      { toolName: 'Write', input: { path: '/tmp/a' }, class: 'consequential', sideEffect: 'write' },
      { toolName: 'Edit', input: { path: '/tmp/a' }, class: 'consequential', sideEffect: 'write' },
      { toolName: 'MultiEdit', input: { path: '/tmp/a' }, class: 'consequential', sideEffect: 'write' },
      { toolName: 'NotebookEdit', input: { notebook_path: '/tmp/a.ipynb' }, class: 'consequential', sideEffect: 'write' },
      { toolName: 'send_handoff', input: { targetBot: 'bot_1' }, class: 'consequential', sideEffect: 'send' },
      { toolName: 'dispatch_katacode', input: { repository: 'demo', prompt: 'fix', acceptanceCriteria: 'tests pass' }, class: 'consequential', sideEffect: 'send' },
      { toolName: 'spawn_session', input: { prompt: 'go' }, class: 'consequential', sideEffect: 'send' },
      { toolName: 'mcp__blog__publish_post', input: { method: 'POST' }, class: 'consequential', sideEffect: 'publish' },
      { toolName: 'mcp__store__purchase_item', input: { method: 'POST' }, class: 'consequential', sideEffect: 'purchase' },
      { toolName: 'Delete', input: { path: '/tmp/a' }, class: 'consequential', sideEffect: 'delete' },
      { toolName: 'source_oauth_trigger', input: { sourceSlug: 'gmail' }, class: 'consequential', sideEffect: 'credential' },
      { toolName: 'source_credential_prompt', input: { sourceSlug: 'api' }, class: 'consequential', sideEffect: 'credential' },
      { toolName: 'update_user_preferences', input: { theme: 'dark' }, class: 'consequential', sideEffect: 'permission' },
      { toolName: 'set_session_status', input: { status: 'done' }, class: 'consequential', sideEffect: 'permission' },
      { toolName: 'Bash', input: { command: 'git push origin main' }, class: 'consequential', sideEffect: 'git' },
      { toolName: 'Bash', input: { command: 'ls -la' }, class: 'consequential', sideEffect: 'shell' },
      { toolName: 'KillShell', input: { shell_id: 's1' }, class: 'consequential', sideEffect: 'shell' },
      { toolName: 'browser_snapshot', input: {}, class: 'read', sideEffect: 'read' },
      { toolName: 'browser_tool', input: { command: 'accessibility' }, class: 'read', sideEffect: 'read' },
      { toolName: 'browser_navigate', input: {}, class: 'consequential', sideEffect: 'browser' },
      { toolName: 'browser_tool', input: { command: ['click', '@e1'] }, class: 'consequential', sideEffect: 'browser' },
      { toolName: 'mystery_adapter', input: { foo: 1 }, class: 'consequential', sideEffect: 'write' },
    ];

    for (const example of cases) {
      expect(classifyTool(example.toolName, example.input)).toEqual({
        class: example.class,
        sideEffect: example.sideEffect,
      });
    }
  });
});
