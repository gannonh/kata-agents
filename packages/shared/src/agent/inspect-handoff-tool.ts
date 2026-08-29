import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type {
  InspectHandoffHelpResult,
  InspectHandoffResult,
} from './base-agent.ts';

export type InspectHandoffFn = (
  input: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<InspectHandoffResult | InspectHandoffHelpResult>;

function errorResponse(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

export interface InspectHandoffToolOptions {
  getInspectHandoffFn: () => InspectHandoffFn | undefined;
}

export function createInspectHandoffTool(options: InspectHandoffToolOptions) {
  return tool(
    'inspect_handoff',
    `Read a handoff task owned by the current Bot conversation.

Use action=get for current state, action=wait with afterVersion for a bounded authoritative wait, or action=read-result with byte offset and limit for canonical result chunks.
The server derives workspace, Bot, conversation, runtime, and internal Session identity. Unknown and unauthorized task IDs return the same error.`,
    {
      help: z.boolean().optional(),
      action: z.enum(['get', 'wait', 'read-result']).optional(),
      taskId: z.string().optional(),
      afterVersion: z.number().int().nonnegative().optional(),
      timeoutMs: z.number().nonnegative().optional(),
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().optional(),
      workspaceId: z.never().optional(),
      botId: z.never().optional(),
      conversationId: z.never().optional(),
      runtimeId: z.never().optional(),
      sessionId: z.never().optional(),
      callback: z.never().optional(),
    },
    async (args, extra) => {
      const inspectHandoff = options.getInspectHandoffFn();
      if (!inspectHandoff) return errorResponse('inspect_handoff is not available in this context.');
      try {
        const signal = typeof extra === 'object' && extra !== null && 'signal' in extra
          && extra.signal instanceof AbortSignal
          ? extra.signal
          : undefined;
        const result = await inspectHandoff(args as Record<string, unknown>, signal);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return errorResponse(error instanceof Error ? error.message : String(error));
      }
    },
  );
}
