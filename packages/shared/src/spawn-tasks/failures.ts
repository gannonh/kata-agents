import {
  SPAWN_TASK_FAILURE_CODES,
  SPAWN_TASK_LIMITS,
  type SpawnTaskAwaitingInputKind,
  type SpawnTaskFailure,
  type SpawnTaskFailureCode,
  type SpawnTaskFailureDetails,
  type SpawnTaskJsonValue,
} from '@kata-sh/core';
import { truncateUtf8 } from './utf8.ts';

const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|secret|token|api[-_]?key)/i;

export interface CreateSpawnTaskFailureInput {
  readonly code: SpawnTaskFailureCode;
  readonly message: unknown;
  readonly retryable: boolean;
  readonly details?: unknown;
  readonly committedAt: string;
}

function sanitizeValue(value: unknown, depth: number): SpawnTaskJsonValue | undefined {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return typeof value === 'string' ? truncateUtf8(value, 1024) : value;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (depth >= 4) return '[truncated]';
  if (Array.isArray(value)) {
    return value.slice(0, 32)
      .map((entry) => sanitizeValue(entry, depth + 1))
      .filter((entry): entry is SpawnTaskJsonValue => entry !== undefined);
  }
  if (typeof value === 'object' && value !== null) {
    const sanitized: Record<string, SpawnTaskJsonValue> = {};
    for (const [rawKey, rawValue] of Object.entries(value).slice(0, 64)) {
      const key = truncateUtf8(rawKey, 128);
      if (!key) continue;
      if (SENSITIVE_KEY.test(key)) {
        sanitized[key] = '[redacted]';
        continue;
      }
      const next = sanitizeValue(rawValue, depth + 1);
      if (next !== undefined) sanitized[key] = next;
    }
    return sanitized;
  }
  return undefined;
}

function inputKind(value: unknown): SpawnTaskAwaitingInputKind | undefined {
  return value === 'permission' || value === 'authentication' ? value : undefined;
}

function sanitizeDetails(details: unknown): SpawnTaskFailureDetails | undefined {
  const sanitized = sanitizeValue(details, 0);
  if (!sanitized || Array.isArray(sanitized) || typeof sanitized !== 'object') return undefined;

  const kind = inputKind((details as { kind?: unknown } | null)?.kind);
  const serialized = JSON.stringify(sanitized);
  if (Buffer.byteLength(serialized, 'utf8') <= SPAWN_TASK_LIMITS.failureDetailsBytes) {
    return sanitized as SpawnTaskFailureDetails;
  }

  return {
    ...(kind ? { kind } : {}),
    truncated: true,
  };
}

export function createSpawnTaskFailure(input: CreateSpawnTaskFailureInput): SpawnTaskFailure {
  const code = SPAWN_TASK_FAILURE_CODES.includes(input.code) ? input.code : 'unknown';
  const message = truncateUtf8(
    typeof input.message === 'string'
      ? input.message
      : input.message instanceof Error
        ? input.message.message
        : String(input.message ?? 'Unknown spawned-task failure'),
    SPAWN_TASK_LIMITS.failureMessageBytes,
  );
  const details = sanitizeDetails(input.details);

  return {
    code,
    message,
    retryable: input.retryable,
    ...(details ? { details } : {}),
    committedAt: input.committedAt,
  };
}
