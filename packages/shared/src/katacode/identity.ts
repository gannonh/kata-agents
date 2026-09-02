import { BOT_PERMISSION_MODES, KATACODE_LIMITS, type BotPermissionMode } from '@kata-sh/core';
import type { BotTurnContext } from '@kata-sh/core';

const ABSOLUTE_PATH = /^([A-Za-z]:[\\/]|\\\\|\/)/;
const CREDENTIAL_HINT = /(api[_-]?key|token|secret|credential|password)/i;

export interface KatacodeDispatchCallerFields {
  readonly repository?: unknown;
  readonly prompt?: unknown;
  readonly acceptanceCriteria?: unknown;
  readonly permissionMode?: unknown;
  readonly worktreePolicy?: unknown;
  readonly sharedWorktreeId?: unknown;
  readonly workspaceId?: unknown;
  readonly botId?: unknown;
  readonly conversationId?: unknown;
  readonly checkoutPath?: unknown;
  readonly credential?: unknown;
  readonly recipient?: unknown;
}

export interface ResolvedKatacodeIdentity {
  readonly workspaceId: string;
  readonly ownerBotId: string;
  readonly conversationId: string;
  readonly parentSessionId: string;
  readonly permissionMode: BotPermissionMode;
  readonly repositoryLabel: string;
  readonly prompt: string;
  readonly acceptanceCriteria: string;
  readonly worktreePolicy: 'isolated' | 'shared';
  readonly sharedWorktreeId?: string;
}

export class KatacodeIdentityError extends Error {
  readonly code = 'identity_rejected' as const;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function rejectCallerAuthority(input: KatacodeDispatchCallerFields): void {
  if (input.workspaceId !== undefined) throw new KatacodeIdentityError('Callers cannot select a workspace');
  if (input.botId !== undefined) throw new KatacodeIdentityError('Callers cannot select a Bot');
  if (input.conversationId !== undefined) throw new KatacodeIdentityError('Callers cannot select a conversation');
  if (input.checkoutPath !== undefined) throw new KatacodeIdentityError('Callers cannot select a checkout path');
  if (input.credential !== undefined) throw new KatacodeIdentityError('Callers cannot supply a credential');
  if (input.recipient !== undefined) throw new KatacodeIdentityError('Callers cannot select a result recipient');
}

export function resolveKatacodeDispatchIdentity(input: {
  readonly context: BotTurnContext;
  readonly parentSessionId: string;
  readonly fields: KatacodeDispatchCallerFields;
  readonly botPermissionMode: BotPermissionMode;
}): ResolvedKatacodeIdentity {
  rejectCallerAuthority(input.fields);

  const repository = typeof input.fields.repository === 'string' ? input.fields.repository.trim() : '';
  if (!repository) throw new KatacodeIdentityError('repository is required');
  if (ABSOLUTE_PATH.test(repository) || repository.includes('..')) {
    throw new KatacodeIdentityError('repository must be a server-resolved label, not a path');
  }
  if (utf8Bytes(repository) > KATACODE_LIMITS.repositoryLabelBytes) {
    throw new KatacodeIdentityError('repository label exceeds the byte limit');
  }

  const prompt = typeof input.fields.prompt === 'string' ? input.fields.prompt : '';
  if (!prompt.trim()) throw new KatacodeIdentityError('prompt is required');
  if (utf8Bytes(prompt) > KATACODE_LIMITS.promptBytes) {
    throw new KatacodeIdentityError('prompt exceeds the byte limit');
  }
  if (CREDENTIAL_HINT.test(prompt) && /sk-|Bearer\s/i.test(prompt)) {
    throw new KatacodeIdentityError('prompt must not include credentials');
  }

  const acceptanceCriteria = typeof input.fields.acceptanceCriteria === 'string'
    ? input.fields.acceptanceCriteria
    : '';
  if (!acceptanceCriteria.trim()) throw new KatacodeIdentityError('acceptanceCriteria is required');
  if (utf8Bytes(acceptanceCriteria) > KATACODE_LIMITS.acceptanceCriteriaBytes) {
    throw new KatacodeIdentityError('acceptanceCriteria exceeds the byte limit');
  }

  const requestedMode = input.fields.permissionMode;
  if (requestedMode !== undefined) {
    if (typeof requestedMode !== 'string' || !(BOT_PERMISSION_MODES as readonly string[]).includes(requestedMode)) {
      throw new KatacodeIdentityError('permissionMode must be safe, ask, or allow-all');
    }
  }
  const permissionMode = (typeof requestedMode === 'string' ? requestedMode : input.botPermissionMode) as BotPermissionMode;

  const policy = input.fields.worktreePolicy === 'shared' ? 'shared' : 'isolated';
  const sharedWorktreeId = typeof input.fields.sharedWorktreeId === 'string'
    ? input.fields.sharedWorktreeId.trim()
    : undefined;
  if (policy === 'shared' && !sharedWorktreeId) {
    throw new KatacodeIdentityError('shared worktree execution requires an explicit server-issued worktree id');
  }
  if (policy === 'isolated' && sharedWorktreeId) {
    throw new KatacodeIdentityError('isolated worktrees do not accept a shared worktree id');
  }
  if (sharedWorktreeId && (ABSOLUTE_PATH.test(sharedWorktreeId) || sharedWorktreeId.includes('/'))) {
    throw new KatacodeIdentityError('shared worktree id must be opaque');
  }

  return {
    workspaceId: input.context.workspaceId,
    ownerBotId: input.context.botId,
    conversationId: input.context.conversationId,
    parentSessionId: input.parentSessionId,
    permissionMode,
    repositoryLabel: repository,
    prompt,
    acceptanceCriteria,
    worktreePolicy: policy,
    ...(sharedWorktreeId ? { sharedWorktreeId } : {}),
  };
}
