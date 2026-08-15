import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SPAWN_TASK_CANONICAL_FIXTURE, type SpawnTask } from '@kata-sh/core';
import {
  assertSpawnTask,
  createSpawnTaskFailure,
  transitionSpawnTask,
  updateSpawnTaskMetadata,
  SpawnTaskStore,
} from '../src/spawn-tasks/index.ts';

const at = '2026-02-03T04:05:06.000Z';
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'spawn-task-domain-'));
  tempRoots.push(root);
  return root;
}

function reservedTask(): SpawnTask {
  return structuredClone(SPAWN_TASK_CANONICAL_FIXTURE.tasks.reserved) as SpawnTask;
}

describe('spawn-task runtime transitions', () => {
  it('moves queued work to processing with a monotonic version', () => {
    const next = transitionSpawnTask(reservedTask(), { runtimeState: 'processing', at });

    expect(next.runtimeState).toBe('processing');
    expect(next.version).toBe(2);
    expect(next.stateTimestamps.processingAt).toBe(at);
    expect(next.stateTimestamps.updatedAt).toBe(at);
  });

  it('accepts every legal transition and preserves immutable identity', () => {
    const cancellation = { requestedAt: at, reason: 'requested' } as const;
    const awaitingInput = SPAWN_TASK_CANONICAL_FIXTURE.tasks.awaitingInput.awaitingInput;
    const result = SPAWN_TASK_CANONICAL_FIXTURE.tasks.completed.result;
    const failure = SPAWN_TASK_CANONICAL_FIXTURE.tasks.failed.failure;
    const immutableKeys = ['taskId', 'workspaceId', 'parentSessionId', 'childSessionId'] as const;

    const processing = transitionSpawnTask(reservedTask(), { runtimeState: 'processing', at });
    const awaiting = transitionSpawnTask(processing, { runtimeState: 'awaiting-input', at, awaitingInput });
    const resumed = transitionSpawnTask(awaiting, { runtimeState: 'processing', at });
    expect(transitionSpawnTask(resumed, { runtimeState: 'completed', at, result }).runtimeState).toBe('completed');

    const processingForFailure = transitionSpawnTask(reservedTask(), { runtimeState: 'processing', at });
    expect(transitionSpawnTask(processingForFailure, { runtimeState: 'failed', at, failure }).runtimeState).toBe('failed');
    expect(transitionSpawnTask(
      { ...processingForFailure, cancellation },
      { runtimeState: 'cancelled', at, cancellation },
    ).runtimeState).toBe('cancelled');
    expect(transitionSpawnTask(
      { ...reservedTask(), cancellation },
      { runtimeState: 'cancelled', at, cancellation },
    ).runtimeState).toBe('cancelled');

    const awaitingForFailure = transitionSpawnTask(processingForFailure, { runtimeState: 'awaiting-input', at, awaitingInput });
    const interrupted = transitionSpawnTask(awaitingForFailure, { runtimeState: 'failed', at, failure });
    expect(interrupted.failure?.code).toBe('input_interrupted');
    expect(interrupted.failure?.details?.kind).toBe('authentication');
    const permissionFlowFailure = createSpawnTaskFailure({
      code: 'provider_error',
      message: 'Permission flow failed.',
      retryable: false,
      details: { kind: 'permission' },
      committedAt: at,
    });
    expect(transitionSpawnTask(awaitingForFailure, {
      runtimeState: 'failed',
      at,
      failure: permissionFlowFailure,
    }).failure?.details?.kind).toBe('permission');
    expect(transitionSpawnTask(
      { ...awaitingForFailure, cancellation },
      { runtimeState: 'cancelled', at, cancellation },
    ).runtimeState).toBe('cancelled');

    for (const key of immutableKeys) {
      expect(resumed[key]).toBe(reservedTask()[key]);
    }
  });

  it('rejects illegal and post-terminal transitions', () => {
    const result = SPAWN_TASK_CANONICAL_FIXTURE.tasks.completed.result;
    const cancellation = { requestedAt: at, reason: 'requested' } as const;
    const queued = reservedTask();
    const processing = transitionSpawnTask(queued, { runtimeState: 'processing', at });
    const completed = transitionSpawnTask(processing, { runtimeState: 'completed', at, result });

    expect(() => transitionSpawnTask(queued, { runtimeState: 'completed', at, result })).toThrow('queued -> completed');
    expect(() => transitionSpawnTask(processing, { runtimeState: 'processing', at })).toThrow('processing -> processing');
    expect(() => transitionSpawnTask(completed, { runtimeState: 'cancelled', at, cancellation })).toThrow('completed -> cancelled');
  });
});

describe('spawn-task validation and terminal metadata', () => {
  it('validates every task in the canonical fixture', () => {
    for (const task of Object.values(SPAWN_TASK_CANONICAL_FIXTURE.tasks)) {
      expect(assertSpawnTask(JSON.parse(JSON.stringify(task)))).toEqual(task);
    }
  });

  it('rejects malformed state timestamps and oversized persisted result metadata', () => {
    const completed = structuredClone(SPAWN_TASK_CANONICAL_FIXTURE.tasks.completed) as unknown as Record<string, any>;
    delete completed.stateTimestamps.completedAt;
    expect(() => assertSpawnTask(completed)).toThrow('completedAt');

    const oversized = structuredClone(SPAWN_TASK_CANONICAL_FIXTURE.tasks.completed) as unknown as Record<string, any>;
    oversized.result.byteLength = 8 * 1024 * 1024 + 1;
    expect(() => assertSpawnTask(oversized)).toThrow('byte limit');

    const impossibleDispatch = structuredClone(SPAWN_TASK_CANONICAL_FIXTURE.tasks.reserved) as unknown as Record<string, any>;
    impossibleDispatch.dispatch.sentAt = at;
    expect(() => assertSpawnTask(impossibleDispatch)).toThrow('dispatch');
  });

  it('redacts likely secrets from persisted failure messages', () => {
    const failure = createSpawnTaskFailure({
      code: 'provider_error',
      message: 'Provider rejected Authorization: token opaque-secret-123; payload={"apiKey":"json-secret-456"}; password: "hunter2".',
      retryable: false,
      committedAt: at,
    });

    expect(failure.message).toContain('Provider rejected');
    expect(failure.message).toContain('[redacted]');
    expect(failure.message).not.toContain('opaque-secret-123');
    expect(failure.message).not.toContain('json-secret-456');
    expect(failure.message).not.toContain('hunter2');
  });

  it('requires canonical input interruption details in builders and persisted records', () => {
    const interruption = createSpawnTaskFailure({
      code: 'input_interrupted',
      message: 'Permission request interrupted.',
      retryable: true,
      details: { kind: 'permission', token: 'secret' },
      committedAt: at,
    });
    expect(interruption.details).toEqual({ kind: 'permission', token: '[redacted]' });

    expect(() => createSpawnTaskFailure({
      code: 'input_interrupted',
      message: 'Missing kind.',
      retryable: true,
      committedAt: at,
    })).toThrow('details.kind');
    expect(() => createSpawnTaskFailure({
      code: 'input_interrupted',
      message: 'Invalid kind.',
      retryable: true,
      details: { kind: 'other' },
      committedAt: at,
    })).toThrow('details.kind');

    const missingKind = structuredClone(SPAWN_TASK_CANONICAL_FIXTURE.tasks.failed) as unknown as Record<string, any>;
    delete missingKind.failure.details.kind;
    expect(() => assertSpawnTask(missingKind)).toThrow('input_interrupted');
    const invalidKind = structuredClone(SPAWN_TASK_CANONICAL_FIXTURE.tasks.failed) as unknown as Record<string, any>;
    invalidKind.failure.details.kind = 'other';
    expect(() => assertSpawnTask(invalidKind)).toThrow('input_interrupted');
  });

  it('bounds and sanitizes failure content while preserving interrupted input kind', () => {
    const failure = createSpawnTaskFailure({
      code: 'input_interrupted',
      message: 'é'.repeat(5_000),
      retryable: true,
      details: {
        kind: 'authentication',
        apiKey: 'secret-value',
        nested: { authorization: 'Bearer secret' },
        huge: 'x'.repeat(8_000),
      },
      committedAt: at,
    });

    expect(Buffer.byteLength(failure.message, 'utf8')).toBeLessThanOrEqual(4 * 1024);
    expect(failure.details?.kind).toBe('authentication');
    expect(JSON.stringify(failure.details)).not.toContain('secret-value');
    expect(Buffer.byteLength(JSON.stringify(failure.details), 'utf8')).toBeLessThanOrEqual(4 * 1024);

    const manyDetails = createSpawnTaskFailure({
      code: 'unknown',
      message: 'many details',
      retryable: false,
      details: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`field${index}`, index])),
      committedAt: at,
    });
    expect(manyDetails.details?.truncated).toBe(true);

    const nestedSecrets = createSpawnTaskFailure({
      code: 'provider_error',
      message: 'Nested details failed.',
      retryable: false,
      details: {
        response: 'Authorization: Custom opaque-detail-secret',
        error: 'Provider returned sk-detail-secret-123',
        payload: '{"password":"json-detail-secret"}',
      },
      committedAt: at,
    });
    const persistedDetails = JSON.stringify(nestedSecrets.details);
    expect(persistedDetails).not.toContain('opaque-detail-secret');
    expect(persistedDetails).not.toContain('sk-detail-secret-123');
    expect(persistedDetails).not.toContain('json-detail-secret');
    expect(persistedDetails).toContain('[redacted]');
  });

  it('allows only read, deletion, and integrity changes after terminal state', () => {
    const processing = transitionSpawnTask(reservedTask(), { runtimeState: 'processing', at });
    const completed = transitionSpawnTask(processing, {
      runtimeState: 'completed',
      at,
      result: SPAWN_TASK_CANONICAL_FIXTURE.tasks.completed.result,
    });
    const updated = updateSpawnTaskMetadata(completed, {
      at,
      resultReadAt: at,
      childDeletedAt: at,
      integrityError: {
        code: 'result_persist_failed',
        message: 'Artifact missing.',
        detectedAt: at,
      },
    });

    expect(updated.runtimeState).toBe('completed');
    expect(updated.result).toEqual(completed.result);
    expect(updated.version).toBe(completed.version + 1);
    expect(updated.resultReadAt).toBe(at);
    expect(updated.childDeletedAt).toBe(at);
    expect(updated.integrityError?.code).toBe('result_persist_failed');
  });
});

describe('spawn-task reservation store', () => {
  it('rejects traversal in caller IDs and generated path segments', () => {
    const root = tempWorkspace();
    const generated = [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000004',
      '../escape',
    ];
    const store = new SpawnTaskStore({
      workspaceRoot: root,
      workspaceId: 'ws_paths',
      randomId: () => generated.shift()!,
    });

    expect(() => store.reserve({ parentSessionId: '../parent', delegatedPrompt: 'bad', childConfig: {} })).toThrow(
      'path-safe',
    );
    expect(() => store.reserve({ parentSessionId: 'parent_safe', delegatedPrompt: 'bad nonce', childConfig: {} })).toThrow(
      'generation nonce',
    );

    const longValues = [
      'task-long',
      'child-long',
      'message-long',
      'attempt-long',
      'x'.repeat(232),
    ];
    const longNonceStore = new SpawnTaskStore({
      workspaceRoot: tempWorkspace(),
      workspaceId: 'ws_long_nonce',
      randomId: () => longValues.shift()!,
    });
    expect(() => longNonceStore.reserve({ parentSessionId: 'parent_safe', delegatedPrompt: 'long nonce', childConfig: {} })).toThrow(
      'generation name',
    );
  });

  it('retries reservation when any reserved identity collides', () => {
    const root = tempWorkspace();
    const initialIds = [
      'task-first',
      'child-first',
      'message-first',
      'attempt-first',
      'nonce-first',
    ];
    const firstStore = new SpawnTaskStore({
      workspaceRoot: root,
      workspaceId: 'ws_collision',
      randomId: () => initialIds.shift()!,
      clock: () => at,
    });
    const first = firstStore.reserve({ parentSessionId: 'parent_collision', delegatedPrompt: 'first', childConfig: {} });

    const retryIds = [
      'task-first',
      'child-first',
      'message-first',
      'attempt-first',
      'task-second',
      'child-second',
      'message-second',
      'attempt-second',
      'nonce-second',
    ];
    const retrying = new SpawnTaskStore({
      workspaceRoot: root,
      workspaceId: 'ws_collision',
      randomId: () => retryIds.shift()!,
      clock: () => at,
    });
    const second = retrying.reserve({ parentSessionId: 'parent_collision', delegatedPrompt: 'second', childConfig: {} });

    expect(second.taskId).not.toBe(first.taskId);
    expect(second.childSessionId).not.toBe(first.childSessionId);
    expect(second.dispatch.messageId).not.toBe(first.dispatch.messageId);
    expect(second.dispatch.dispatchAttemptId).not.toBe(first.dispatch.dispatchAttemptId);
    expect(retrying.listAll()).toHaveLength(2);

    const collidingValues = ['task-first', 'child-first', 'message-first', 'attempt-first'];
    let calls = 0;
    const exhausted = new SpawnTaskStore({
      workspaceRoot: root,
      workspaceId: 'ws_collision',
      randomId: () => collidingValues[calls++ % collidingValues.length]!,
      clock: () => at,
    });
    expect(() => exhausted.reserve({ parentSessionId: 'parent_collision', delegatedPrompt: 'never', childConfig: {} })).toThrow(
      'after 16 attempts',
    );
    expect(calls).toBe(64);
  });

  it('rejects duplicate child, message, and attempt indexes during reload', () => {
    for (const field of ['childSessionId', 'messageId', 'dispatchAttemptId'] as const) {
      const root = tempWorkspace();
      const values = [
        'task-a', 'child-a', 'message-a', 'attempt-a', 'nonce-a',
        'task-b', 'child-b', 'message-b', 'attempt-b', 'nonce-b',
      ];
      const store = new SpawnTaskStore({
        workspaceRoot: root,
        workspaceId: `ws_duplicate_${field}`,
        randomId: () => values.shift()!,
        clock: () => at,
      });
      const first = store.reserve({ parentSessionId: 'parent_duplicate', delegatedPrompt: 'first', childConfig: {} });
      const second = store.reserve({ parentSessionId: 'parent_duplicate', delegatedPrompt: 'second', childConfig: {} });
      const taskRoot = join(root, 'spawn-tasks', 'tasks', second.taskId);
      const generation = readFileSync(join(taskRoot, 'CURRENT'), 'utf8').trim();
      const recordPath = join(taskRoot, 'generations', generation, 'record.json');
      const record = JSON.parse(readFileSync(recordPath, 'utf8'));
      if (field === 'childSessionId') record.childSessionId = first.childSessionId;
      else record.dispatch[field] = first.dispatch[field];
      writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

      const reloaded = new SpawnTaskStore({ workspaceRoot: root, workspaceId: `ws_duplicate_${field}` });
      expect(reloaded.listAll()).toHaveLength(1);
      expect(Object.keys(reloaded.getLoadErrors())).toHaveLength(1);
    }
  });

  it('persists all server-owned IDs before returning a reserved queued task', () => {
    let sequence = 0;
    const root = tempWorkspace();
    const store = new SpawnTaskStore({
      workspaceRoot: root,
      workspaceId: 'ws_one',
      clock: () => at,
      randomId: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
    });

    const reserved = store.reserve({
      parentSessionId: 'session_parent',
      delegatedPrompt: 'Perform durable work.',
      childConfig: { model: 'fixture-model', nested: { enabled: true } },
    });

    expect(reserved.taskId).toStartWith('task_');
    expect(reserved.childSessionId).toStartWith('session_');
    expect(reserved.dispatch.messageId).toStartWith('message_');
    expect(reserved.dispatch.dispatchAttemptId).toStartWith('attempt_');
    expect(reserved.runtimeState).toBe('queued');
    expect(reserved.dispatch.state).toBe('reserved');
    expect(new SpawnTaskStore({ workspaceRoot: root, workspaceId: 'ws_one' }).get(reserved.taskId)).toEqual(reserved);
  });

  it('rebuilds parent and child indexes without crossing workspace roots', () => {
    const rootA = tempWorkspace();
    const rootB = tempWorkspace();
    const storeA = new SpawnTaskStore({ workspaceRoot: rootA, workspaceId: 'ws_a', clock: () => at });
    const storeB = new SpawnTaskStore({ workspaceRoot: rootB, workspaceId: 'ws_b', clock: () => at });
    const first = storeA.reserve({ parentSessionId: 'parent_a', delegatedPrompt: 'one', childConfig: {} });
    const second = storeA.reserve({ parentSessionId: 'parent_a', delegatedPrompt: 'two', childConfig: {} });
    storeB.reserve({ parentSessionId: 'parent_a', delegatedPrompt: 'other workspace', childConfig: {} });

    const reloaded = new SpawnTaskStore({ workspaceRoot: rootA, workspaceId: 'ws_a' });
    expect(reloaded.listByParentSessionId('parent_a').map((task) => task.taskId).sort()).toEqual(
      [first.taskId, second.taskId].sort(),
    );
    expect(reloaded.getByChildSessionId(first.childSessionId)?.taskId).toBe(first.taskId);
    expect(reloaded.listAll()).toHaveLength(2);
  });

  it('persists ordered dispatch metadata and rejects terminal dispatch changes', () => {
    const root = tempWorkspace();
    const store = new SpawnTaskStore({ workspaceRoot: root, workspaceId: 'ws_dispatch', clock: () => at });
    const reserved = store.reserve({ parentSessionId: 'parent_dispatch', delegatedPrompt: 'dispatch', childConfig: {} });
    expect(() => store.updateDispatch(reserved.taskId, 'claimed', at)).toThrow('reserved -> claimed');
    const ready = store.updateDispatch(reserved.taskId, 'ready', at);
    const claimed = store.updateDispatch(ready.taskId, 'claimed', at);
    const sent = store.updateDispatch(claimed.taskId, 'sent', at);
    const processing = store.transition(sent.taskId, { runtimeState: 'processing', at });
    const cancellationRequested = store.requestCancellation(processing.taskId, at, 'requested');
    const cancelled = store.transition(cancellationRequested.taskId, {
      runtimeState: 'cancelled',
      at,
      cancellation: cancellationRequested.cancellation!,
    });

    expect(sent.dispatch).toMatchObject({ state: 'sent', readyAt: at, claimedAt: at, sentAt: at });
    expect(() => store.updateDispatch(cancelled.taskId, 'sent', at)).toThrow('after terminal');
    expect(new SpawnTaskStore({ workspaceRoot: root, workspaceId: 'ws_dispatch' }).get(cancelled.taskId)).toEqual(cancelled);
  });

  it('rejects stale writers instead of replacing a newer committed version', () => {
    const root = tempWorkspace();
    const first = new SpawnTaskStore({ workspaceRoot: root, workspaceId: 'ws_cas', clock: () => at });
    const reserved = first.reserve({ parentSessionId: 'parent_cas', delegatedPrompt: 'cas', childConfig: {} });
    const stale = new SpawnTaskStore({ workspaceRoot: root, workspaceId: 'ws_cas', clock: () => at });

    first.markParentDeleted(reserved.taskId, at);
    expect(() => stale.markChildDeleted(reserved.taskId, at)).toThrow('stale');
    expect(new SpawnTaskStore({ workspaceRoot: root, workspaceId: 'ws_cas' }).get(reserved.taskId)?.parentDeletedAt).toBe(at);
  });

  it('durably requests cancellation and preserves the request through terminal races', () => {
    const root = tempWorkspace();
    const store = new SpawnTaskStore({ workspaceRoot: root, workspaceId: 'ws_cancel_request', clock: () => at });

    const completionCandidate = store.transition(
      store.reserve({ parentSessionId: 'parent_cancel', delegatedPrompt: 'complete', childConfig: {} }).taskId,
      { runtimeState: 'processing', at },
    );
    const requested = store.requestCancellation(completionCandidate.taskId, at, 'user_requested');
    const completed = store.commitResult(requested.taskId, 'completion won', { committedAt: at });
    expect(completed.runtimeState).toBe('completed');
    expect(completed.cancellation).toEqual({ requestedAt: at, reason: 'user_requested' });
    expect(store.requestCancellation(completed.taskId, at, 'late_request')).toEqual(completed);

    const failureCandidate = store.transition(
      store.reserve({ parentSessionId: 'parent_cancel', delegatedPrompt: 'fail', childConfig: {} }).taskId,
      { runtimeState: 'processing', at },
    );
    const failureRequested = store.requestCancellation(failureCandidate.taskId, at, 'user_requested');
    const failed = store.transition(failureRequested.taskId, {
      runtimeState: 'failed',
      at,
      failure: SPAWN_TASK_CANONICAL_FIXTURE.tasks.failed.failure,
    });
    expect(failed.cancellation).toEqual(failureRequested.cancellation);

    const cancelCandidate = store.requestCancellation(
      store.reserve({ parentSessionId: 'parent_cancel', delegatedPrompt: 'cancel', childConfig: {} }).taskId,
      at,
      'user_requested',
    );
    expect(() => store.transition(cancelCandidate.taskId, {
      runtimeState: 'cancelled',
      at,
      cancellation: { requestedAt: at, reason: 'different' },
    })).toThrow('same durable request');
    const cancelled = store.transition(cancelCandidate.taskId, {
      runtimeState: 'cancelled',
      at,
      cancellation: cancelCandidate.cancellation!,
    });
    expect(cancelled.cancellation).toEqual(cancelCandidate.cancellation);
  });

  it('prevents a stale store from overwriting terminal and cancellation outcomes', () => {
    const root = tempWorkspace();
    const writer = new SpawnTaskStore({ workspaceRoot: root, workspaceId: 'ws_cancel_stale', clock: () => at });
    const processing = writer.transition(
      writer.reserve({ parentSessionId: 'parent_stale', delegatedPrompt: 'terminal', childConfig: {} }).taskId,
      { runtimeState: 'processing', at },
    );
    const stale = new SpawnTaskStore({ workspaceRoot: root, workspaceId: 'ws_cancel_stale', clock: () => at });
    const completed = writer.commitResult(processing.taskId, 'done', { committedAt: at });

    expect(() => stale.requestCancellation(processing.taskId, at, 'stale')).toThrow('stale');
    expect(new SpawnTaskStore({ workspaceRoot: root, workspaceId: 'ws_cancel_stale' }).get(processing.taskId)).toEqual(completed);

    const cancelCandidate = writer.reserve({ parentSessionId: 'parent_stale', delegatedPrompt: 'cancelled', childConfig: {} });
    const staleBeforeCancel = new SpawnTaskStore({ workspaceRoot: root, workspaceId: 'ws_cancel_stale', clock: () => at });
    const requested = writer.requestCancellation(cancelCandidate.taskId, at, 'winner');
    const cancelled = writer.transition(requested.taskId, {
      runtimeState: 'cancelled',
      at,
      cancellation: requested.cancellation!,
    });
    expect(() => staleBeforeCancel.requestCancellation(cancelCandidate.taskId, at, 'stale')).toThrow('stale');
    expect(new SpawnTaskStore({ workspaceRoot: root, workspaceId: 'ws_cancel_stale' }).get(cancelCandidate.taskId)).toEqual(cancelled);
  });

  it('keeps the previous committed record readable when replacement publication faults', () => {
    const root = tempWorkspace();
    const initial = new SpawnTaskStore({ workspaceRoot: root, workspaceId: 'ws_atomic', clock: () => at });
    const reserved = initial.reserve({ parentSessionId: 'parent_atomic', delegatedPrompt: 'atomic', childConfig: {} });

    const faulting = new SpawnTaskStore({
      workspaceRoot: root,
      workspaceId: 'ws_atomic',
      faults: (point) => {
        if (point === 'after-generation-publish') throw new Error('injected publish fault');
      },
    });

    expect(() => faulting.transition(reserved.taskId, { runtimeState: 'processing', at })).toThrow('injected publish fault');
    expect(faulting.get(reserved.taskId)).toEqual(reserved);
    expect(new SpawnTaskStore({ workspaceRoot: root, workspaceId: 'ws_atomic' }).get(reserved.taskId)).toEqual(reserved);
  });
});
