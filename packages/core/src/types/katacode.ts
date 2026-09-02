/**
 * Versioned Katacode adapter contract and subordinate attempt metadata.
 *
 * SpawnTask remains the canonical task/result authority. Adapter attempts are
 * an internal dispatch history, never a second public lifecycle.
 */

import type { BotPermissionMode } from './bot.ts';
import type { SpawnTaskFailureCode, SpawnTaskRuntimeState } from './spawn-task.ts';

export const KATACODE_ADAPTER_CONTRACT_VERSION = 1 as const;
export const KATACODE_ATTEMPT_SCHEMA_VERSION = 1 as const;

export const KATACODE_ATTEMPT_STATES = [
  'pending',
  'sent',
  'acknowledged',
  'uncertain',
  'reconciled',
  'failed',
] as const;

export type KatacodeAttemptState = (typeof KATACODE_ATTEMPT_STATES)[number];

export const KATACODE_WORKTREE_POLICIES = ['isolated', 'shared'] as const;
export type KatacodeWorktreePolicy = (typeof KATACODE_WORKTREE_POLICIES)[number];

export const KATACODE_PUBLIC_ACTIONS = ['cancel', 'retry', 'open', 'read'] as const;
export type KatacodePublicAction = (typeof KATACODE_PUBLIC_ACTIONS)[number];

export const KATACODE_LIMITS = Object.freeze({
  promptBytes: 64 * 1024,
  acceptanceCriteriaBytes: 16 * 1024,
  idempotencyKeyBytes: 512,
  repositoryLabelBytes: 256,
  branchLabelBytes: 128,
});

/** Internal provider handle. Never projected to cards, journals, or tools. */
export interface KatacodeRunRef {
  readonly runId: string;
}

export interface KatacodeWorktreeSummary {
  readonly policy: KatacodeWorktreePolicy;
  readonly repositoryLabel: string;
  readonly branchLabel: string;
}

export interface KatacodeDispatchRequest {
  readonly contractVersion: typeof KATACODE_ADAPTER_CONTRACT_VERSION;
  readonly idempotencyKey: string;
  readonly prompt: string;
  readonly acceptanceCriteria: string;
  readonly permissionMode: BotPermissionMode;
  readonly worktree: KatacodeWorktreeSummary;
}

export type KatacodeDispatchAcceptance =
  | { readonly kind: 'accepted'; readonly runRef: KatacodeRunRef }
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'uncertain' };

export type KatacodeLookupResult =
  | { readonly kind: 'found'; readonly runRef: KatacodeRunRef; readonly status: KatacodeProviderStatus }
  | { readonly kind: 'absent' }
  | { readonly kind: 'uncertain' };

export type KatacodeProviderPhase = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface KatacodeProviderStatus {
  readonly phase: KatacodeProviderPhase;
  readonly progressPercent?: number;
  readonly tests?: KatacodeTestSummary;
  readonly evidence?: readonly KatacodeEvidenceItem[];
}

export interface KatacodeTestSummary {
  readonly passed: number;
  readonly failed: number;
  readonly total: number;
}

export interface KatacodeEvidenceItem {
  readonly label: string;
  readonly kind: 'log' | 'artifact' | 'diff';
}

export interface KatacodeStatusResult {
  readonly status: KatacodeProviderStatus;
  readonly resultMarkdown?: string;
  readonly failureMessage?: string;
}

export type KatacodeCancelResult =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'already-terminal'; readonly phase: KatacodeProviderPhase }
  | { readonly kind: 'uncertain' };

export interface KatacodePullRequestRef {
  readonly title: string;
  readonly url: string;
  readonly number: number;
}

export interface KatacodeArtifacts {
  readonly artifacts: readonly KatacodeEvidenceItem[];
  readonly pullRequest?: KatacodePullRequestRef;
  readonly diffSummary?: string;
}

export interface KatacodeDeepLink {
  readonly url: string;
}

export interface KatacodeAdapter {
  readonly contractVersion: typeof KATACODE_ADAPTER_CONTRACT_VERSION;
  dispatch(input: KatacodeDispatchRequest): Promise<KatacodeDispatchAcceptance>;
  lookupByIdempotencyKey(key: string): Promise<KatacodeLookupResult>;
  getStatusAndResult(runRef: KatacodeRunRef): Promise<KatacodeStatusResult>;
  cancel(runRef: KatacodeRunRef): Promise<KatacodeCancelResult>;
  getArtifactsAndPullRequest(runRef: KatacodeRunRef): Promise<KatacodeArtifacts>;
  getDeepLink(runRef: KatacodeRunRef): Promise<KatacodeDeepLink>;
}

export interface KatacodeAttemptFence {
  readonly attemptNonce: string;
  readonly taskVersion: number;
}

export interface KatacodeAttempt {
  readonly schemaVersion: typeof KATACODE_ATTEMPT_SCHEMA_VERSION;
  readonly attemptId: string;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly ownerBotId: string;
  readonly clientIdempotencyKey: string;
  readonly state: KatacodeAttemptState;
  readonly fence: KatacodeAttemptFence;
  readonly worktree: KatacodeWorktreeSummary;
  readonly createdAt: string;
  readonly sentAt?: string;
  readonly acknowledgedAt?: string;
  readonly uncertainAt?: string;
  readonly reconciledAt?: string;
  readonly failedAt?: string;
  readonly runRef?: KatacodeRunRef;
  readonly deepLink?: KatacodeDeepLink;
  readonly artifacts?: KatacodeArtifacts;
  readonly status?: KatacodeProviderStatus;
  readonly failureCode?: SpawnTaskFailureCode;
  readonly failureMessage?: string;
}

export interface KatacodeCanonicalProjection {
  readonly runtimeState: SpawnTaskRuntimeState;
  readonly failureCode?: SpawnTaskFailureCode;
  readonly retryable: boolean;
  readonly reconciliationRequired: boolean;
  readonly actions: readonly KatacodePublicAction[];
}

export interface KatacodeTaskCardView {
  readonly taskId: string;
  readonly conversationId: string;
  readonly ownerBotName: string;
  readonly repositoryLabel: string;
  readonly branchLabel: string;
  readonly runtimeState: SpawnTaskRuntimeState;
  readonly attemptState: KatacodeAttemptState;
  readonly promptPreview: string;
  readonly progressPercent?: number;
  readonly tests?: KatacodeTestSummary;
  readonly reconciliationRequired: boolean;
  readonly unread: boolean;
  readonly actions: readonly KatacodePublicAction[];
  readonly resultPreview?: string;
  readonly failureMessage?: string;
}

export interface KatacodeTaskRailView {
  readonly taskId: string;
  readonly conversationId: string;
  readonly ownerBotName: string;
  readonly repositoryLabel: string;
  readonly branchLabel: string;
  readonly worktreePolicy: KatacodeWorktreePolicy;
  readonly runtimeState: SpawnTaskRuntimeState;
  readonly attemptState: KatacodeAttemptState;
  readonly prompt: string;
  readonly acceptanceCriteria: string;
  readonly progressPercent?: number;
  readonly tests?: KatacodeTestSummary;
  readonly evidence: readonly KatacodeEvidenceItem[];
  readonly artifacts: readonly KatacodeEvidenceItem[];
  readonly pullRequest?: KatacodePullRequestRef;
  readonly diffSummary?: string;
  readonly deepLink?: KatacodeDeepLink;
  readonly reconciliationRequired: boolean;
  readonly unread: boolean;
  readonly actions: readonly KatacodePublicAction[];
  readonly resultPreview?: string;
  readonly failureMessage?: string;
  readonly freshness: {
    readonly taskVersion: number;
    readonly attemptId: string;
    readonly journalSequence: number;
  };
}

export interface KatacodeInvalidatedEvent {
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly taskId: string;
  readonly taskVersion: number;
  readonly attemptId: string;
  readonly journalSequence: number;
}
