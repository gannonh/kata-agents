import {
  CHANNEL_LIMITS,
  CHANNEL_SCHEMA_VERSION,
  CLAIM_OUTCOMES,
  CHANNEL_LIFECYCLES,
  ROUTE_BLOCK_REASONS,
  ROUTE_MODES,
  ROUTE_STAGE_STATES,
  STAGE_CANCEL_REASONS,
  type ChannelMember,
  type ChannelRecord,
  type ClaimOutcome,
  type RouteClaim,
  type RouteRecord,
  type RouteStage,
} from '@kata-sh/core';
import { CONVERSATION_LIMITS } from '@kata-sh/core';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/;
const SAFE_STAGE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

function fail(message: string): never {
  throw new TypeError(`Invalid Channel record: ${message}`);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, field: string, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${field}.${key} is unknown`);
  }
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string') fail(`${field} must be a string`);
  return value;
}

function timestamp(value: unknown, field: string): string {
  const text = string(value, field);
  if (!Number.isFinite(Date.parse(text))) fail(`${field} must be an ISO timestamp`);
  return text;
}

function enumValue<T extends string>(value: unknown, field: string, values: readonly T[]): T {
  const text = string(value, field);
  if (!values.includes(text as T)) fail(`${field} must be one of ${values.join(', ')}`);
  return text as T;
}

function bounded(value: unknown, field: string, maxBytes: number): string {
  const text = string(value, field);
  if (Buffer.byteLength(text, 'utf8') > maxBytes) fail(`${field} exceeds ${maxBytes} byte limit`);
  return text;
}

export function assertChannelId(value: unknown, field = 'channelId'): string {
  const id = string(value, field);
  if (!SAFE_ID.test(id) || id === '.' || id === '..') fail(`${field} is not an opaque path-safe ID`);
  return id;
}

export function assertRouteId(value: unknown, field = 'routeId'): string {
  const id = string(value, field);
  if (!SAFE_ID.test(id) || id === '.' || id === '..') fail(`${field} is not an opaque path-safe ID`);
  return id;
}

export function assertStageId(value: unknown, field = 'stageId'): string {
  const id = string(value, field);
  if (!SAFE_STAGE_ID.test(id) || id === '.' || id === '..') fail(`${field} is not a path-safe ID`);
  return id;
}

export function assertChannelName(value: unknown, field = 'name'): string {
  const name = bounded(value, field, CHANNEL_LIMITS.nameBytes);
  if (!name.trim()) fail(`${field} must be non-empty`);
  return name;
}

export function assertChannelIdempotencyKey(value: unknown, field = 'idempotencyKey'): string {
  const key = bounded(value, field, CONVERSATION_LIMITS.idempotencyKeyBytes);
  if (!key.trim()) fail(`${field} must be non-empty`);
  return key;
}

function assertBotId(value: unknown, field: string): string {
  return assertChannelId(value, field);
}

function assertMember(value: unknown, field: string): ChannelMember {
  const member = object(value, field);
  exactKeys(member, field, ['botId', 'priority', 'addedAt']);
  const priority = member.priority;
  if (!Number.isSafeInteger(priority) || (priority as number) < 0) fail(`${field}.priority must be a non-negative safe integer`);
  return {
    botId: assertBotId(member.botId, `${field}.botId`),
    priority: priority as number,
    addedAt: timestamp(member.addedAt, `${field}.addedAt`),
  };
}

export function assertChannelRecord(value: unknown): ChannelRecord {
  const record = object(value, 'channel');
  exactKeys(record, 'channel', [
    'schemaVersion',
    'channelId',
    'workspaceId',
    'name',
    'lifecycle',
    'membershipRevision',
    'members',
    'createdAt',
    'updatedAt',
    'archivedAt',
  ]);
  if (record.schemaVersion !== CHANNEL_SCHEMA_VERSION) fail('unsupported schemaVersion');
  assertChannelId(record.channelId, 'channelId');
  assertChannelId(record.workspaceId, 'workspaceId');
  assertChannelName(record.name);
  const lifecycle = enumValue(record.lifecycle, 'lifecycle', CHANNEL_LIFECYCLES);
  if (!Array.isArray(record.members)) fail('members must be an array');
  const members = record.members.map((member, index) => assertMember(member, `members[${index}]`));
  if (members.length > CHANNEL_LIMITS.maxMembers) fail(`members exceeds ${CHANNEL_LIMITS.maxMembers} entries`);
  if (new Set(members.map((member) => member.botId)).size !== members.length) fail('members must be unique');
  if (!Number.isSafeInteger(record.membershipRevision) || (record.membershipRevision as number) < 1) {
    fail('membershipRevision must be a positive safe integer');
  }
  timestamp(record.createdAt, 'createdAt');
  timestamp(record.updatedAt, 'updatedAt');
  if (record.archivedAt !== undefined) timestamp(record.archivedAt, 'archivedAt');
  if (lifecycle === 'archived' && record.archivedAt === undefined) fail('archived channels require archivedAt');
  if (lifecycle === 'active' && record.archivedAt !== undefined) fail('active channels cannot have archivedAt');
  return {
    schemaVersion: CHANNEL_SCHEMA_VERSION,
    channelId: record.channelId as string,
    workspaceId: record.workspaceId as string,
    name: record.name as string,
    lifecycle,
    membershipRevision: record.membershipRevision as number,
    members,
    createdAt: record.createdAt as string,
    updatedAt: record.updatedAt as string,
    ...(record.archivedAt !== undefined ? { archivedAt: record.archivedAt as string } : {}),
  };
}

function assertClaim(value: unknown, field: string): RouteClaim {
  const claim = object(value, field);
  exactKeys(claim, field, ['botId', 'outcome', 'claim', 'confidence', 'reason', 'latencyMs', 'receivedAt']);
  const outcome = enumValue(claim.outcome, `${field}.outcome`, CLAIM_OUTCOMES);
  if (typeof claim.claim !== 'boolean') fail(`${field}.claim must be a boolean`);
  if (!Number.isFinite(claim.confidence) || (claim.confidence as number) < 0 || (claim.confidence as number) > 100) {
    fail(`${field}.confidence must be between 0 and 100`);
  }
  if (!Number.isFinite(claim.latencyMs) || (claim.latencyMs as number) < 0) fail(`${field}.latencyMs must be non-negative`);
  bounded(claim.reason, `${field}.reason`, CHANNEL_LIMITS.reasonBytes);
  timestamp(claim.receivedAt, `${field}.receivedAt`);
  if (outcome !== 'claimed' && (claim.claim !== false || claim.confidence !== 0)) {
    fail(`${field} declined outcomes must have claim false and confidence 0`);
  }
  if (outcome === 'claimed' && claim.claim !== true) fail(`${field}.claimed outcome must have claim true`);
  return {
    botId: assertBotId(claim.botId, `${field}.botId`),
    outcome,
    claim: claim.claim as boolean,
    confidence: claim.confidence as number,
    reason: claim.reason as string,
    latencyMs: claim.latencyMs as number,
    receivedAt: claim.receivedAt as string,
  };
}

function assertStage(value: unknown, field: string): RouteStage {
  const stage = object(value, field);
  exactKeys(stage, field, ['stageId', 'ownerBotId', 'ownerEpoch', 'dispatchIdempotencyKey', 'state', 'reason', 'committedAt', 'dispatchedAt', 'settledAt']);
  const state = enumValue(stage.state, `${field}.state`, ROUTE_STAGE_STATES);
  if (!Number.isSafeInteger(stage.ownerEpoch) || (stage.ownerEpoch as number) < 1) fail(`${field}.ownerEpoch must be positive`);
  assertChannelIdempotencyKey(stage.dispatchIdempotencyKey, `${field}.dispatchIdempotencyKey`);
  timestamp(stage.committedAt, `${field}.committedAt`);
  if (stage.reason !== undefined) bounded(stage.reason, `${field}.reason`, CHANNEL_LIMITS.reasonBytes);
  if (stage.dispatchedAt !== undefined) timestamp(stage.dispatchedAt, `${field}.dispatchedAt`);
  if (stage.settledAt !== undefined) timestamp(stage.settledAt, `${field}.settledAt`);
  return {
    stageId: assertStageId(stage.stageId, `${field}.stageId`),
    ownerBotId: assertBotId(stage.ownerBotId, `${field}.ownerBotId`),
    ownerEpoch: stage.ownerEpoch as number,
    dispatchIdempotencyKey: stage.dispatchIdempotencyKey as string,
    state,
    ...(stage.reason !== undefined ? { reason: stage.reason as string } : {}),
    committedAt: stage.committedAt as string,
    ...(stage.dispatchedAt !== undefined ? { dispatchedAt: stage.dispatchedAt as string } : {}),
    ...(stage.settledAt !== undefined ? { settledAt: stage.settledAt as string } : {}),
  };
}

export function assertRouteRecord(value: unknown): RouteRecord {
  const record = object(value, 'route');
  exactKeys(record, 'route', [
    'schemaVersion',
    'routeId',
    'channelId',
    'workspaceId',
    'routeSeq',
    'messageEntryId',
    'mode',
    'membershipRevision',
    'eligibleBotIds',
    'offerDeadline',
    'claims',
    'stages',
    'blockedReason',
    'createdAt',
    'updatedAt',
  ]);
  if (record.schemaVersion !== CHANNEL_SCHEMA_VERSION) fail('unsupported schemaVersion');
  assertRouteId(record.routeId);
  assertChannelId(record.channelId);
  assertChannelId(record.workspaceId, 'workspaceId');
  assertChannelId(record.messageEntryId, 'messageEntryId');
  if (!Number.isSafeInteger(record.routeSeq) || (record.routeSeq as number) < 1) fail('routeSeq must be positive');
  enumValue(record.mode, 'mode', ROUTE_MODES);
  if (!Number.isSafeInteger(record.membershipRevision) || (record.membershipRevision as number) < 1) fail('membershipRevision must be positive');
  if (!Array.isArray(record.eligibleBotIds)) fail('eligibleBotIds must be an array');
  const eligibleBotIds = record.eligibleBotIds.map((botId, index) => assertBotId(botId, `eligibleBotIds[${index}]`));
  if (new Set(eligibleBotIds).size !== eligibleBotIds.length) fail('eligibleBotIds must be unique');
  timestamp(record.offerDeadline, 'offerDeadline');
  if (!Array.isArray(record.claims)) fail('claims must be an array');
  const claims = record.claims.map((claim, index) => assertClaim(claim, `claims[${index}]`));
  if (!Array.isArray(record.stages)) fail('stages must be an array');
  const stages = record.stages.map((stage, index) => assertStage(stage, `stages[${index}]`));
  if (new Set(stages.map((stage) => stage.stageId)).size !== stages.length) fail('stages must be unique');
  if (record.blockedReason !== undefined) enumValue(record.blockedReason, 'blockedReason', ROUTE_BLOCK_REASONS);
  timestamp(record.createdAt, 'createdAt');
  timestamp(record.updatedAt, 'updatedAt');
  return {
    schemaVersion: CHANNEL_SCHEMA_VERSION,
    routeId: record.routeId as string,
    channelId: record.channelId as string,
    workspaceId: record.workspaceId as string,
    routeSeq: record.routeSeq as number,
    messageEntryId: record.messageEntryId as string,
    mode: record.mode as 'explicit' | 'autonomous',
    membershipRevision: record.membershipRevision as number,
    eligibleBotIds,
    offerDeadline: record.offerDeadline as string,
    claims,
    stages,
    ...(record.blockedReason !== undefined ? { blockedReason: record.blockedReason as 'no-eligible-members' | 'no-claim' } : {}),
    createdAt: record.createdAt as string,
    updatedAt: record.updatedAt as string,
  };
}

export { CLAIM_OUTCOMES, STAGE_CANCEL_REASONS };
export type { ClaimOutcome };
