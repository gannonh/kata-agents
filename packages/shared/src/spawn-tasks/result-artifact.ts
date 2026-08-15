import { createHash } from 'node:crypto';
import {
  SPAWN_TASK_LIMITS,
  type SpawnTaskResult,
  type SpawnTaskResultChunkView,
} from '@kata-sh/core';
import { truncateUtf8 } from './utf8.ts';

export const SPAWN_TASK_RESULT_FILE = 'result.md';
export const SPAWN_TASK_VERIFIED_RESULT_FILE = 'verified-result.json';

export interface SpawnTaskResultArtifact {
  readonly bytes: Buffer;
  readonly result: SpawnTaskResult;
}

export interface BuildSpawnTaskResultOptions {
  readonly committedAt: string;
  readonly sourceMessageId?: string;
}

export class SpawnTaskResultTooLargeError extends Error {
  readonly byteLength: number;

  constructor(byteLength: number) {
    super(`Spawned-task result exceeds ${SPAWN_TASK_LIMITS.resultBytes} bytes`);
    this.name = 'SpawnTaskResultTooLargeError';
    this.byteLength = byteLength;
  }
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function buildSpawnTaskResultArtifact(
  content: string,
  options: BuildSpawnTaskResultOptions,
): SpawnTaskResultArtifact {
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.byteLength > SPAWN_TASK_LIMITS.resultBytes) {
    throw new SpawnTaskResultTooLargeError(bytes.byteLength);
  }

  return {
    bytes,
    result: {
      artifactPath: 'result.md',
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
      ...(options.sourceMessageId ? { sourceMessageId: options.sourceMessageId } : {}),
      committedAt: options.committedAt,
      preview: truncateUtf8(content, SPAWN_TASK_LIMITS.resultPreviewBytes),
    },
  };
}

export function serializeVerifiedResult(result: SpawnTaskResult): string {
  return `${JSON.stringify({ schemaVersion: 1, result }, null, 2)}\n`;
}

export function parseVerifiedResult(value: string): SpawnTaskResult {
  const parsed = JSON.parse(value) as { schemaVersion?: unknown; result?: unknown };
  if (parsed.schemaVersion !== 1 || typeof parsed.result !== 'object' || parsed.result === null) {
    throw new Error('Invalid verified spawned-task result manifest');
  }
  const result = parsed.result as Partial<SpawnTaskResult>;
  if (
    result.artifactPath !== 'result.md'
    || !Number.isSafeInteger(result.byteLength)
    || Number(result.byteLength) < 0
    || typeof result.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(result.sha256)
    || typeof result.committedAt !== 'string'
    || typeof result.preview !== 'string'
    || Buffer.byteLength(result.preview, 'utf8') > SPAWN_TASK_LIMITS.resultPreviewBytes
    || (result.sourceMessageId !== undefined && typeof result.sourceMessageId !== 'string')
  ) {
    throw new Error('Invalid verified spawned-task result descriptor');
  }
  return result as SpawnTaskResult;
}

export function verifySpawnTaskResult(bytes: Uint8Array, result: SpawnTaskResult): boolean {
  return bytes.byteLength === result.byteLength && sha256(bytes) === result.sha256;
}

export function createSpawnTaskResultChunk(
  taskId: string,
  bytes: Uint8Array,
  result: SpawnTaskResult,
  offset: number,
  limit: number,
): SpawnTaskResultChunkView {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.byteLength) {
    throw new RangeError('Spawned-task result offset must be within the artifact byte range');
  }
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > SPAWN_TASK_LIMITS.resultReadBytes) {
    throw new RangeError('Spawned-task result limit must be between 0 and 64 KiB');
  }

  const chunk = Buffer.from(bytes).subarray(offset, Math.min(offset + limit, bytes.byteLength));
  const nextOffset = offset + chunk.byteLength;
  return {
    taskId,
    offset,
    nextOffset,
    byteLength: chunk.byteLength,
    totalByteLength: result.byteLength,
    sha256: result.sha256,
    dataBase64: chunk.toString('base64'),
    truncated: nextOffset < result.byteLength,
  };
}
