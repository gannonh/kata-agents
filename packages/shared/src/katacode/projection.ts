import type {
  KatacodeAttempt,
  KatacodeTaskCardView,
  KatacodeTaskRailView,
  SpawnTask,
} from '@kata-sh/core';
import { projectKatacodeCanonicalState } from './mapping.ts';

const PREVIEW_CHARS = 280;

function preview(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= PREVIEW_CHARS ? trimmed : `${trimmed.slice(0, PREVIEW_CHARS - 1)}…`;
}

export function projectKatacodeTaskCard(input: {
  readonly task: SpawnTask;
  readonly attempt: KatacodeAttempt;
  readonly ownerBotName: string;
  readonly unread: boolean;
}): KatacodeTaskCardView {
  const canonical = projectKatacodeCanonicalState({
    attempt: input.attempt,
    runtimeState: input.task.runtimeState,
  });
  return {
    taskId: input.task.taskId,
    conversationId: input.attempt.conversationId,
    ownerBotName: input.ownerBotName,
    repositoryLabel: input.attempt.worktree.repositoryLabel,
    branchLabel: input.attempt.worktree.branchLabel,
    runtimeState: canonical.runtimeState,
    attemptState: input.attempt.state,
    promptPreview: preview(input.task.delegatedPrompt),
    progressPercent: input.attempt.status?.progressPercent,
    tests: input.attempt.status?.tests,
    reconciliationRequired: canonical.reconciliationRequired,
    unread: input.unread,
    actions: canonical.actions,
    resultPreview: input.task.result?.preview,
    failureMessage: input.task.failure?.message ?? input.attempt.failureMessage,
  };
}

export function projectKatacodeTaskRail(input: {
  readonly task: SpawnTask;
  readonly attempt: KatacodeAttempt;
  readonly ownerBotName: string;
  readonly unread: boolean;
  readonly journalSequence: number;
  readonly acceptanceCriteria: string;
}): KatacodeTaskRailView {
  const card = projectKatacodeTaskCard(input);
  return {
    ...card,
    worktreePolicy: input.attempt.worktree.policy,
    prompt: input.task.delegatedPrompt,
    acceptanceCriteria: input.acceptanceCriteria,
    evidence: input.attempt.status?.evidence ?? [],
    artifacts: input.attempt.artifacts?.artifacts ?? [],
    pullRequest: input.attempt.artifacts?.pullRequest,
    diffSummary: input.attempt.artifacts?.diffSummary,
    deepLink: input.attempt.deepLink,
    freshness: {
      taskVersion: input.task.version,
      attemptId: input.attempt.attemptId,
      journalSequence: input.journalSequence,
    },
  };
}
