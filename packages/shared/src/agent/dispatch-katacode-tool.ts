import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { DispatchKatacodeHelpResult, DispatchKatacodeResult } from './base-agent.ts';

export type DispatchKatacodeFn = (
  input: Record<string, unknown>,
) => Promise<DispatchKatacodeResult | DispatchKatacodeHelpResult>;

function errorResponse(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

export interface DispatchKatacodeToolOptions {
  getDispatchKatacodeFn: () => DispatchKatacodeFn | undefined;
}

export function createDispatchKatacodeTool(options: DispatchKatacodeToolOptions) {
  return tool(
    'dispatch_katacode',
    `Dispatch development work to Katacode from this Bot conversation.

The request must include a repository label, a self-contained prompt, and observable acceptance criteria.
Identity is derived from the current Bot session. Never pass workspace, Bot, conversation, path, credential, or recipient fields.
Isolated worktrees are the default. Shared checkout requires an explicit opaque worktree id and later approval.
A successful dispatch returns exactly \`{ taskId, runtimeState, version, attemptId }\`.`,
    {
      help: z.boolean().optional()
        .describe('If true, returns usage guidance instead of dispatching to Katacode'),
      repository: z.string().optional()
        .describe('Server-resolved repository label (not a path)'),
      prompt: z.string().optional()
        .describe('Self-contained development request for Katacode'),
      acceptanceCriteria: z.string().optional()
        .describe('Observable acceptance criteria Katacode must verify'),
      permissionMode: z.enum(['safe', 'ask', 'allow-all']).optional()
        .describe('Permission mode for the dispatched work'),
      worktreePolicy: z.enum(['isolated', 'shared']).optional()
        .describe('Worktree policy. Isolated is the default.'),
      sharedWorktreeId: z.string().optional()
        .describe('Opaque managed worktree id required when worktreePolicy is shared'),
      workspaceId: z.never().optional(),
      botId: z.never().optional(),
      conversationId: z.never().optional(),
      checkoutPath: z.never().optional(),
      credential: z.never().optional(),
      recipient: z.never().optional(),
      runtimeId: z.never().optional(),
      sessionId: z.never().optional(),
      callback: z.never().optional(),
    },
    async (args) => {
      const dispatch = options.getDispatchKatacodeFn();
      if (!dispatch) return errorResponse('dispatch_katacode is not available in this context.');
      try {
        const result = await dispatch(args as Record<string, unknown>);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const failure = (error && typeof error === 'object' && 'failure' in error)
          ? error.failure
          : undefined;
        if (failure && typeof failure === 'object') {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(failure, null, 2) }],
            isError: true,
          };
        }
        if (error instanceof Error) {
          return errorResponse(`dispatch_katacode failed: ${error.message}`);
        }
        throw error;
      }
    },
  );
}
