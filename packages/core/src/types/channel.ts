/**
 * Canonical Channel, membership, and routing contract.
 *
 * A Channel is a durable group conversation holding the user and several Bots.
 * An ordinary message is offered to every eligible member and each one claims
 * or declines; a mention names its owner outright. Every executable response
 * stage has exactly one owner. Journal sequence is authoritative and timestamps
 * are informational.
 */

import type { BotId } from './bot.ts';
import type { JournalEntryId } from './conversation.ts';

export const CHANNEL_SCHEMA_VERSION = 1 as const;

/** Bounds are UTF-8 byte counts, not JavaScript string lengths. */
export const CHANNEL_LIMITS = Object.freeze({
  nameBytes: 256,
  reasonBytes: 2 * 1024,
  maxMembers: 64,
  /** Bounded claim window. A claim that misses it is a decline. */
  claimWindowMs: 10_000,
});

export const CHANNEL_LIFECYCLES = ['active', 'archived'] as const;
export type ChannelLifecycle = (typeof CHANNEL_LIFECYCLES)[number];

export const ROUTE_MODES = ['explicit', 'autonomous'] as const;
export type RouteMode = (typeof ROUTE_MODES)[number];

export const ROUTE_STAGE_STATES = ['committed', 'dispatched', 'completed', 'cancelled', 'failed'] as const;
export type RouteStageState = (typeof ROUTE_STAGE_STATES)[number];

export const CLAIM_OUTCOMES = ['claimed', 'declined', 'malformed', 'timeout', 'error'] as const;
export type ClaimOutcome = (typeof CLAIM_OUTCOMES)[number];

export const ROUTE_BLOCK_REASONS = ['no-eligible-members', 'no-claim'] as const;
export type RouteBlockReason = (typeof ROUTE_BLOCK_REASONS)[number];

export const STAGE_CANCEL_REASONS = ['membership-changed', 'channel-archived'] as const;
export type StageCancelReason = (typeof STAGE_CANCEL_REASONS)[number];

export const MEMBER_AVAILABILITIES = ['idle', 'busy'] as const;
export type MemberAvailability = (typeof MEMBER_AVAILABILITIES)[number];

/** `channel_<uuid>` */
export type ChannelId = string;
/** `route_<hash>` */
export type RouteId = string;
/** `<routeId>.s<index>` */
export type StageId = string;

export interface ChannelMember {
  readonly botId: BotId;
  /** Lower value wins a confidence tie. Assigned once, at add time. */
  readonly priority: number;
  readonly addedAt: string;
}

export interface ChannelRecord {
  readonly schemaVersion: typeof CHANNEL_SCHEMA_VERSION;
  readonly channelId: ChannelId;
  readonly workspaceId: string;
  readonly name: string;
  readonly lifecycle: ChannelLifecycle;
  /** Increments on every committed membership write. */
  readonly membershipRevision: number;
  readonly members: readonly ChannelMember[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt?: string;
}

export interface ChannelPublicDto {
  readonly channelId: ChannelId;
  readonly workspaceId: string;
  readonly name: string;
  readonly lifecycle: ChannelLifecycle;
  readonly membershipRevision: number;
  readonly members: readonly ChannelMember[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt?: string;
}

/** One member's answer to one offer. Every non-`claimed` outcome is a decline. */
export interface RouteClaim {
  readonly botId: BotId;
  readonly outcome: ClaimOutcome;
  readonly claim: boolean;
  /** 0..100. Zero for every decline. */
  readonly confidence: number;
  readonly reason: string;
  readonly latencyMs: number;
  readonly receivedAt: string;
}

/** One owned unit of executable response. Exactly one owner, fenced by epoch. */
export interface RouteStage {
  readonly stageId: StageId;
  readonly ownerBotId: BotId;
  /** The route sequence that granted ownership. A mismatch means a stale dispatch. */
  readonly ownerEpoch: number;
  readonly dispatchIdempotencyKey: string;
  readonly state: RouteStageState;
  readonly reason?: string;
  readonly committedAt: string;
  readonly dispatchedAt?: string;
  readonly settledAt?: string;
}

export interface RouteRecord {
  readonly schemaVersion: typeof CHANNEL_SCHEMA_VERSION;
  readonly routeId: RouteId;
  readonly channelId: ChannelId;
  readonly workspaceId: string;
  /** The journal sequence of the message that opened the route. */
  readonly routeSeq: number;
  readonly messageEntryId: JournalEntryId;
  readonly mode: RouteMode;
  readonly membershipRevision: number;
  readonly eligibleBotIds: readonly BotId[];
  readonly offerDeadline: string;
  readonly claims: readonly RouteClaim[];
  readonly stages: readonly RouteStage[];
  readonly blockedReason?: RouteBlockReason;
  readonly createdAt: string;
  readonly updatedAt: string;
}
