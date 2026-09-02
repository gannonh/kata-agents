import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  KATACODE_ADAPTER_CONTRACT_VERSION,
  type BotTurnContext,
} from '@kata-sh/core';
import { ConversationJournal } from '../../conversations/journal.ts';
import { SpawnTaskStore } from '../../spawn-tasks/store.ts';
import { KatacodeAttemptStore } from '../attempts.ts';
import { KatacodeExecutionBridge } from '../bridge.ts';
import { signKatacodeCallback, verifyKatacodeCallback } from '../callbacks.ts';
import { KatacodeIdentityError, resolveKatacodeDispatchIdentity } from '../identity.ts';
import { actionsFor, projectKatacodeCanonicalState, retryBlockedByUncertain } from '../mapping.ts';
import { KatacodeHttpAdapter } from '../http-adapter.ts';
import { MemoryKatacodeAdapter } from './memory-adapter.ts';
import type { KatacodeWorktreeAllocator } from '../worktree.ts';
import { SharedWorktreeRequiresApprovalError } from '../worktree.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function context(): BotTurnContext {
  return {
    runId: 'run_1',
    operationId: 'op_1',
    workspaceId: 'ws_test',
    botId: 'bot_owner',
    conversationId: 'chat_owner',
    journalCursor: 0,
    conversationCursor: 0,
    memoryRevision: 1,
    checkpointRevision: 1,
    text: 'dispatch this',
    memoryIds: [],
  };
}

function identity(overrides: Record<string, unknown> = {}) {
  return resolveKatacodeDispatchIdentity({
    context: context(),
    parentSessionId: 'session_parent',
    botPermissionMode: 'ask',
    fields: {
      repository: 'demo-repo',
      prompt: 'Add a passing test',
      acceptanceCriteria: 'bun test exits 0',
      ...overrides,
    },
  });
}

function worktrees(): KatacodeWorktreeAllocator & { readonly released: string[] } {
  let seq = 0;
  const released: string[] = [];
  return {
    released,
    async allocateIsolated(input) {
      seq += 1;
      return {
        managedWorktreeId: `wt_${input.ownerTaskId}_${seq}`,
        summary: {
          policy: 'isolated',
          repositoryLabel: input.repositoryLabel,
          branchLabel: `kata-agent/task-${seq}`,
        },
      };
    },
    async acquireSharedLease(input) {
      return {
        managedWorktreeId: input.managedWorktreeId,
        summary: {
          policy: 'shared',
          repositoryLabel: input.repositoryLabel,
          branchLabel: 'main',
        },
        leaseId: `lease_${input.ownerTaskId}`,
      };
    },
    release({ ownerTaskId }) {
      released.push(ownerTaskId);
    },
  };
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'katacode-'));
  dirs.push(root);
  const taskStore = new SpawnTaskStore({ workspaceRoot: root, workspaceId: 'ws_test' });
  const attempts = new KatacodeAttemptStore({ workspaceRoot: root, workspaceId: 'ws_test' });
  const adapter = new MemoryKatacodeAdapter();
  const allocator = worktrees();
  const journal = new ConversationJournal({
    journalRoot: join(root, 'journals'),
    workspaceId: 'ws_test',
    resolveConversation: (conversationId) => ({
      conversationId,
      workspaceId: 'ws_test',
      soleAuthorBotId: 'bot_owner',
    }),
  });
  const bridge = new KatacodeExecutionBridge({
    workspaceId: 'ws_test',
    taskStore,
    attempts,
    adapter,
    worktrees: allocator,
    journal,
    resolveBotName: () => 'Owner',
  });
  return { bridge, adapter, taskStore, attempts, journal, worktrees: allocator };
}

describe('Katacode adapter contract v1', () => {
  test('exposes the versioned methods before HTTP transport exists', async () => {
    const adapter = new MemoryKatacodeAdapter();
    expect(adapter.contractVersion).toBe(KATACODE_ADAPTER_CONTRACT_VERSION);
    const accepted = await adapter.dispatch({
      contractVersion: KATACODE_ADAPTER_CONTRACT_VERSION,
      idempotencyKey: 'key-1',
      prompt: 'change one file',
      acceptanceCriteria: 'tests pass',
      permissionMode: 'ask',
      worktree: { policy: 'isolated', repositoryLabel: 'demo', branchLabel: 'kata-agent/a' },
    });
    expect(accepted.kind).toBe('accepted');
    if (accepted.kind !== 'accepted') throw new Error('expected accepted');
    const lookup = await adapter.lookupByIdempotencyKey('key-1');
    expect(lookup.kind).toBe('found');
    const status = await adapter.getStatusAndResult(accepted.runRef);
    expect(status.status.phase).toBe('running');
    const cancelled = await adapter.cancel(accepted.runRef);
    expect(cancelled.kind).toBe('cancelled');
    const artifacts = await adapter.getArtifactsAndPullRequest(accepted.runRef);
    expect(artifacts.artifacts).toEqual([]);
    const link = await adapter.getDeepLink(accepted.runRef);
    expect(link.url).toContain(accepted.runRef.runId);
  });

  test('lookup by the same client key returns one run', async () => {
    const adapter = new MemoryKatacodeAdapter();
    const request = {
      contractVersion: KATACODE_ADAPTER_CONTRACT_VERSION,
      idempotencyKey: 'dup',
      prompt: 'once',
      acceptanceCriteria: 'once',
      permissionMode: 'safe' as const,
      worktree: { policy: 'isolated' as const, repositoryLabel: 'demo', branchLabel: 'b' },
    };
    const first = await adapter.dispatch(request);
    const second = await adapter.dispatch(request);
    expect(first).toEqual(second);
    expect(adapter.dispatches).toHaveLength(2);
  });
});

describe('Katacode identity resolution', () => {
  test('rejects caller-selected workspace, path, credential, and recipient', () => {
    expect(() => identity({ workspaceId: 'ws_other' })).toThrow(KatacodeIdentityError);
    expect(() => identity({ checkoutPath: '/tmp/repo' })).toThrow(KatacodeIdentityError);
    expect(() => identity({ credential: 'sk-secret' })).toThrow(KatacodeIdentityError);
    expect(() => identity({ recipient: 'bot_other' })).toThrow(KatacodeIdentityError);
    expect(() => identity({ repository: '/var/repos/demo' })).toThrow(KatacodeIdentityError);
  });

  test('defaults worktree policy to isolated and requires an opaque shared id', () => {
    expect(identity().worktreePolicy).toBe('isolated');
    expect(() => identity({ worktreePolicy: 'shared' })).toThrow(KatacodeIdentityError);
    expect(identity({ worktreePolicy: 'shared', sharedWorktreeId: 'repo-aabbccdd' }).sharedWorktreeId)
      .toBe('repo-aabbccdd');
  });
});

describe('Katacode canonical mapping', () => {
  test('maps uncertain attempts to processing plus a reconciliation warning', () => {
    const projection = projectKatacodeCanonicalState({
      attempt: {
        schemaVersion: 1,
        attemptId: 'a1',
        taskId: 'task_1',
        workspaceId: 'ws_test',
        conversationId: 'chat_owner',
        ownerBotId: 'bot_owner',
        clientIdempotencyKey: 'k',
        state: 'uncertain',
        fence: { attemptNonce: 'n', taskVersion: 1 },
        worktree: { policy: 'isolated', repositoryLabel: 'demo', branchLabel: 'b' },
        createdAt: '2026-09-02T00:00:00.000Z',
      },
      runtimeState: 'processing',
    });
    expect(projection.runtimeState).toBe('processing');
    expect(projection.reconciliationRequired).toBe(true);
    expect(projection.actions).toEqual(['read']);
    expect(retryBlockedByUncertain({
      ...projection,
      state: 'uncertain',
    } as never)).toBe(true);
  });

  test('disables retry until a terminal failure is proven', () => {
    expect(actionsFor('processing', 'acknowledged')).toEqual(['cancel', 'open']);
    expect(actionsFor('failed', 'failed')).toContain('retry');
    expect(actionsFor('processing', 'uncertain')).not.toContain('retry');
    expect(actionsFor('processing', 'uncertain')).not.toContain('cancel');
  });
});

describe('Katacode execution bridge', () => {
  test('persists the task and attempt before calling Katacode', async () => {
    const { bridge, adapter, taskStore, attempts } = harness();
    let reservedBeforeCall = false;
    const original = adapter.dispatch.bind(adapter);
    adapter.dispatch = async (request) => {
      const attempt = attempts.getByIdempotencyKey('chat_owner', 'key-persist');
      reservedBeforeCall = attempt?.state === 'sent' && taskStore.get(attempt.taskId)?.runtimeState === 'processing';
      return original(request);
    };
    const result = await bridge.dispatch({ identity: identity(), clientIdempotencyKey: 'key-persist' });
    expect(reservedBeforeCall).toBe(true);
    expect(result.runtimeState).toBe('processing');
    expect(bridge.card(result.taskId).ownerBotName).toBe('Owner');
    expect(bridge.card(result.taskId).repositoryLabel).toBe('demo-repo');
    expect(bridge.listConversationCards('chat_owner')).toHaveLength(1);
  });

  test('creates one journal card and keeps a disconnect uncertain without redispatched work', async () => {
    const { bridge, adapter, journal } = harness();
    adapter.nextAcceptance = 'throw';
    const result = await bridge.dispatch({ identity: identity(), clientIdempotencyKey: 'key-uncertain' });
    expect(result.runtimeState).toBe('processing');
    expect(bridge.card(result.taskId).reconciliationRequired).toBe(true);
    expect(journal.list('chat_owner').filter((entry) => entry.kind === 'task')).toHaveLength(1);
    adapter.nextAcceptance = { kind: 'accepted', runRef: { runId: 'should-not-run' } };
    await expect(bridge.retry(result.taskId, identity())).rejects.toThrow(/uncertain/);
    expect(adapter.dispatches).toHaveLength(1);
  });

  test('reconciles an uncertain attempt by idempotency key and never presents it as failed', async () => {
    const { bridge, adapter } = harness();
    adapter.nextAcceptance = { kind: 'uncertain' };
    adapter.nextLookup = { kind: 'uncertain' };
    const result = await bridge.dispatch({ identity: identity(), clientIdempotencyKey: 'key-lookup' });
    const reconciled = await bridge.reconcile(result.taskId);
    expect(reconciled.runtimeState).toBe('processing');
    expect(bridge.card(reconciled.taskId).reconciliationRequired).toBe(true);
    expect(adapter.dispatches).toHaveLength(1);
  });

  test('authoritative absence becomes a retryable interrupted failure', async () => {
    const { bridge, adapter } = harness();
    adapter.nextAcceptance = { kind: 'uncertain' };
    adapter.nextLookup = { kind: 'absent' };
    const result = await bridge.dispatch({ identity: identity(), clientIdempotencyKey: 'key-absent' });
    const reconciled = await bridge.reconcile(result.taskId);
    expect(reconciled.runtimeState).toBe('failed');
    const retried = await bridge.retry(reconciled.taskId, identity());
    expect(retried.taskId).not.toBe(reconciled.taskId);
    expect(adapter.dispatches.length).toBeGreaterThan(1);
  });

  test('allocates distinct isolated worktrees for concurrent tasks', async () => {
    const { bridge } = harness();
    const first = await bridge.dispatch({ identity: identity(), clientIdempotencyKey: 'c1' });
    const second = await bridge.dispatch({ identity: identity(), clientIdempotencyKey: 'c2' });
    expect(bridge.rail(first.taskId, 1).branchLabel).not.toBe(bridge.rail(second.taskId, 1).branchLabel);
    expect(first.taskId).not.toBe(second.taskId);
  });

  test('shared checkout requires explicit approval', async () => {
    const { bridge } = harness();
    const shared = identity({ worktreePolicy: 'shared', sharedWorktreeId: 'repo-aabbccdd' });
    await expect(bridge.dispatch({ identity: shared, clientIdempotencyKey: 'shared' }))
      .rejects.toBeInstanceOf(SharedWorktreeRequiresApprovalError);
    const approved = await bridge.dispatch({
      identity: shared,
      clientIdempotencyKey: 'shared-ok',
      sharedApproved: true,
    });
    expect(bridge.rail(approved.taskId, 1).worktreePolicy).toBe('shared');
  });

  test('commits the verified result before the terminal journal entry', async () => {
    const { bridge, adapter, journal, taskStore } = harness();
    const result = await bridge.dispatch({ identity: identity(), clientIdempotencyKey: 'key-complete' });
    const found = await adapter.lookupByIdempotencyKey('key-complete');
    expect(found.kind).toBe('found');
    if (found.kind === 'found') adapter.complete(found.runRef.runId, 'tests passed');
    const current = (await bridge.refresh(result.taskId));
    const task = taskStore.get(current.taskId);
    expect(task?.runtimeState).toBe('completed');
    expect(task?.result?.preview).toContain('tests');
    const terminal = journal.list('chat_owner').filter((entry) => entry.idempotencyKey.endsWith('.terminal'));
    expect(terminal).toHaveLength(1);
    expect(JSON.parse(terminal[0]!.body).runtimeState).toBe('completed');
    expect(bridge.rail(current.taskId, 2).pullRequest?.number).toBe(1);
  });

  test('completes a run that omits result markdown', async () => {
    const { bridge, adapter, taskStore } = harness();
    const result = await bridge.dispatch({ identity: identity(), clientIdempotencyKey: 'key-empty-result' });
    const found = await adapter.lookupByIdempotencyKey('key-empty-result');
    expect(found.kind).toBe('found');
    if (found.kind === 'found') adapter.complete(found.runRef.runId);
    const current = await bridge.refresh(result.taskId);
    expect(current.runtimeState).toBe('completed');
    expect(taskStore.get(current.taskId)?.runtimeState).toBe('completed');
  });

  test('releases a shared checkout lease when the task becomes terminal', async () => {
    const { bridge, adapter, worktrees } = harness();
    const shared = identity({ worktreePolicy: 'shared', sharedWorktreeId: 'repo-aabbccdd' });
    const result = await bridge.dispatch({
      identity: shared,
      clientIdempotencyKey: 'shared-lease',
      sharedApproved: true,
    });
    expect(worktrees.released).toEqual([]);
    const found = await adapter.lookupByIdempotencyKey('shared-lease');
    expect(found.kind).toBe('found');
    if (found.kind === 'found') adapter.complete(found.runRef.runId, 'done');
    await bridge.refresh(result.taskId);
    expect(worktrees.released).toEqual([result.taskId]);
  });

  test('duplicate journal appends do not create a second card', async () => {
    const { bridge, journal } = harness();
    const result = await bridge.dispatch({ identity: identity(), clientIdempotencyKey: 'key-dup' });
    journal.append({
      conversationId: 'chat_owner',
      authorBotId: 'bot_owner',
      taskId: result.taskId,
      kind: 'task',
      idempotencyKey: `katacode.${result.taskId}.requested`,
      body: 'ignored',
    });
    expect(journal.list('chat_owner').filter((entry) => entry.kind === 'task')).toHaveLength(1);
    expect(bridge.listConversationCards('chat_owner')).toHaveLength(1);
  });

  test('provider failure after acknowledgement is a retryable terminal failure', async () => {
    const { bridge, adapter } = harness();
    const result = await bridge.dispatch({ identity: identity(), clientIdempotencyKey: 'key-fail' });
    const found = await adapter.lookupByIdempotencyKey('key-fail');
    expect(found.kind).toBe('found');
    if (found.kind === 'found') adapter.fail(found.runRef.runId, 'tests failed');
    const failed = await bridge.refresh(result.taskId);
    expect(failed.runtimeState).toBe('failed');
    expect(bridge.card(result.taskId).actions).toContain('retry');
    const retried = await bridge.retry(result.taskId, identity());
    expect(retried.taskId).not.toBe(result.taskId);
    expect(adapter.dispatches.length).toBeGreaterThan(1);
  });

  test('cancel is compare-and-set safe against completion', async () => {
    const { bridge, adapter, taskStore } = harness();
    const result = await bridge.dispatch({ identity: identity(), clientIdempotencyKey: 'key-cancel' });
    const found = await adapter.lookupByIdempotencyKey('key-cancel');
    if (found.kind === 'found') adapter.complete(found.runRef.runId, 'done');
    await bridge.refresh(result.taskId);
    const cancelled = await bridge.cancel(result.taskId, 'too late');
    expect(cancelled.runtimeState).toBe('completed');
    expect(taskStore.get(result.taskId)?.runtimeState).toBe('completed');
  });
});

describe('Katacode HTTP adapter', () => {
  test('sends the client idempotency key and bearer credential', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const adapter = new KatacodeHttpAdapter({
      endpoint: 'https://katacode.example/',
      getCredential: async () => 'secret-token',
      fetchImpl: (async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ runId: 'run_http_1', phase: 'queued' }), { status: 200 });
      }) as typeof fetch,
    });
    const accepted = await adapter.dispatch({
      contractVersion: KATACODE_ADAPTER_CONTRACT_VERSION,
      idempotencyKey: 'http-key',
      prompt: 'change one file',
      acceptanceCriteria: 'tests pass',
      permissionMode: 'ask',
      worktree: { policy: 'isolated', repositoryLabel: 'demo', branchLabel: 'kata-agent/a' },
    });
    expect(accepted).toEqual({ kind: 'accepted', runRef: { runId: 'run_http_1' } });
    expect(calls[0]?.url).toBe('https://katacode.example/v1/runs');
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get('authorization')).toBe('Bearer secret-token');
    expect(headers.get('idempotency-key')).toBe('http-key');
  });

  test('timeouts and network failures become uncertain', async () => {
    const adapter = new KatacodeHttpAdapter({
      endpoint: 'https://katacode.example',
      getCredential: async () => 'secret-token',
      timeoutMs: 5,
      fetchImpl: (async () => {
        throw new Error('socket hang up');
      }) as unknown as typeof fetch,
    });
    await expect(adapter.dispatch({
      contractVersion: KATACODE_ADAPTER_CONTRACT_VERSION,
      idempotencyKey: 'http-timeout',
      prompt: 'change one file',
      acceptanceCriteria: 'tests pass',
      permissionMode: 'safe',
      worktree: { policy: 'isolated', repositoryLabel: 'demo', branchLabel: 'b' },
    })).resolves.toEqual({ kind: 'uncertain' });
  });

  test('missing credential is a rejected dispatch, not an uncertain acceptance', async () => {
    const adapter = new KatacodeHttpAdapter({
      endpoint: 'https://katacode.example',
      getCredential: async () => null,
      fetchImpl: (async () => {
        throw new Error('network should not be used');
      }) as unknown as typeof fetch,
    });
    await expect(adapter.dispatch({
      contractVersion: KATACODE_ADAPTER_CONTRACT_VERSION,
      idempotencyKey: 'http-auth',
      prompt: 'change one file',
      acceptanceCriteria: 'tests pass',
      permissionMode: 'ask',
      worktree: { policy: 'isolated', repositoryLabel: 'demo', branchLabel: 'b' },
    })).resolves.toEqual({ kind: 'rejected', reason: 'Katacode credential is not configured' });
  });
});

describe('Katacode callback integrity', () => {
  test('accepts a timely HMAC and rejects a tampered body', () => {
    const timestamp = '2026-09-02T00:00:00.000Z';
    const body = '{"runId":"run_1","phase":"completed"}';
    const signature = signKatacodeCallback('secret', timestamp, body);
    expect(verifyKatacodeCallback({
      secret: 'secret',
      timestamp,
      body,
      signature,
      nowMs: Date.parse(timestamp),
    })).toBe(true);
    expect(verifyKatacodeCallback({
      secret: 'secret',
      timestamp,
      body: '{"runId":"run_1","phase":"failed"}',
      signature,
      nowMs: Date.parse(timestamp),
    })).toBe(false);
  });
});
