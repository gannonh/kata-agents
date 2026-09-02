import type {
  KatacodeAttempt,
  KatacodeAttemptState,
  KatacodeCanonicalProjection,
  KatacodeLookupResult,
  KatacodePublicAction,
  KatacodeProviderStatus,
} from '@kata-sh/core';
import { isSpawnTaskTerminal } from '../spawn-tasks/transitions.ts';
import type { SpawnTaskRuntimeState } from '@kata-sh/core';

const ATTEMPT_ORDER: readonly KatacodeAttemptState[] = [
  'pending',
  'sent',
  'acknowledged',
  'uncertain',
  'reconciled',
  'failed',
];

export function canAdvanceKatacodeAttempt(
  current: KatacodeAttemptState,
  next: KatacodeAttemptState,
): boolean {
  if (current === next) return true;
  if (current === 'reconciled' || current === 'failed') return false;
  if (next === 'uncertain') return current === 'pending' || current === 'sent' || current === 'acknowledged';
  if (next === 'reconciled') return current === 'sent' || current === 'acknowledged' || current === 'uncertain';
  if (next === 'failed') return current === 'pending' || current === 'sent' || current === 'uncertain';
  return ATTEMPT_ORDER.indexOf(next) === ATTEMPT_ORDER.indexOf(current) + 1;
}

export function projectKatacodeCanonicalState(input: {
  readonly attempt: KatacodeAttempt;
  readonly lookup?: KatacodeLookupResult;
  readonly runtimeState: SpawnTaskRuntimeState;
}): KatacodeCanonicalProjection {
  const { attempt, lookup, runtimeState } = input;
  if (attempt.state === 'pending') {
    return {
      runtimeState: 'queued',
      retryable: false,
      reconciliationRequired: false,
      actions: actionsFor('queued', 'pending'),
    };
  }

  if (attempt.state === 'uncertain' || lookup?.kind === 'uncertain') {
    return {
      runtimeState: 'processing',
      retryable: false,
      reconciliationRequired: true,
      actions: actionsFor('processing', 'uncertain'),
    };
  }

  if (lookup?.kind === 'found') {
    return projectFromProvider(lookup.status, runtimeState);
  }

  if (lookup?.kind === 'absent' && attempt.state === 'sent') {
    return {
      runtimeState: 'failed',
      failureCode: 'dispatch_interrupted',
      retryable: true,
      reconciliationRequired: false,
      actions: actionsFor('failed', 'failed'),
    };
  }

  if (attempt.state === 'sent' || attempt.state === 'acknowledged') {
    return {
      runtimeState: 'processing',
      retryable: false,
      reconciliationRequired: false,
      actions: actionsFor('processing', attempt.state),
    };
  }

  if (attempt.state === 'failed' && attempt.failureCode === 'dispatch_interrupted') {
    return {
      runtimeState: 'failed',
      failureCode: 'dispatch_interrupted',
      retryable: true,
      reconciliationRequired: false,
      actions: actionsFor('failed', 'failed'),
    };
  }

  if (attempt.state === 'failed') {
    return {
      runtimeState: 'failed',
      failureCode: attempt.failureCode ?? 'provider_error',
      retryable: attempt.failureCode !== undefined,
      reconciliationRequired: false,
      actions: actionsFor('failed', 'failed'),
    };
  }

  if (isSpawnTaskTerminal(runtimeState)) {
    return {
      runtimeState,
      retryable: runtimeState === 'failed',
      reconciliationRequired: false,
      actions: actionsFor(runtimeState, attempt.state),
    };
  }

  return {
    runtimeState: 'processing',
    retryable: false,
    reconciliationRequired: false,
    actions: actionsFor('processing', attempt.state),
  };
}

function projectFromProvider(
  status: KatacodeProviderStatus,
  runtimeState: SpawnTaskRuntimeState,
): KatacodeCanonicalProjection {
  if (status.phase === 'completed') {
    return {
      runtimeState: 'completed',
      retryable: false,
      reconciliationRequired: false,
      actions: actionsFor('completed', 'reconciled'),
    };
  }
  if (status.phase === 'cancelled') {
    return {
      runtimeState: 'cancelled',
      retryable: false,
      reconciliationRequired: false,
      actions: actionsFor('cancelled', 'reconciled'),
    };
  }
  if (status.phase === 'failed') {
    return {
      runtimeState: 'failed',
      failureCode: 'provider_error',
      retryable: true,
      reconciliationRequired: false,
      actions: actionsFor('failed', 'reconciled'),
    };
  }
  return {
    runtimeState: runtimeState === 'queued' ? 'processing' : runtimeState,
    retryable: false,
    reconciliationRequired: false,
    actions: actionsFor('processing', 'acknowledged'),
  };
}

export function actionsFor(
  runtimeState: SpawnTaskRuntimeState,
  attemptState: KatacodeAttemptState,
): readonly KatacodePublicAction[] {
  if (attemptState === 'uncertain') return ['read'];
  if (runtimeState === 'completed') return ['open', 'read'];
  if (runtimeState === 'failed') return ['retry', 'open', 'read'];
  if (runtimeState === 'cancelled') return ['open', 'read'];
  if (runtimeState === 'queued' || runtimeState === 'processing' || runtimeState === 'awaiting-input') {
    return ['cancel', 'open'];
  }
  return ['read'];
}

export function retryBlockedByUncertain(attempt: KatacodeAttempt): boolean {
  return attempt.state === 'uncertain';
}
