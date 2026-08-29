/**
 * Canonical bot-to-bot handoff delivery contract.
 *
 * Mail states describe the public delivery envelope only. Delegated execution
 * state lives exclusively in SpawnTask (see `spawn-task.ts`) and is referenced
 * by ID, never copied into the mail.
 */

import type { SpawnTaskView } from './spawn-task.ts';

export const HANDOFF_SCHEMA_VERSION = 1 as const;

/** Bounds are UTF-8 byte counts, not JavaScript string lengths. */
export const HANDOFF_LIMITS = Object.freeze({
  requestBytes: 16 * 1024,
  deliveryFailureMessageBytes: 4 * 1024,
});

/** `handoff_<uuid>` */
export type HandoffId = string;
/** `delivery_<uuid>` */
export type HandoffDeliveryId = string;
/** `claim_<uuid>` */
export type DeliveryClaimId = string;

/** Mail states ONLY. Execution state lives exclusively in SpawnTask; never duplicated here. */
export const HANDOFF_MAIL_STATES = [
  'pending',
  'claimed',
  'acknowledged',
  'delivery-failed',
] as const;

export type HandoffMailState = (typeof HANDOFF_MAIL_STATES)[number];

/** Fencing claim over a delivery. A stale claimant cannot acknowledge or dispatch. */
export interface HandoffDeliveryClaim {
  readonly claimId: DeliveryClaimId;
  /** Starts at 1 on first claim, +1 per re-claim. */
  readonly ownerEpoch: number;
  readonly claimedAt: string;
}

export interface HandoffDeliveryFailure {
  readonly code: string;
  /** Bounded per HANDOFF_LIMITS.deliveryFailureMessageBytes (UTF-8 bytes). */
  readonly message: string;
  readonly at: string;
}

interface HandoffDeliveryBase {
  readonly schemaVersion: typeof HANDOFF_SCHEMA_VERSION;
  /** Monotonic delivery freshness, independent of SpawnTask.version. */
  readonly version: number;
  readonly deliveryId: HandoffDeliveryId;
  readonly handoffId: HandoffId;
  readonly workspaceId: string;
  /** `chat_<uuid>` or `channel_<uuid>` */
  readonly conversationId: string;
  readonly sourceBotId: string;
  readonly targetBotId: string;
  /** Bounded per HANDOFF_LIMITS.requestBytes (UTF-8 bytes). */
  readonly request: string;
  /** Canonical SpawnTask ID once reserved. Mail references the task; never copies its state. */
  readonly spawnTaskId?: string;
  readonly claim?: HandoffDeliveryClaim;
  readonly failure?: HandoffDeliveryFailure;
  /** Task-result unread, versioned independently of transcript unread. */
  readonly resultUnread?: { readonly taskVersion: number; readonly at: string };
  readonly resultReadTaskVersion?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type HandoffDeliveryPending = HandoffDeliveryBase & {
  readonly mailState: 'pending';
  readonly claim?: never;
  readonly failure?: never;
  readonly resultUnread?: never;
  readonly resultReadTaskVersion?: never;
};

export type HandoffDeliveryClaimed = HandoffDeliveryBase & {
  readonly mailState: 'claimed';
  readonly spawnTaskId: string;
  readonly claim: HandoffDeliveryClaim;
  readonly failure?: never;
  readonly resultUnread?: never;
  readonly resultReadTaskVersion?: never;
};

export type HandoffDeliveryAcknowledged = HandoffDeliveryBase & {
  readonly mailState: 'acknowledged';
  readonly spawnTaskId: string;
  readonly claim: HandoffDeliveryClaim;
  readonly failure?: never;
};

export type HandoffDeliveryFailed = HandoffDeliveryBase & {
  readonly mailState: 'delivery-failed';
  readonly claim?: never;
  readonly failure: HandoffDeliveryFailure;
  readonly resultUnread?: never;
  readonly resultReadTaskVersion?: never;
};

/** Durable handoff mail record. Identity and delegation-target fields never change. */
export type HandoffDeliveryRecord =
  | HandoffDeliveryPending
  | HandoffDeliveryClaimed
  | HandoffDeliveryAcknowledged
  | HandoffDeliveryFailed;

export const HANDOFF_MAIL_TRANSITIONS: Readonly<Record<HandoffMailState, readonly HandoffMailState[]>> = Object.freeze({
  pending: ['claimed', 'delivery-failed'],
  claimed: ['acknowledged', 'delivery-failed'],
  acknowledged: [],
  'delivery-failed': [],
});

/** Authorized SpawnTaskView for public handoff consumers: internal provider Session IDs omitted. */
export type HandoffTaskView = Pick<
  SpawnTaskView,
  | 'taskId'
  | 'version'
  | 'runtimeState'
  | 'stateTimestamps'
  | 'awaitingInput'
  | 'cancellation'
  | 'result'
  | 'failure'
  | 'integrityError'
>;
