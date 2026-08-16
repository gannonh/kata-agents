import { describe, expect, it } from 'bun:test';
import {
  SPAWN_TASK_CANONICAL_FIXTURE,
  SPAWN_TASK_DISPATCH_STATES,
  SPAWN_TASK_FAILURE_CODES,
  SPAWN_TASK_LIMITS,
  SPAWN_TASK_RUNTIME_STATES,
  SPAWN_TASK_SCHEMA_VERSION,
} from '../src/index.ts';

describe('spawn-task canonical contract', () => {
  it('exports one serializable fixture covering canonical task views', () => {
    const serialized = JSON.stringify(SPAWN_TASK_CANONICAL_FIXTURE);
    const fixture = JSON.parse(serialized);

    expect(fixture.schemaVersion).toBe(SPAWN_TASK_SCHEMA_VERSION);
    expect(fixture.tasks.reserved.runtimeState).toBe('queued');
    expect(fixture.tasks.awaitingInput.awaitingInput.kind).toBe('permission');
    expect(fixture.tasks.completed.result.artifactPath).toBe('result.md');
    expect(fixture.tasks.failed.failure.details.kind).toBe('authentication');
    expect(fixture.tasks.cancelled.runtimeState).toBe('cancelled');
    expect(fixture.resultChunk.dataBase64).toBe('4pyT');
  });

  it('freezes exact states, failure codes, and byte limits', () => {
    expect(SPAWN_TASK_RUNTIME_STATES).toEqual([
      'queued',
      'processing',
      'awaiting-input',
      'completed',
      'failed',
      'cancelled',
    ]);
    expect(SPAWN_TASK_DISPATCH_STATES).toEqual(['reserved', 'ready', 'claimed', 'sent']);
    expect(SPAWN_TASK_FAILURE_CODES).toEqual([
      'spawn_persist_failed',
      'dispatch_interrupted',
      'provider_error',
      'tool_error',
      'input_interrupted',
      'cancel_failed',
      'result_too_large',
      'result_persist_failed',
      'unknown',
    ]);
    expect(SPAWN_TASK_LIMITS).toEqual({
      childConfigBytes: 64 * 1024,
      resultBytes: 8 * 1024 * 1024,
      resultReadBytes: 64 * 1024,
      resultPreviewBytes: 4 * 1024,
      failureMessageBytes: 4 * 1024,
      failureDetailsBytes: 4 * 1024,
      promptSummaryBytes: 4 * 1024,
    });
  });
});
