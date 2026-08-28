/**
 * Send Handoff Tool (send_handoff)
 *
 * Session-scoped tool that hands the current task to another Bot. Identity is
 * derived server-side from the calling session: the model supplies only the
 * target Bot and the request text. The workspace, source Bot, conversation,
 * and child session are resolved by the server coordinator.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { SendHandoffResult, SendHandoffHelpResult } from './base-agent.ts';

export type SendHandoffFn = (input: Record<string, unknown>) => Promise<SendHandoffResult | SendHandoffHelpResult>;

// Tool result type - matches what the SDK expects
type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function errorResponse(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

export interface SendHandoffToolOptions {
  sessionId: string;
  /**
   * Lazy resolver for the send-handoff callback.
   * Called at execution time to get the current callback from the session registry.
   */
  getSendHandoffFn: () => SendHandoffFn | undefined;
}

export function createSendHandoffTool(options: SendHandoffToolOptions) {
  return tool(
    'send_handoff',
    `Hand the current task to another Bot in this workspace. The receiving Bot runs the request as an independent delegated task with its own model, permission mode, and memory.

The request must be self-contained: the receiving Bot does not see this conversation.
Identity is derived from the current session — never pass workspace, Bot, or conversation fields.
A successful handoff returns exactly \`{ handoffId, deliveryId, taskId, runtimeState, version, targetBotId }\`.`,
    {
      help: z.boolean().optional()
        .describe('If true, returns usage guidance instead of creating a handoff'),
      targetBot: z.string().optional()
        .describe('Target Bot name or ID (required when not in help mode)'),
      request: z.string().optional()
        .describe('Self-contained request for the receiving Bot (required when not in help mode, max 16KB)'),
    },
    async (args) => {
      const sendHandoffFn = options.getSendHandoffFn();
      if (!sendHandoffFn) {
        return errorResponse('send_handoff is not available in this context.');
      }

      try {
        const result = await sendHandoffFn(args as Record<string, unknown>);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const failure = (error && typeof error === 'object' && 'failure' in error)
          ? (error as { failure?: unknown }).failure
          : undefined
        if (failure && typeof failure === 'object') {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(failure, null, 2) }],
            isError: true,
          }
        }
        if (error instanceof Error) {
          return errorResponse(`send_handoff failed: ${error.message}`);
        }
        throw error;
      }
    }
  );
}
