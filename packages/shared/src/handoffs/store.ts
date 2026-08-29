import { existsSync, readdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  HANDOFF_LIMITS,
  HANDOFF_MAIL_STATES,
  HANDOFF_MAIL_TRANSITIONS,
  HANDOFF_SCHEMA_VERSION,
  type HandoffDeliveryRecord,
  type HandoffMailState,
} from '@kata-sh/core';
import { readJsonFile, writeJsonIfAbsent, writeJsonRecord } from '../conversations/durable-json.ts';
import {
  assertNotSymlink,
  assertRegularFile,
  ensureDurableDirectory,
  syncDirectory,
} from '../spawn-tasks/durable-fs.ts';
import {
  assertHandoffPathId,
  getWorkspaceHandoffsPath,
  handoffByConversationPath,
  handoffByHandoffPath,
  handoffDeliveryRecordPath,
  handoffDeliveriesPath,
} from './layout.ts';

export interface HandoffDeliveryStoreOptions {
  readonly workspaceRoot: string;
  readonly clock?: () => string;
  readonly randomId?: () => string;
}

export interface CreateHandoffDeliveryInput {
  readonly deliveryId: string;
  readonly handoffId: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly sourceBotId: string;
  readonly targetBotId: string;
  readonly request: string;
}

export interface ClaimHandoffDeliveryInput {
  readonly claimId: string;
  readonly recipientBotId: string;
  readonly expectedOwnerEpoch: number;
}

export interface AcknowledgeHandoffDeliveryInput {
  readonly claimId: string;
  readonly recipientBotId: string;
  readonly ownerEpoch: number;
}

export interface FailHandoffDeliveryInput {
  readonly code: string;
  readonly message: string;
  readonly claim?: {
    readonly claimId: string;
    readonly recipientBotId: string;
    readonly ownerEpoch: number;
  };
}

export interface MarkHandoffResultUnreadInput {
  readonly taskVersion: number;
  readonly at: string;
}

export interface MarkHandoffResultReadInput {
  readonly expectedTaskVersion: number;
}

export class HandoffDeliveryClaimConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HandoffDeliveryClaimConflictError';
  }
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function fail(message: string): never {
  throw new TypeError(`Invalid handoff delivery record: ${message}`);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string') fail(`${field} must be a string`);
  return value;
}

function exactKeys(value: Record<string, unknown>, field: string, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${field}.${key} is unknown`);
  }
}

function timestamp(value: unknown, field: string): string {
  const text = string(value, field);
  if (!TIMESTAMP.test(text) || !Number.isFinite(Date.parse(text))) fail(`${field} must be an ISO timestamp`);
  return text;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(`${field} must be a positive safe integer`);
  return value as number;
}

export function assertHandoffDeliveryRecord(value: unknown): HandoffDeliveryRecord {
  const record = object(value, 'record');
  exactKeys(record, 'record', [
    'schemaVersion',
    'version',
    'deliveryId',
    'handoffId',
    'workspaceId',
    'conversationId',
    'sourceBotId',
    'targetBotId',
    'request',
    'mailState',
    'spawnTaskId',
    'claim',
    'failure',
    'resultUnread',
    'resultReadTaskVersion',
    'createdAt',
    'updatedAt',
  ]);
  if (record.schemaVersion !== HANDOFF_SCHEMA_VERSION) fail('unsupported schemaVersion');
  positiveInteger(record.version, 'version');
  assertHandoffPathId(record.deliveryId, 'deliveryId');
  assertHandoffPathId(record.handoffId, 'handoffId');
  assertHandoffPathId(record.workspaceId, 'workspaceId');
  assertHandoffPathId(record.conversationId, 'conversationId');
  assertHandoffPathId(record.sourceBotId, 'sourceBotId');
  assertHandoffPathId(record.targetBotId, 'targetBotId');
  const request = string(record.request, 'request');
  if (Buffer.byteLength(request, 'utf8') > HANDOFF_LIMITS.requestBytes) fail('request exceeds byte limit');
  const mailState = string(record.mailState, 'mailState');
  if (!(HANDOFF_MAIL_STATES as readonly string[]).includes(mailState)) fail('unknown mailState');
  if (record.spawnTaskId !== undefined) assertHandoffPathId(record.spawnTaskId, 'spawnTaskId');

  if (record.claim !== undefined) {
    const claim = object(record.claim, 'claim');
    exactKeys(claim, 'claim', ['claimId', 'ownerEpoch', 'claimedAt']);
    assertHandoffPathId(claim.claimId, 'claim.claimId');
    positiveInteger(claim.ownerEpoch, 'claim.ownerEpoch');
    timestamp(claim.claimedAt, 'claim.claimedAt');
  }

  if (record.failure !== undefined) {
    const failure = object(record.failure, 'failure');
    exactKeys(failure, 'failure', ['code', 'message', 'at']);
    const code = string(failure.code, 'failure.code');
    if (!code.trim()) fail('failure.code must be non-empty');
    const message = string(failure.message, 'failure.message');
    if (Buffer.byteLength(message, 'utf8') > HANDOFF_LIMITS.deliveryFailureMessageBytes) {
      fail('failure.message exceeds byte limit');
    }
    timestamp(failure.at, 'failure.at');
  }

  if (record.resultUnread !== undefined) {
    const unread = object(record.resultUnread, 'resultUnread');
    exactKeys(unread, 'resultUnread', ['taskVersion', 'at']);
    positiveInteger(unread.taskVersion, 'resultUnread.taskVersion');
    timestamp(unread.at, 'resultUnread.at');
  }

  if (record.resultReadTaskVersion !== undefined) {
    positiveInteger(record.resultReadTaskVersion, 'resultReadTaskVersion');
  }

  timestamp(record.createdAt, 'createdAt');
  timestamp(record.updatedAt, 'updatedAt');

  const state = mailState as HandoffMailState;
  if ((state === 'claimed' || state === 'acknowledged') !== (record.claim !== undefined)) {
    fail(`claim is inconsistent with mailState ${state}`);
  }
  if ((state === 'claimed' || state === 'acknowledged') && record.spawnTaskId === undefined) {
    fail(`spawnTaskId is inconsistent with mailState ${state}`);
  }
  if ((state === 'delivery-failed') !== (record.failure !== undefined)) {
    fail(`failure is inconsistent with mailState ${state}`);
  }
  if (state !== 'acknowledged') {
    if (record.resultUnread !== undefined) fail('resultUnread requires acknowledged mailState');
    if (record.resultReadTaskVersion !== undefined) fail('resultReadTaskVersion requires acknowledged mailState');
  }

  return value as HandoffDeliveryRecord;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertPositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive safe integer`);
}

function assertIsoTimestamp(value: string, field: string): void {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} must be an ISO timestamp`);
  }
}

export class HandoffDeliveryStore {
  readonly rootPath: string;

  private readonly clock: () => string;
  private readonly randomId: () => string;
  private readonly deliveries = new Map<string, HandoffDeliveryRecord>();
  private readonly byHandoff = new Map<string, string>();
  private readonly byConversation = new Map<string, Set<string>>();
  private readonly loadErrors = new Map<string, string>();

  constructor(options: HandoffDeliveryStoreOptions) {
    this.rootPath = getWorkspaceHandoffsPath(options.workspaceRoot);
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.randomId = options.randomId ?? randomUUID;
    ensureDurableDirectory(this.rootPath);
    ensureDurableDirectory(handoffDeliveriesPath(this.rootPath));
    ensureDurableDirectory(join(this.rootPath, 'by-handoff'));
    ensureDurableDirectory(join(this.rootPath, 'by-conversation'));
    this.reload();
  }

  create(input: CreateHandoffDeliveryInput): HandoffDeliveryRecord {
    const deliveryId = assertHandoffPathId(input.deliveryId, 'deliveryId');
    const handoffId = assertHandoffPathId(input.handoffId, 'handoffId');
    const workspaceId = assertHandoffPathId(input.workspaceId, 'workspaceId');
    const conversationId = assertHandoffPathId(input.conversationId, 'conversationId');
    const sourceBotId = assertHandoffPathId(input.sourceBotId, 'sourceBotId');
    const targetBotId = assertHandoffPathId(input.targetBotId, 'targetBotId');
    if (typeof input.request !== 'string') throw new TypeError('request must be a string');
    if (Buffer.byteLength(input.request, 'utf8') > HANDOFF_LIMITS.requestBytes) {
      throw new Error(`request exceeds the ${HANDOFF_LIMITS.requestBytes} byte limit`);
    }
    const existing = this.byHandoff.get(handoffId);
    if (existing) throw new Error(`Handoff ID ${handoffId} is already owned by delivery ${existing}`);

    const now = this.clock();
    const record: HandoffDeliveryRecord = {
      schemaVersion: HANDOFF_SCHEMA_VERSION,
      version: 1,
      deliveryId,
      handoffId,
      workspaceId,
      conversationId,
      sourceBotId,
      targetBotId,
      request: input.request,
      mailState: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    assertHandoffDeliveryRecord(record);

    const recordPath = handoffDeliveryRecordPath(this.rootPath, deliveryId);
    if (!writeJsonIfAbsent(recordPath, record)) {
      throw new Error(`Handoff delivery already exists: ${deliveryId}`);
    }
    if (!this.claimHandoffPointer(handoffId, deliveryId)) {
      this.discardDelivery(deliveryId);
      const owner = this.readByHandoffPointer(handoffId);
      throw new Error(
        owner
          ? `Handoff ID ${handoffId} is already owned by delivery ${owner}`
          : `Handoff ID ${handoffId} is already owned`,
      );
    }
    writeJsonRecord(handoffByConversationPath(this.rootPath, conversationId, deliveryId), { deliveryId });
    this.index(record);
    return clone(record);
  }

  get(deliveryId: string): HandoffDeliveryRecord | null {
    assertHandoffPathId(deliveryId, 'deliveryId');
    const record = this.deliveries.get(deliveryId);
    return record ? clone(record) : null;
  }

  getByHandoff(handoffId: string): HandoffDeliveryRecord | null {
    assertHandoffPathId(handoffId, 'handoffId');
    const deliveryId = this.byHandoff.get(handoffId);
    return deliveryId ? this.get(deliveryId) : null;
  }

  listByConversation(conversationId: string): HandoffDeliveryRecord[] {
    assertHandoffPathId(conversationId, 'conversationId');
    return [...(this.byConversation.get(conversationId) ?? [])]
      .map((deliveryId) => this.deliveries.get(deliveryId))
      .filter((record): record is HandoffDeliveryRecord => record !== undefined)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.deliveryId.localeCompare(right.deliveryId))
      .map(clone);
  }

  listAll(): HandoffDeliveryRecord[] {
    return [...this.deliveries.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.deliveryId.localeCompare(right.deliveryId))
      .map(clone);
  }

  repairHandoffPointerIfMissing(deliveryId: string): 'ok' | 'repaired' | 'conflict' {
    const record = this.require(deliveryId);
    const owner = this.readByHandoffPointer(record.handoffId);
    if (owner === record.deliveryId) return 'ok';
    if (owner) return 'conflict';
    if (this.claimHandoffPointer(record.handoffId, deliveryId)) return 'repaired';
    const winner = this.readByHandoffPointer(record.handoffId);
    return winner === record.deliveryId ? 'ok' : 'conflict';
  }

  claimDelivery(deliveryId: string, input: ClaimHandoffDeliveryInput): HandoffDeliveryRecord {
    const current = this.require(deliveryId);
    const claimId = assertHandoffPathId(input.claimId, 'claim.claimId');
    const recipientBotId = assertHandoffPathId(input.recipientBotId, 'recipientBotId');
    if (!Number.isSafeInteger(input.expectedOwnerEpoch) || input.expectedOwnerEpoch < 0) {
      throw new Error('expectedOwnerEpoch must be a non-negative safe integer');
    }
    if (recipientBotId !== current.targetBotId) {
      throw new HandoffDeliveryClaimConflictError(
        `Handoff delivery ${deliveryId} is addressed to ${current.targetBotId}, not ${recipientBotId}`,
      );
    }
    if (current.mailState !== 'claimed') this.assertMailTransition(current.mailState, 'claimed');
    if (!current.spawnTaskId) {
      throw new Error(`Handoff delivery ${deliveryId} cannot be claimed before task attachment`);
    }
    let ownerEpoch: number;
    if (current.mailState === 'pending') {
      if (input.expectedOwnerEpoch !== 0) {
        throw new HandoffDeliveryClaimConflictError(
          `Handoff delivery ${deliveryId} is unclaimed; expectedOwnerEpoch must be 0`,
        );
      }
      ownerEpoch = 1;
    } else {
      if (!current.claim || input.expectedOwnerEpoch !== current.claim.ownerEpoch) {
        throw new HandoffDeliveryClaimConflictError(
          `Handoff delivery ${deliveryId} claim is stale: expectedOwnerEpoch ${input.expectedOwnerEpoch}`
            + ` does not match owner epoch ${current.claim?.ownerEpoch ?? 0}`,
        );
      }
      ownerEpoch = input.expectedOwnerEpoch + 1;
    }
    const {
      resultUnread: _previousUnread,
      resultReadTaskVersion: _previousReadVersion,
      failure: _previousFailure,
      ...claimable
    } = current;
    const next: HandoffDeliveryRecord = {
      ...claimable,
      version: current.version + 1,
      mailState: 'claimed',
      spawnTaskId: current.spawnTaskId,
      claim: { claimId, ownerEpoch, claimedAt: this.clock() },
      updatedAt: this.clock(),
    };
    return this.commit(next);
  }

  acknowledgeDelivery(deliveryId: string, input: AcknowledgeHandoffDeliveryInput): HandoffDeliveryRecord {
    const current = this.require(deliveryId);
    if (current.mailState !== 'claimed') {
      throw new HandoffDeliveryClaimConflictError(
        `Illegal handoff mail transition: ${current.mailState} -> acknowledged`,
      );
    }
    if (!current.spawnTaskId) {
      throw new Error(`Handoff delivery ${deliveryId} cannot be acknowledged before task attachment`);
    }
    const claimId = assertHandoffPathId(input.claimId, 'claimId');
    const recipientBotId = assertHandoffPathId(input.recipientBotId, 'recipientBotId');
    assertPositiveSafeInteger(input.ownerEpoch, 'ownerEpoch');
    if (
      recipientBotId !== current.targetBotId
      || !current.claim
      || current.claim.claimId !== claimId
      || current.claim.ownerEpoch !== input.ownerEpoch
    ) {
      throw new HandoffDeliveryClaimConflictError(
        `Handoff delivery ${deliveryId} claim is stale: recipient ${recipientBotId}`
          + ` claim ${claimId} epoch ${input.ownerEpoch}`
          + ` does not match the current claim`,
      );
    }
    const next: HandoffDeliveryRecord = {
      ...current,
      version: current.version + 1,
      mailState: 'acknowledged',
      spawnTaskId: current.spawnTaskId,
      updatedAt: this.clock(),
    };
    return this.commit(next);
  }

  failDelivery(deliveryId: string, input: FailHandoffDeliveryInput): HandoffDeliveryRecord {
    const current = this.require(deliveryId);
    if (current.mailState !== 'pending' && current.mailState !== 'claimed') {
      throw new HandoffDeliveryClaimConflictError(
        `Illegal handoff mail transition: ${current.mailState} -> delivery-failed`,
      );
    }
    if (input.claim !== undefined && current.mailState === 'pending') {
      throw new HandoffDeliveryClaimConflictError(
        `Handoff delivery ${deliveryId} is unclaimed; failDelivery takes no claim`,
      );
    }
    if (input.claim !== undefined) {
      assertHandoffPathId(input.claim.claimId, 'claim.claimId');
      assertHandoffPathId(input.claim.recipientBotId, 'claim.recipientBotId');
      assertPositiveSafeInteger(input.claim.ownerEpoch, 'claim.ownerEpoch');
      if (
        input.claim.recipientBotId !== current.targetBotId
        ||
        !current.claim
        || current.claim.claimId !== input.claim.claimId
        || current.claim.ownerEpoch !== input.claim.ownerEpoch
      ) {
        throw new HandoffDeliveryClaimConflictError(
          `Handoff delivery ${deliveryId} claim is stale: recipient ${input.claim.recipientBotId}`
            + ` claim ${input.claim.claimId}`
            + ` epoch ${input.claim.ownerEpoch} does not match the current claim`,
        );
      }
    }
    if (typeof input.code !== 'string' || !input.code.trim()) throw new Error('failure.code must be non-empty');

    const {
      claim: _droppedClaim,
      failure: _previousFailure,
      resultUnread: _previousUnread,
      resultReadTaskVersion: _previousReadVersion,
      ...rest
    } = current;
    const next: HandoffDeliveryRecord = {
      ...rest,
      version: current.version + 1,
      mailState: 'delivery-failed',
      failure: {
        code: input.code,
        message: input.message,
        at: this.clock(),
      },
      updatedAt: this.clock(),
    };
    return this.commit(next);
  }

  attachSpawnTask(deliveryId: string, spawnTaskId: string): HandoffDeliveryRecord {
    const current = this.require(deliveryId);
    const validatedTaskId = assertHandoffPathId(spawnTaskId, 'spawnTaskId');
    if (current.mailState !== 'pending' && current.mailState !== 'claimed') {
      throw new Error(`Cannot attach a spawned task to handoff delivery in state ${current.mailState}`);
    }
    if (current.spawnTaskId !== undefined) {
      if (current.spawnTaskId === validatedTaskId) return clone(current);
      throw new Error(`Handoff delivery ${deliveryId} is already attached to spawned task ${current.spawnTaskId}`);
    }
    const next: HandoffDeliveryRecord = {
      ...current,
      version: current.version + 1,
      spawnTaskId: validatedTaskId,
      updatedAt: this.clock(),
    };
    return this.commit(next);
  }

  markResultUnread(deliveryId: string, input: MarkHandoffResultUnreadInput): HandoffDeliveryRecord {
    const current = this.require(deliveryId);
    if (current.mailState !== 'acknowledged') {
      throw new Error(
        `Handoff delivery ${deliveryId} must be acknowledged to mark task results unread, not ${current.mailState}`,
      );
    }
    assertPositiveSafeInteger(input.taskVersion, 'taskVersion');
    assertIsoTimestamp(input.at, 'at');
    if (current.resultUnread && input.taskVersion <= current.resultUnread.taskVersion) return clone(current);
    if (current.resultReadTaskVersion !== undefined && input.taskVersion <= current.resultReadTaskVersion) {
      return clone(current);
    }
    const next: HandoffDeliveryRecord = {
      ...current,
      version: current.version + 1,
      resultUnread: { taskVersion: input.taskVersion, at: input.at },
      updatedAt: this.clock(),
    };
    return this.commit(next);
  }

  markResultRead(deliveryId: string, input: MarkHandoffResultReadInput): HandoffDeliveryRecord {
    const current = this.require(deliveryId);
    assertPositiveSafeInteger(input.expectedTaskVersion, 'expectedTaskVersion');
    if (!current.resultUnread || current.resultUnread.taskVersion !== input.expectedTaskVersion) {
      throw new Error(
        `Handoff delivery ${deliveryId} unread task version ${current.resultUnread?.taskVersion ?? 'none'}`
          + ` does not match expected ${input.expectedTaskVersion}`,
      );
    }
    const { resultUnread: _cleared, ...rest } = current;
    const next: HandoffDeliveryRecord = {
      ...rest,
      version: current.version + 1,
      resultReadTaskVersion: input.expectedTaskVersion,
      updatedAt: this.clock(),
    };
    return this.commit(next);
  }

  reload(): void {
    this.deliveries.clear();
    this.byHandoff.clear();
    this.byConversation.clear();
    this.loadErrors.clear();

    for (const entry of readdirSync(handoffDeliveriesPath(this.rootPath), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) {
        this.loadErrors.set(entry.name, 'Handoff delivery directory must not be a symbolic link');
        continue;
      }
      if (!entry.isDirectory()) continue;
      try {
        assertHandoffPathId(entry.name, 'delivery directory');
        const recordPath = handoffDeliveryRecordPath(this.rootPath, entry.name);
        assertNotSymlink(recordPath, 'handoff delivery record');
        assertRegularFile(recordPath, 'handoff delivery record');
        const raw = readJsonFile(recordPath);
        if (!raw) throw new Error('Handoff delivery record is missing');
        const record = assertHandoffDeliveryRecord(raw);
        if (record.deliveryId !== entry.name) {
          throw new Error(`Handoff delivery ownership mismatch for ${entry.name}`);
        }
        this.index(record);
      } catch (error) {
        this.loadErrors.set(entry.name, error instanceof Error ? error.message : String(error));
      }
    }
  }

  getLoadErrors(): Readonly<Record<string, string>> {
    return Object.freeze(Object.fromEntries(this.loadErrors));
  }

  private require(deliveryId: string): HandoffDeliveryRecord {
    assertHandoffPathId(deliveryId, 'deliveryId');
    const record = this.deliveries.get(deliveryId);
    if (!record) throw new Error(`Handoff delivery not found: ${deliveryId}`);
    return record;
  }

  private assertMailTransition(from: HandoffMailState, to: HandoffMailState): void {
    if (!HANDOFF_MAIL_TRANSITIONS[from].includes(to)) {
      throw new Error(`Illegal handoff mail transition: ${from} -> ${to}`);
    }
  }

  private commit(next: HandoffDeliveryRecord): HandoffDeliveryRecord {
    const validated = assertHandoffDeliveryRecord(next);
    const recordPath = handoffDeliveryRecordPath(this.rootPath, validated.deliveryId);
    assertNotSymlink(recordPath, 'handoff delivery record');
    writeJsonRecord(recordPath, validated);
    this.index(validated);
    return clone(validated);
  }

  private index(record: HandoffDeliveryRecord): void {
    const owner = this.byHandoff.get(record.handoffId);
    if (owner && owner !== record.deliveryId) {
      throw new Error(`Duplicate handoff ID: ${record.handoffId}`);
    }
    const previous = this.deliveries.get(record.deliveryId);
    if (previous && previous.conversationId !== record.conversationId) {
      this.byConversation.get(previous.conversationId)?.delete(record.deliveryId);
    }
    this.deliveries.set(record.deliveryId, clone(record));
    this.byHandoff.set(record.handoffId, record.deliveryId);
    const conversationDeliveries = this.byConversation.get(record.conversationId) ?? new Set<string>();
    conversationDeliveries.add(record.deliveryId);
    this.byConversation.set(record.conversationId, conversationDeliveries);
  }

  private claimHandoffPointer(handoffId: string, deliveryId: string): boolean {
    const pointerPath = handoffByHandoffPath(this.rootPath, handoffId);
    assertNotSymlink(pointerPath, 'handoff ID pointer');
    return writeJsonIfAbsent(pointerPath, { deliveryId });
  }

  private readByHandoffPointer(handoffId: string): string | null {
    const pointerPath = handoffByHandoffPath(this.rootPath, handoffId);
    assertNotSymlink(pointerPath, 'handoff ID pointer');
    if (!existsSync(pointerPath)) return null;
    assertRegularFile(pointerPath, 'handoff ID pointer');
    const raw = readJsonFile(pointerPath);
    if (raw === null) return null;
    if (typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 1
      || !Object.hasOwn(raw, 'deliveryId')) {
      throw new Error(`Handoff ${handoffId} has an invalid delivery pointer`);
    }
    return assertHandoffPathId((raw as Record<string, unknown>).deliveryId, 'handoff pointer deliveryId');
  }

  private discardDelivery(deliveryId: string): void {
    const deliveryPath = join(handoffDeliveriesPath(this.rootPath), deliveryId);
    assertNotSymlink(deliveryPath, 'handoff delivery directory');
    if (existsSync(deliveryPath)) rmSync(deliveryPath, { recursive: true, force: true });
    syncDirectory(handoffDeliveriesPath(this.rootPath));
  }
}
