import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SPAWN_TASK_LIMITS } from '@kata-sh/core';
import { SpawnTaskStore } from '../src/spawn-tasks/index.ts';

const at = '2026-02-03T04:05:06.000Z';
const later = '2026-02-03T04:06:06.000Z';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'spawn-task-results-'));
  roots.push(root);
  return root;
}

function currentGenerationPath(root: string, taskId: string): string {
  const taskRoot = join(root, 'spawn-tasks', 'tasks', taskId);
  const generation = readFileSync(join(taskRoot, 'CURRENT'), 'utf8').trim();
  return join(taskRoot, 'generations', generation);
}

function rewriteCurrentRecord(root: string, taskId: string, mutate: (record: Record<string, any>) => void): void {
  const recordPath = join(currentGenerationPath(root, taskId), 'record.json');
  const record = JSON.parse(readFileSync(recordPath, 'utf8')) as Record<string, any>;
  mutate(record);
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

function processingTask(store: SpawnTaskStore) {
  const reserved = store.reserve({
    parentSessionId: 'session_parent',
    delegatedPrompt: 'Produce a result.',
    childConfig: { model: 'fixture' },
  });
  return store.transition(reserved.taskId, { runtimeState: 'processing', at });
}

describe('spawn-task result artifacts', () => {
  it('commits zero-byte output as a valid task-owned result', () => {
    const root = workspace();
    const store = new SpawnTaskStore({ workspaceRoot: root, workspaceId: 'ws_result' });
    const processing = processingTask(store);

    const completed = store.commitResult(processing.taskId, '', {
      committedAt: later,
      sourceMessageId: 'message_source',
    });
    const chunk = store.readResultChunk(processing.taskId, 0, 64);

    expect(completed.runtimeState).toBe('completed');
    expect(completed.result?.byteLength).toBe(0);
    expect(completed.result?.preview).toBe('');
    expect(chunk).toMatchObject({ offset: 0, nextOffset: 0, byteLength: 0, dataBase64: '', truncated: false });
  });

  it('commits oversized output as canonical result_too_large failure', () => {
    const root = workspace();
    const store = new SpawnTaskStore({ workspaceRoot: root, workspaceId: 'ws_large' });
    const processing = processingTask(store);

    const failed = store.commitResult(processing.taskId, 'x'.repeat(SPAWN_TASK_LIMITS.resultBytes + 1), {
      committedAt: later,
      sourceMessageId: 'message_large',
    });

    expect(failed.runtimeState).toBe('failed');
    expect(failed.failure?.code).toBe('result_too_large');
    expect(failed.failure?.details).toMatchObject({
      byteLength: SPAWN_TASK_LIMITS.resultBytes + 1,
      maxByteLength: SPAWN_TASK_LIMITS.resultBytes,
      sourceMessageId: 'message_large',
    });
  });

  it('reads exact byte chunks even when boundaries split UTF-8 sequences', () => {
    const root = workspace();
    const store = new SpawnTaskStore({ workspaceRoot: root, workspaceId: 'ws_chunks' });
    const processing = processingTask(store);
    const completed = store.commitResult(processing.taskId, 'A✓B', { committedAt: later });

    const first = store.readResultChunk(completed.taskId, 1, 2);
    const second = store.readResultChunk(completed.taskId, 3, 2);

    expect(first).toMatchObject({ offset: 1, nextOffset: 3, byteLength: 2, dataBase64: '4pw=', totalByteLength: 5, truncated: true });
    expect(second).toMatchObject({ offset: 3, nextOffset: 5, byteLength: 2, dataBase64: 'k0I=', totalByteLength: 5, truncated: false });
    expect(store.readResultChunk(completed.taskId, 5, 0)).toMatchObject({
      offset: 5,
      nextOffset: 5,
      byteLength: 0,
      dataBase64: '',
      truncated: false,
    });
    expect(() => store.readResultChunk(completed.taskId, -1, 1)).toThrow('offset');
    expect(() => store.readResultChunk(completed.taskId, 6, 1)).toThrow('offset');
    expect(() => store.readResultChunk(completed.taskId, 0, SPAWN_TASK_LIMITS.resultReadBytes + 1)).toThrow('64 KiB');
  });

  it('requires the result commit API for completed store transitions', () => {
    const root = workspace();
    const store = new SpawnTaskStore({ workspaceRoot: root, workspaceId: 'ws_no_bypass' });
    const processing = processingTask(store);
    const result = {
      artifactPath: 'result.md',
      byteLength: 0,
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      committedAt: later,
      preview: '',
    } as const;

    expect(() => store.transition(processing.taskId, { runtimeState: 'completed', at: later, result })).toThrow(
      'commitResult',
    );
  });

  it('caps result previews by complete UTF-8 bytes', () => {
    const root = workspace();
    const store = new SpawnTaskStore({ workspaceRoot: root, workspaceId: 'ws_preview' });
    const processing = processingTask(store);
    const completed = store.commitResult(processing.taskId, 'é'.repeat(3_000), { committedAt: later });

    expect(Buffer.byteLength(completed.result?.preview ?? '', 'utf8')).toBe(4 * 1024);
    expect(completed.result?.preview.includes('�')).toBe(false);
  });
});

describe('spawn-task artifact recovery and retention', () => {
  it('finalizes a verified artifact left with a nonterminal record exactly once', () => {
    const root = workspace();
    const initial = new SpawnTaskStore({ workspaceRoot: root, workspaceId: 'ws_finalize' });
    const processing = processingTask(initial);
    const faulting = new SpawnTaskStore({
      workspaceRoot: root,
      workspaceId: 'ws_finalize',
      faults: (point, task) => {
        if (point === 'before-current-publish' && task.runtimeState === 'completed') {
          throw new Error('terminal publication interrupted');
        }
      },
    });

    expect(() => faulting.commitResult(processing.taskId, 'durable result', { committedAt: later })).toThrow(
      'terminal publication interrupted',
    );
    expect(faulting.get(processing.taskId)?.runtimeState).toBe('processing');

    const recovered = new SpawnTaskStore({ workspaceRoot: root, workspaceId: 'ws_finalize' });
    const completed = recovered.get(processing.taskId)!;
    expect(completed.runtimeState).toBe('completed');
    expect(recovered.getLastStartupReport().finalized).toEqual([{
      taskId: processing.taskId,
      previousRuntimeState: 'processing',
      version: completed.version,
    }]);
    expect(recovered.readResultChunk(processing.taskId, 0, 64)).toMatchObject({ dataBase64: 'ZHVyYWJsZSByZXN1bHQ=' });

    const reloaded = new SpawnTaskStore({ workspaceRoot: root, workspaceId: 'ws_finalize' });
    expect(reloaded.get(processing.taskId)?.version).toBe(completed.version);
    expect(reloaded.getLastStartupReport().finalized).toEqual([]);
    expect(reloaded.reload().finalized).toEqual([]);
  });

  it('finalizes verified artifacts from queued and awaiting-input recovery states', () => {
    for (const state of ['queued', 'awaiting-input'] as const) {
      const root = workspace();
      const workspaceId = `ws_finalize_${state.replace('-', '_')}`;
      const initial = new SpawnTaskStore({ workspaceRoot: root, workspaceId });
      const processing = processingTask(initial);
      const faulting = new SpawnTaskStore({
        workspaceRoot: root,
        workspaceId,
        faults: (point, task) => {
          if (point === 'before-current-publish' && task.runtimeState === 'completed') {
            throw new Error('terminal publication interrupted');
          }
        },
      });
      expect(() => faulting.commitResult(processing.taskId, `recovered ${state}`, { committedAt: later })).toThrow();
      rewriteCurrentRecord(root, processing.taskId, (record) => {
        record.runtimeState = state;
        if (state === 'queued') {
          delete record.stateTimestamps.processingAt;
        } else {
          record.stateTimestamps.awaitingInputAt = later;
          record.awaitingInput = {
            kind: 'authentication',
            requestId: 'request_recovery',
            promptSummary: 'Authenticate to continue.',
            createdAt: later,
          };
        }
      });

      const recovered = new SpawnTaskStore({ workspaceRoot: root, workspaceId });
      const completed = recovered.get(processing.taskId)!;
      expect(completed.runtimeState).toBe('completed');
      expect(completed.awaitingInput).toBeUndefined();
      expect(recovered.getLastStartupReport().finalized).toEqual([{
        taskId: processing.taskId,
        previousRuntimeState: state,
        version: completed.version,
      }]);
      expect(recovered.reload().finalized).toEqual([]);
      expect(recovered.get(processing.taskId)?.version).toBe(completed.version);
    }
  });

  it('leaves unverified nonterminal artifact junk nonterminal and replaceable', () => {
    const root = workspace();
    const initial = new SpawnTaskStore({ workspaceRoot: root, workspaceId: 'ws_unverified' });
    const processing = processingTask(initial);
    writeFileSync(join(currentGenerationPath(root, processing.taskId), 'result.md'), 'unverified', 'utf8');

    const reloaded = new SpawnTaskStore({ workspaceRoot: root, workspaceId: 'ws_unverified' });
    expect(reloaded.get(processing.taskId)?.runtimeState).toBe('processing');
    expect(reloaded.commitResult(processing.taskId, 'verified', { committedAt: later }).runtimeState).toBe('completed');
  });

  it('marks corrupt completed artifacts without rewriting outcome and repairs atomically', () => {
    const root = workspace();
    const initial = new SpawnTaskStore({ workspaceRoot: root, workspaceId: 'ws_repair' });
    const processing = processingTask(initial);
    const original = 'repairable result';
    const completed = initial.commitResult(processing.taskId, original, { committedAt: later });
    writeFileSync(join(currentGenerationPath(root, completed.taskId), 'result.md'), 'corrupt', 'utf8');

    const markedStore = new SpawnTaskStore({ workspaceRoot: root, workspaceId: 'ws_repair', clock: () => later });
    const marked = markedStore.get(completed.taskId)!;
    expect(marked.runtimeState).toBe('completed');
    expect(marked.result).toEqual(completed.result);
    expect(marked.integrityError?.code).toBe('result_persist_failed');
    expect(markedStore.readResultChunk(completed.taskId, 0, 64)).toHaveProperty('integrityError');
    expect(() => markedStore.updateMetadata(completed.taskId, { at: later, integrityError: null })).toThrow('repairResult');

    const repaired = markedStore.repairResult(completed.taskId, original, '2026-02-03T04:07:06.000Z');
    expect(repaired.runtimeState).toBe('completed');
    expect(repaired.result).toEqual(completed.result);
    expect(repaired.integrityError).toBeUndefined();
    expect(markedStore.readResultChunk(completed.taskId, 0, 64)).toMatchObject({ dataBase64: 'cmVwYWlyYWJsZSByZXN1bHQ=' });

    const reloaded = new SpawnTaskStore({ workspaceRoot: root, workspaceId: 'ws_repair' });
    expect(reloaded.get(completed.taskId)).toEqual(repaired);
  });

  it('runs artifact validation when an existing store reloads', () => {
    const root = workspace();
    const store = new SpawnTaskStore({ workspaceRoot: root, workspaceId: 'ws_reload_validate', clock: () => later });
    const processing = processingTask(store);
    const completed = store.commitResult(processing.taskId, 'reload me', { committedAt: later });
    writeFileSync(join(currentGenerationPath(root, completed.taskId), 'result.md'), 'corrupt', 'utf8');

    const report = store.reload();
    const marked = store.get(completed.taskId)!;
    expect(marked).toMatchObject({
      runtimeState: 'completed',
      integrityError: { code: 'result_persist_failed' },
    });
    expect(report.integrityMarked).toEqual([{ taskId: completed.taskId, version: marked.version }]);
    expect(store.reload().integrityMarked).toEqual([]);
  });

  it('marks a missing completed artifact while preserving completed state', () => {
    const root = workspace();
    const initial = new SpawnTaskStore({ workspaceRoot: root, workspaceId: 'ws_missing' });
    const processing = processingTask(initial);
    const completed = initial.commitResult(processing.taskId, 'will disappear', { committedAt: later });
    rmSync(join(currentGenerationPath(root, completed.taskId), 'result.md'));

    const reloaded = new SpawnTaskStore({ workspaceRoot: root, workspaceId: 'ws_missing', clock: () => later });
    expect(reloaded.get(completed.taskId)).toMatchObject({
      runtimeState: 'completed',
      result: completed.result,
      integrityError: { code: 'result_persist_failed' },
    });
  });

  it('keeps the previous committed pair readable across every publication fault seam', () => {
    const points = [
      'before-record-write',
      'after-record-write',
      'before-artifact-write',
      'after-artifact-write',
      'after-generation-publish',
      'before-current-publish',
    ] as const;

    for (const injectedPoint of points) {
      const root = workspace();
      const initial = new SpawnTaskStore({ workspaceRoot: root, workspaceId: `ws_fault_${injectedPoint.replaceAll('-', '_')}` });
      const processing = processingTask(initial);
      const faulting = new SpawnTaskStore({
        workspaceRoot: root,
        workspaceId: initial.workspaceId,
        faults: (point) => {
          if (point === injectedPoint) throw new Error(`injected ${point}`);
        },
      });

      expect(() => faulting.commitResult(processing.taskId, 'never partial', { committedAt: later })).toThrow(
        `injected ${injectedPoint}`,
      );
      expect(faulting.get(processing.taskId)).toEqual(processing);
      expect(new SpawnTaskStore({ workspaceRoot: root, workspaceId: initial.workspaceId }).get(processing.taskId)).toEqual(processing);
    }
  });

  it('keeps an integrity-marked generation readable when repair publication faults', () => {
    const root = workspace();
    const initial = new SpawnTaskStore({ workspaceRoot: root, workspaceId: 'ws_repair_fault' });
    const processing = processingTask(initial);
    const original = 'repair survives fault';
    const completed = initial.commitResult(processing.taskId, original, { committedAt: later });
    writeFileSync(join(currentGenerationPath(root, completed.taskId), 'result.md'), 'corrupt', 'utf8');
    const markedStore = new SpawnTaskStore({ workspaceRoot: root, workspaceId: 'ws_repair_fault', clock: () => later });
    const marked = markedStore.get(completed.taskId)!;
    const faulting = new SpawnTaskStore({
      workspaceRoot: root,
      workspaceId: 'ws_repair_fault',
      faults: (point) => {
        if (point === 'after-generation-publish') throw new Error('repair publication fault');
      },
    });

    expect(() => faulting.repairResult(completed.taskId, original, later)).toThrow('repair publication fault');
    expect(faulting.get(completed.taskId)).toEqual(marked);
    expect(new SpawnTaskStore({ workspaceRoot: root, workspaceId: 'ws_repair_fault' }).get(completed.taskId)).toEqual(marked);
  });

  it('isolates a corrupt task record so other workspace tasks remain readable', () => {
    const root = workspace();
    const store = new SpawnTaskStore({ workspaceRoot: root, workspaceId: 'ws_corrupt_record' });
    const corrupt = processingTask(store);
    const healthy = processingTask(store);
    writeFileSync(join(currentGenerationPath(root, corrupt.taskId), 'record.json'), '{broken', 'utf8');

    const reloaded = new SpawnTaskStore({ workspaceRoot: root, workspaceId: 'ws_corrupt_record' });
    expect(reloaded.get(corrupt.taskId)).toBeNull();
    expect(reloaded.get(healthy.taskId)).toEqual(healthy);
    expect(reloaded.getLoadErrors()).toHaveProperty(corrupt.taskId);
  });

  it('persists read/deletion markers and purges tasks only on explicit request', () => {
    const root = workspace();
    const store = new SpawnTaskStore({ workspaceRoot: root, workspaceId: 'ws_retention' });
    const first = processingTask(store);
    const completed = store.commitResult(first.taskId, 'retained', { committedAt: later });
    const read = store.markResultRead(completed.taskId, later);
    const parentDeleted = store.markParentDeleted(read.taskId, later);
    const childDeleted = store.markChildDeleted(parentDeleted.taskId, later);

    const reloaded = new SpawnTaskStore({ workspaceRoot: root, workspaceId: 'ws_retention' });
    expect(reloaded.get(childDeleted.taskId)).toEqual(childDeleted);
    expect(reloaded.readResultChunk(childDeleted.taskId, 0, 64)).toMatchObject({ dataBase64: 'cmV0YWluZWQ=' });
    expect(reloaded.purgeTask(childDeleted.taskId)).toBe(true);
    expect(reloaded.get(childDeleted.taskId)).toBeNull();

    processingTask(reloaded);
    reloaded.purgeWorkspace();
    expect(reloaded.listAll()).toEqual([]);
    expect(existsSync(join(root, 'spawn-tasks', 'tasks'))).toBe(true);
  });
});
