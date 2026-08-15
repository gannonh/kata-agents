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
const JSON_NAMED_SECRET = /("(?:authorization|api[-_]?key|apiKey|cookie|credential|password|secret|token)"\s*:\s*)"(?:\\.|[^"\\])*"/gi;
const AUTHORIZATION_SECRET = /(\bauthorization\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\r\n,;]+)/gi;
const NAMED_SECRET = /(\b(?:api[-_ ]?key|cookie|credential|password|secret|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const NAMED_SECRET_WORD = /(\b(?:api[-_ ]?key|password|secret|token)\s+)[A-Za-z0-9._~+/=-]{6,}/gi;
const LIKELY_BARE_SECRET = /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g;

function sanitizeMessage(value: string): string {
  return value
    .replace(JSON_NAMED_SECRET, '$1"[redacted]"')
    .replace(AUTHORIZATION_SECRET, '$1[redacted]')
    .replace(NAMED_SECRET, '$1[redacted]')
    .replace(NAMED_SECRET_WORD, '$1[redacted]')
    .replace(LIKELY_BARE_SECRET, '[redacted]');
}

export interface CreateSpawnTaskFailureInput {
  readonly code: SpawnTaskFailureCode;
  readonly message: unknown;
  readonly retryable: boolean;
  readonly details?: unknown;
  readonly committedAt: string;
}

interface SanitizeState {
  truncated: boolean;
}

function sanitizeValue(value: unknown, depth: number, state: SanitizeState): SpawnTaskJsonValue | undefined {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const sanitized = sanitizeMessage(value);
    const truncated = truncateUtf8(sanitized, 1024);
    if (truncated !== sanitized) state.truncated = true;
    return truncated;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (depth >= 4) {
    state.truncated = true;
    return '[truncated]';
  }
  if (Array.isArray(value)) {
    if (value.length > 32) state.truncated = true;
    return value.slice(0, 32)
      .map((entry) => sanitizeValue(entry, depth + 1, state))
      .filter((entry): entry is SpawnTaskJsonValue => entry !== undefined);
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value);
    if (entries.length > 64) state.truncated = true;
    const sanitized: Record<string, SpawnTaskJsonValue> = {};
    for (const [rawKey, rawValue] of entries.slice(0, 64)) {
      const key = truncateUtf8(rawKey, 128);
      if (key !== rawKey) state.truncated = true;
      if (!key) continue;
      if (SENSITIVE_KEY.test(key)) {
        sanitized[key] = '[redacted]';
        continue;
      }
      const next = sanitizeValue(rawValue, depth + 1, state);
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
  const state: SanitizeState = { truncated: false };
  const sanitized = sanitizeValue(details, 0, state);
  if (!sanitized || Array.isArray(sanitized) || typeof sanitized !== 'object') return undefined;

  const kind = inputKind((details as { kind?: unknown } | null)?.kind);
  const candidate: SpawnTaskFailureDetails = {
    ...(sanitized as SpawnTaskFailureDetails),
    ...(kind ? { kind } : {}),
    ...(state.truncated ? { truncated: true } : {}),
  };
  const serialized = JSON.stringify(candidate);
  if (Buffer.byteLength(serialized, 'utf8') <= SPAWN_TASK_LIMITS.failureDetailsBytes) {
    return candidate;
  }

  return {
    ...(kind ? { kind } : {}),
    truncated: true,
  };
}

export function createSpawnTaskFailure(input: CreateSpawnTaskFailureInput): SpawnTaskFailure {
  const code = SPAWN_TASK_FAILURE_CODES.includes(input.code) ? input.code : 'unknown';
  const rawMessage = typeof input.message === 'string'
    ? input.message
    : input.message instanceof Error
      ? input.message.message
      : String(input.message ?? 'Unknown spawned-task failure');
  const message = truncateUtf8(sanitizeMessage(rawMessage), SPAWN_TASK_LIMITS.failureMessageBytes);
  const kind = inputKind((input.details as { kind?: unknown } | null)?.kind);
  if (code === 'input_interrupted' && !kind) {
    throw new TypeError('input_interrupted failure requires details.kind permission|authentication');
  }
  const details = sanitizeDetails(input.details);

  return {
    code,
    message,
    retryable: input.retryable,
    ...(details ? { details } : {}),
    committedAt: input.committedAt,
  };
}
