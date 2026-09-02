import { randomUUID } from 'node:crypto';
import type {
  JournalEntry,
  KatacodeAdapter,
  KatacodeAttempt,
  KatacodeDispatchRequest,
  KatacodeTaskCardView,
  KatacodeTaskRailView,
  SpawnTask,
  SpawnTaskFailureCode,
} from '@kata-sh/core';
import { KATACODE_ADAPTER_CONTRACT_VERSION } from '@kata-sh/core';
import type { ConversationJournal } from '../conversations/journal.ts';
import { createSpawnTaskFailure } from '../spawn-tasks/failures.ts';
import { SpawnTaskStore } from '../spawn-tasks/store.ts';
import { isSpawnTaskTerminal } from '../spawn-tasks/transitions.ts';
import { KatacodeAttemptError, KatacodeAttemptStore } from './attempts.ts';
import { projectKatacodeCanonicalState, retryBlockedByUncertain } from './mapping.ts';
import { projectKatacodeTaskCard, projectKatacodeTaskRail } from './projection.ts';
import type { ResolvedKatacodeIdentity } from './identity.ts';
import {
  SharedWorktreeRequiresApprovalError,
  type KatacodeWorktreeAllocator,
} from './worktree.ts';

export interface KatacodeJournalSink {
  appendTask(input: {
    readonly conversationId: string;
    readonly authorBotId: string;
    readonly taskId: string;
    readonly idempotencyKey: string;
    readonly body: string;
  }): JournalEntry;
}

export interface KatacodeBridgeOptions {
  readonly workspaceId: string;
  readonly taskStore: SpawnTaskStore;
  readonly attempts: KatacodeAttemptStore;
  readonly adapter: KatacodeAdapter;
  readonly worktrees: KatacodeWorktreeAllocator;
  readonly journal: KatacodeJournalSink | ConversationJournal;
  readonly resolveBotName: (botId: string) => string;
  readonly authorize?: (input: {
    readonly identity: ResolvedKatacodeIdentity;
    readonly worktreePolicy: 'isolated' | 'shared';
  }) => Promise<'allow' | 'ask' | 'block'>;
}

export interface KatacodeDispatchResult {
  readonly taskId: string;
  readonly runtimeState: SpawnTask['runtimeState'];
  readonly version: number;
  readonly attemptId: string;
}

export class KatacodeExecutionBridge {
  private readonly workspaceId: string;
  private readonly taskStore: SpawnTaskStore;
  private readonly attempts: KatacodeAttemptStore;
  private readonly adapter: KatacodeAdapter;
  private readonly worktrees: KatacodeWorktreeAllocator;
  private readonly journal: KatacodeJournalSink;
  private readonly resolveBotName: (botId: string) => string;
  private readonly authorize?: KatacodeBridgeOptions['authorize'];

  constructor(options: KatacodeBridgeOptions) {
    this.workspaceId = options.workspaceId;
    this.taskStore = options.taskStore;
    this.attempts = options.attempts;
    this.adapter = options.adapter;
    this.worktrees = options.worktrees;
    this.journal = adaptJournal(options.journal);
    this.resolveBotName = options.resolveBotName;
    this.authorize = options.authorize;
  }

  async dispatch(input: {
    readonly identity: ResolvedKatacodeIdentity;
    readonly clientIdempotencyKey: string;
    readonly sharedApproved?: boolean;
  }): Promise<KatacodeDispatchResult> {
    const existing = this.attempts.getByIdempotencyKey(
      input.identity.conversationId,
      input.clientIdempotencyKey,
    );
    if (existing) {
      const task = this.taskStore.get(existing.taskId);
      if (task) return this.snapshot(task.taskId, existing.attemptId);
    }

    if (input.identity.worktreePolicy === 'shared' && !input.sharedApproved) {
      throw new SharedWorktreeRequiresApprovalError('Shared checkout requires an explicit warning and approval');
    }
    if (this.authorize) {
      const verdict = await this.authorize({
        identity: input.identity,
        worktreePolicy: input.identity.worktreePolicy,
      });
      if (verdict === 'block') throw new Error('Katacode dispatch is blocked by the current permission mode');
      if (verdict === 'ask') throw new Error('Katacode dispatch requires approval');
    }

    const task = this.taskStore.reserveForKatacode(
      { conversationId: input.identity.conversationId, ownerBotId: input.identity.ownerBotId },
      {
        parentSessionId: input.identity.parentSessionId,
        delegatedPrompt: input.identity.prompt,
        childConfig: {
          origin: 'katacode',
          conversationId: input.identity.conversationId,
          ownerBotId: input.identity.ownerBotId,
          repositoryLabel: input.identity.repositoryLabel,
          acceptanceCriteria: input.identity.acceptanceCriteria,
          permissionMode: input.identity.permissionMode,
          worktreePolicy: input.identity.worktreePolicy,
        },
      },
    );

    const worktree = input.identity.worktreePolicy === 'shared' && input.identity.sharedWorktreeId
      ? await this.worktrees.acquireSharedLease({
        workspaceId: this.workspaceId,
        ownerTaskId: task.taskId,
        ownerSessionId: input.identity.parentSessionId,
        managedWorktreeId: input.identity.sharedWorktreeId,
        repositoryLabel: input.identity.repositoryLabel,
      })
      : await this.worktrees.allocateIsolated({
        workspaceId: this.workspaceId,
        ownerTaskId: task.taskId,
        ownerSessionId: input.identity.parentSessionId,
        repositoryLabel: input.identity.repositoryLabel,
      });

    const attempt = this.attempts.createPending({
      taskId: task.taskId,
      conversationId: input.identity.conversationId,
      ownerBotId: input.identity.ownerBotId,
      clientIdempotencyKey: input.clientIdempotencyKey,
      worktree: worktree.summary,
      taskVersion: task.version,
    });

    this.journal.appendTask({
      conversationId: input.identity.conversationId,
      authorBotId: input.identity.ownerBotId,
      taskId: task.taskId,
      idempotencyKey: `katacode.${task.taskId}.requested`,
      body: JSON.stringify({ type: 'katacode-requested', taskId: task.taskId, attemptId: attempt.attemptId }),
    });

    const request: KatacodeDispatchRequest = {
      contractVersion: KATACODE_ADAPTER_CONTRACT_VERSION,
      idempotencyKey: input.clientIdempotencyKey,
      prompt: input.identity.prompt,
      acceptanceCriteria: input.identity.acceptanceCriteria,
      permissionMode: input.identity.permissionMode,
      worktree: worktree.summary,
    };

    this.attempts.transition(task.taskId, attempt.attemptId, attempt.fence.attemptNonce, 'sent');
    this.taskStore.transition(task.taskId, { runtimeState: 'processing', at: now() });

    let acceptance;
    try {
      acceptance = await this.adapter.dispatch(request);
    } catch {
      this.attempts.transition(task.taskId, attempt.attemptId, attempt.fence.attemptNonce, 'uncertain');
      return this.snapshot(task.taskId, attempt.attemptId);
    }

    if (acceptance.kind === 'uncertain') {
      this.attempts.transition(task.taskId, attempt.attemptId, attempt.fence.attemptNonce, 'uncertain');
      return this.snapshot(task.taskId, attempt.attemptId);
    }
    if (acceptance.kind === 'rejected') {
      this.markFailed(task.taskId, attempt, 'provider_error', acceptance.reason, true);
      return this.snapshot(task.taskId, attempt.attemptId);
    }

    this.attempts.transition(task.taskId, attempt.attemptId, attempt.fence.attemptNonce, 'acknowledged', {
      runRef: acceptance.runRef,
    });
    return this.snapshot(task.taskId, attempt.attemptId);
  }

  async reconcile(taskId: string): Promise<KatacodeDispatchResult> {
    const attempt = this.requireCurrent(taskId);
    if (attempt.state !== 'uncertain' && attempt.state !== 'sent' && attempt.state !== 'acknowledged') {
      return this.snapshot(taskId, attempt.attemptId);
    }
    const lookup = await this.adapter.lookupByIdempotencyKey(attempt.clientIdempotencyKey);
    if (lookup.kind === 'uncertain') {
      if (attempt.state !== 'uncertain') {
        this.attempts.transition(taskId, attempt.attemptId, attempt.fence.attemptNonce, 'uncertain');
      }
      return this.snapshot(taskId, attempt.attemptId);
    }
    if (lookup.kind === 'absent') {
      this.markFailed(taskId, attempt, 'dispatch_interrupted', 'Katacode has no record of this dispatch', true);
      return this.snapshot(taskId, attempt.attemptId);
    }
    this.attempts.transition(taskId, attempt.attemptId, attempt.fence.attemptNonce, 'acknowledged', {
      runRef: lookup.runRef,
      status: lookup.status,
    });
    return this.applyProviderStatus(taskId, lookup.runRef);
  }

  async refresh(taskId: string): Promise<KatacodeDispatchResult> {
    const attempt = this.requireCurrent(taskId);
    if (!attempt.runRef) return this.reconcile(taskId);
    return this.applyProviderStatus(taskId, attempt.runRef);
  }

  async cancel(taskId: string, reason: string): Promise<KatacodeDispatchResult> {
    const task = this.requireTask(taskId);
    const attempt = this.requireCurrent(taskId);
    if (attempt.state === 'uncertain') {
      throw new KatacodeAttemptError('uncertain_blocks_retry', 'Cancel is unavailable while acceptance is uncertain');
    }
    if (isSpawnTaskTerminal(task.runtimeState)) return this.snapshot(taskId, attempt.attemptId);
    if (attempt.runRef) {
      const result = await this.adapter.cancel(attempt.runRef);
      if (result.kind === 'uncertain') {
        this.attempts.transition(taskId, attempt.attemptId, attempt.fence.attemptNonce, 'uncertain');
        return this.snapshot(taskId, attempt.attemptId);
      }
      if (result.kind === 'already-terminal') {
        return this.applyProviderStatus(taskId, attempt.runRef);
      }
    }
    const requested = this.taskStore.requestCancellation(taskId, now(), reason);
    const current = this.requireTask(taskId);
    if (!isSpawnTaskTerminal(current.runtimeState) && requested.cancellation) {
      this.taskStore.transition(taskId, {
        runtimeState: 'cancelled',
        at: now(),
        cancellation: requested.cancellation,
      });
    }
    if (attempt.state !== 'reconciled' && attempt.state !== 'failed') {
      this.attempts.transition(taskId, attempt.attemptId, attempt.fence.attemptNonce, 'reconciled');
    }
    this.publishTerminal(taskId, attempt);
    return this.snapshot(taskId, attempt.attemptId);
  }

  async retry(taskId: string, identity: ResolvedKatacodeIdentity): Promise<KatacodeDispatchResult> {
    const attempt = this.requireCurrent(taskId);
    if (retryBlockedByUncertain(attempt)) {
      throw new KatacodeAttemptError('uncertain_blocks_retry', 'Retry is unavailable while acceptance is uncertain');
    }
    const task = this.requireTask(taskId);
    if (task.runtimeState !== 'failed') {
      throw new KatacodeAttemptError('illegal_transition', 'Retry requires a terminal failed task');
    }
    return this.dispatch({
      identity,
      clientIdempotencyKey: `${attempt.clientIdempotencyKey}::retry::${randomUUID()}`,
      sharedApproved: identity.worktreePolicy === 'shared',
    });
  }

  card(taskId: string, unread = false): KatacodeTaskCardView {
    const task = this.requireTask(taskId);
    const attempt = this.requireCurrent(taskId);
    return projectKatacodeTaskCard({
      task,
      attempt,
      ownerBotName: this.resolveBotName(attempt.ownerBotId),
      unread,
    });
  }

  rail(taskId: string, journalSequence: number, unread = false): KatacodeTaskRailView {
    const task = this.requireTask(taskId);
    const attempt = this.requireCurrent(taskId);
    const acceptanceCriteria = typeof task.childConfig.acceptanceCriteria === 'string'
      ? task.childConfig.acceptanceCriteria
      : '';
    return projectKatacodeTaskRail({
      task,
      attempt,
      ownerBotName: this.resolveBotName(attempt.ownerBotId),
      unread,
      journalSequence,
      acceptanceCriteria,
    });
  }

  listConversationCards(conversationId: string): KatacodeTaskCardView[] {
    return this.taskStore.listByConversation(conversationId).flatMap((task) => {
      const attempt = this.attempts.currentForTask(task.taskId);
      if (!attempt) return [];
      return [projectKatacodeTaskCard({
        task,
        attempt,
        ownerBotName: this.resolveBotName(attempt.ownerBotId),
        unread: task.resultReadAt === undefined && task.runtimeState === 'completed',
      })];
    });
  }

  private async applyProviderStatus(
    taskId: string,
    runRef: { readonly runId: string },
  ): Promise<KatacodeDispatchResult> {
    const attempt = this.requireCurrent(taskId);
    const status = await this.adapter.getStatusAndResult(runRef);
    const artifacts = status.status.phase === 'completed'
      ? await this.adapter.getArtifactsAndPullRequest(runRef)
      : attempt.artifacts;
    const deepLink = await this.adapter.getDeepLink(runRef);
    this.attempts.transition(
      taskId,
      attempt.attemptId,
      attempt.fence.attemptNonce,
      attempt.state === 'uncertain' ? 'acknowledged' : attempt.state,
      { runRef, status: status.status, artifacts, deepLink },
    );
    const latest = this.requireCurrent(taskId);
    const canonical = projectKatacodeCanonicalState({
      attempt: latest,
      lookup: { kind: 'found', runRef, status: status.status },
      runtimeState: this.requireTask(taskId).runtimeState,
    });
    if (canonical.runtimeState === 'completed') {
      this.taskStore.commitResult(taskId, status.resultMarkdown ?? '', { committedAt: now() });
      this.attempts.transition(taskId, latest.attemptId, latest.fence.attemptNonce, 'reconciled');
      this.publishTerminal(taskId, latest);
    } else if (canonical.runtimeState === 'failed') {
      this.markFailed(taskId, latest, canonical.failureCode ?? 'provider_error', status.failureMessage ?? 'Katacode run failed', true);
    } else if (canonical.runtimeState === 'cancelled') {
      const requested = this.taskStore.requestCancellation(taskId, now(), 'provider_cancelled');
      if (requested.cancellation && !isSpawnTaskTerminal(this.requireTask(taskId).runtimeState)) {
        this.taskStore.transition(taskId, {
          runtimeState: 'cancelled',
          at: now(),
          cancellation: requested.cancellation,
        });
      }
      this.attempts.transition(taskId, latest.attemptId, latest.fence.attemptNonce, 'reconciled');
      this.publishTerminal(taskId, latest);
    } else if (this.requireTask(taskId).runtimeState === 'queued') {
      this.taskStore.transition(taskId, { runtimeState: 'processing', at: now() });
    }
    return this.snapshot(taskId, latest.attemptId);
  }

  private markFailed(
    taskId: string,
    attempt: KatacodeAttempt,
    code: SpawnTaskFailureCode,
    message: string,
    retryable: boolean,
  ): void {
    const current = this.requireTask(taskId);
    if (!isSpawnTaskTerminal(current.runtimeState)) {
      this.taskStore.transition(taskId, {
        runtimeState: 'failed',
        at: now(),
        failure: createSpawnTaskFailure({
          code,
          message,
          retryable,
          committedAt: now(),
        }),
      });
    }
    if (attempt.state !== 'failed' && attempt.state !== 'reconciled') {
      // Authoritative provider rejection after a run exists is reconciled, not
      // a never-accepted `failed` attempt. Dispatch-time rejection and
      // lookup-absent stay `failed`.
      const next = attempt.runRef ? 'reconciled' : 'failed';
      this.attempts.transition(taskId, attempt.attemptId, attempt.fence.attemptNonce, next, {
        failureCode: code,
        failureMessage: message,
      });
    }
    this.publishTerminal(taskId, attempt);
  }

  private publishTerminal(taskId: string, attempt: KatacodeAttempt): void {
    const task = this.requireTask(taskId);
    if (!isSpawnTaskTerminal(task.runtimeState)) return;
    this.journal.appendTask({
      conversationId: attempt.conversationId,
      authorBotId: attempt.ownerBotId,
      taskId,
      idempotencyKey: `katacode.${taskId}.terminal`,
      body: JSON.stringify({ type: 'katacode-terminal', taskId, runtimeState: task.runtimeState }),
    });
    this.worktrees.release?.({ ownerTaskId: taskId });
  }

  private snapshot(taskId: string, attemptId: string): KatacodeDispatchResult {
    const task = this.requireTask(taskId);
    return {
      taskId: task.taskId,
      runtimeState: task.runtimeState,
      version: task.version,
      attemptId,
    };
  }

  private requireTask(taskId: string): SpawnTask {
    const task = this.taskStore.get(taskId);
    if (!task) throw new Error(`Spawned task not found: ${taskId}`);
    return task;
  }

  private requireCurrent(taskId: string): KatacodeAttempt {
    const attempt = this.attempts.currentForTask(taskId);
    if (!attempt) throw new Error(`Katacode attempt not found for ${taskId}`);
    return attempt;
  }
}

function adaptJournal(journal: KatacodeJournalSink | ConversationJournal): KatacodeJournalSink {
  if ('appendTask' in journal) return journal;
  return {
    appendTask(input) {
      return journal.append({
        conversationId: input.conversationId,
        authorBotId: input.authorBotId,
        taskId: input.taskId,
        kind: 'task',
        idempotencyKey: input.idempotencyKey,
        body: input.body,
      });
    },
  };
}

function now(): string {
  return new Date().toISOString();
}

export function mintKatacodeIdempotencyKey(): string {
  return `katacode_${randomUUID()}`;
}
