import {
  CHANNEL_SCHEMA_VERSION,
  CHANNEL_LIMITS,
  type ChannelMember,
  type JournalEntry,
  type RouteClaim,
  type RouteRecord,
  type RouteStage,
} from '@kata-sh/core';
import { i18n, setupI18n } from '../i18n/index.ts';
import { ConversationJournal } from '../conversations/index.ts';
import { dispatchIdempotencyKey, deriveRouteId, stageId } from './ids.ts';
import { parseChannelMentions, type ParsedChannelMentions } from './mentions.ts';
import { buildClaimPrompt, parseClaimResponse, type ClaimEvaluator, type ClaimRequest } from './claims.ts';
import { ChannelDirectory, type ChannelBotView } from './directory.ts';
import { RouteStore } from './routes.ts';

export interface DispatchRequest {
  readonly channelId: string;
  readonly channelName: string;
  readonly routeId: string;
  readonly stageId: string;
  readonly ownerBotId: string;
  readonly ownerEpoch: number;
  readonly dispatchIdempotencyKey: string;
  readonly message: string;
  readonly memberNames: readonly string[];
  readonly isFirstDispatch: boolean;
}

export type StageDispatcher = (request: DispatchRequest) => Promise<string>;

export interface ChannelRouterOptions {
  readonly directory: ChannelDirectory;
  readonly journal: ConversationJournal;
  readonly routes: RouteStore;
  readonly evaluateClaim: ClaimEvaluator;
  readonly dispatch: StageDispatcher;
  /** Called after a route is durably committed and before any stage dispatch. */
  readonly onRouteCommitted?: (route: RouteRecord) => void;
  readonly clock?: () => string;
  readonly claimWindowMs?: number;
}

export interface SendChannelMessageResult {
  readonly userEntry: JournalEntry;
  readonly route: RouteRecord;
  readonly replies: readonly JournalEntry[];
}

export class ChannelMentionError extends Error {
  readonly unresolved: readonly string[];

  constructor(unresolved: readonly string[]) {
    super(`Unknown Channel mention: ${unresolved.map((token) => `@${token}`).join(', ')}`);
    this.name = 'ChannelMentionError';
    this.unresolved = [...unresolved];
  }
}

interface MemberSnapshot {
  readonly member: ChannelMember;
  readonly bot: ChannelBotView | null;
}

interface ClaimResult {
  readonly claim: RouteClaim;
  readonly member: MemberSnapshot;
}

const routeQueues = new Map<string, Promise<void>>();

const CLAIM_SCHEMA = {
  type: 'object',
  properties: {
    claim: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 100 },
    reason: { type: 'string' },
  },
  required: ['claim', 'confidence', 'reason'],
  additionalProperties: false,
} as const;

function trimReason(reason: string): string {
  if (Buffer.byteLength(reason, 'utf8') <= CHANNEL_LIMITS.reasonBytes) return reason;
  let result = reason;
  while (Buffer.byteLength(result, 'utf8') > CHANNEL_LIMITS.reasonBytes) result = result.slice(0, -1);
  return result;
}

function memberSort(left: MemberSnapshot, right: MemberSnapshot): number {
  return left.member.priority - right.member.priority || left.member.botId.localeCompare(right.member.botId);
}

function deadlineIso(start: string, windowMs: number): string {
  const now = Date.parse(start);
  if (!Number.isFinite(now)) throw new Error('Channel clock must return an ISO timestamp');
  return new Date(now + windowMs).toISOString();
}

function safeDate(clock: () => string): string {
  const value = clock();
  if (!Number.isFinite(Date.parse(value))) throw new Error('Channel clock must return an ISO timestamp');
  return value;
}

async function withRouteQueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prior = routeQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve });
  const queued = prior.then(() => current);
  routeQueues.set(key, queued);
  await prior;
  try {
    return await task();
  } finally {
    release();
    if (routeQueues.get(key) === queued) routeQueues.delete(key);
  }
}

function blockedMessage(reason: 'no-claim' | 'no-eligible-members'): string {
  if (!i18n.isInitialized) setupI18n();
  const key = reason === 'no-claim' ? 'channels.blockedNoClaim' : 'channels.blockedNoMembers';
  return i18n.t(key);
}

export class ChannelRouter {
  private readonly directory: ChannelDirectory;
  private readonly journal: ConversationJournal;
  private readonly routes: RouteStore;
  private readonly evaluateClaim: ClaimEvaluator;
  private readonly dispatch: StageDispatcher;
  private readonly onRouteCommitted: ((route: RouteRecord) => void) | undefined;
  private readonly clock: () => string;
  private readonly claimWindowMs: number;

  constructor(options: ChannelRouterOptions) {
    this.directory = options.directory;
    this.journal = options.journal;
    this.routes = options.routes;
    this.evaluateClaim = options.evaluateClaim;
    this.dispatch = options.dispatch;
    this.onRouteCommitted = options.onRouteCommitted;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.claimWindowMs = options.claimWindowMs ?? CHANNEL_LIMITS.claimWindowMs;
    if (!Number.isSafeInteger(this.claimWindowMs) || this.claimWindowMs < 0) throw new Error('claimWindowMs must be a non-negative safe integer');
  }

  async send(input: { channelId: string; message: string; idempotencyKey: string }): Promise<SendChannelMessageResult> {
    const channel = this.directory.getChannel(input.channelId);
    if (!channel) throw new Error(`Channel not found: ${input.channelId}`);
    if (channel.lifecycle !== 'active') throw new Error(`Channel is archived: ${input.channelId}`);

    const snapshot = channel.members.map((member) => ({ member, bot: this.directory.resolveBot(member.botId) }));
    const mentions = parseChannelMentions(
      input.message,
      snapshot.flatMap(({ bot }) => bot ? [{ botId: bot.botId, name: bot.name }] : []),
    );
    if (mentions.unresolved.length > 0) throw new ChannelMentionError(mentions.unresolved);

    const userEntry = this.journal.append({
      conversationId: channel.channelId,
      kind: 'user',
      body: input.message,
      idempotencyKey: input.idempotencyKey,
    });
    const routeId = deriveRouteId(channel.channelId, userEntry.entryId);
    return withRouteQueue(`${this.routes.rootPath}/${channel.channelId}/${routeId}`, async () => {
      const existing = this.routes.get(channel.channelId, routeId);
      if (existing) {
        this.onRouteCommitted?.(existing);
        return this.finish(existing, userEntry);
      }

      const eligible = snapshot.filter(({ bot }) => bot?.lifecycle === 'active').sort(memberSort);
      const mode = mentions.botIds.length > 0 || mentions.everyone ? 'explicit' : 'autonomous';
      const now = safeDate(this.clock);
      const offerDeadline = mode === 'autonomous' ? deadlineIso(now, this.claimWindowMs) : now;
      const claims = mode === 'explicit'
        ? this.explicitClaims(snapshot, mentions)
        : await this.autonomousClaims(channel.channelId, channel.name, routeId, input.message, eligible);

      const targets = mode === 'explicit'
        ? eligible.filter(({ member }) => mentions.everyone || mentions.botIds.includes(member.botId))
        : this.autonomousWinners(claims, eligible);
      const blockedReason = targets.length === 0
        ? (mode === 'autonomous' && eligible.length === 0 ? 'no-eligible-members' : 'no-claim')
        : undefined;
      const route: RouteRecord = {
        schemaVersion: CHANNEL_SCHEMA_VERSION,
        routeId,
        channelId: channel.channelId,
        workspaceId: channel.workspaceId,
        routeSeq: userEntry.seq,
        messageEntryId: userEntry.entryId,
        mode,
        membershipRevision: channel.membershipRevision,
        eligibleBotIds: eligible.map(({ member }) => member.botId),
        offerDeadline,
        claims,
        stages: targets
          .sort(memberSort)
          .map(({ member }, index) => this.newStage(routeId, member.botId, userEntry.seq, index, now)),
        ...(blockedReason ? { blockedReason } : {}),
        createdAt: now,
        updatedAt: now,
      };
      const committed = this.routes.commit(route);
      this.onRouteCommitted?.(committed);
      return this.finish(committed, userEntry);
    });
  }

  async recover(channelId: string): Promise<RouteRecord[]> {
    const recovered: RouteRecord[] = [];
    for (const route of this.routes.list(channelId)) {
      if (!route.stages.some((stage) => stage.state === 'committed' || stage.state === 'dispatched')) continue;
      const userEntry = this.journal.getEntry(channelId, route.messageEntryId);
      if (!userEntry) continue;
      const result = await withRouteQueue(`${this.routes.rootPath}/${channelId}/${route.routeId}`, async () => {
        const current = this.routes.get(channelId, route.routeId);
        if (!current || !current.stages.some((stage) => stage.state === 'committed' || stage.state === 'dispatched')) return null;
        return this.finish(current, userEntry);
      });
      if (result) recovered.push(result.route);
    }
    return recovered;
  }

  private explicitClaims(snapshot: readonly MemberSnapshot[], mentions: ParsedChannelMentions): RouteClaim[] {
    const targetIds = new Set(mentions.everyone ? snapshot.map(({ member }) => member.botId) : mentions.botIds);
    return snapshot
      .filter(({ member }) => targetIds.has(member.botId))
      .sort(memberSort)
      .map(({ member, bot }) => ({
        botId: member.botId,
        outcome: bot?.lifecycle === 'active' ? 'claimed' : 'declined',
        claim: bot?.lifecycle === 'active',
        confidence: bot?.lifecycle === 'active' ? 100 : 0,
        reason: bot?.lifecycle === 'active' ? 'explicit mention' : 'ineligible',
        latencyMs: 0,
        receivedAt: safeDate(this.clock),
      }));
  }

  private async autonomousClaims(
    channelId: string,
    channelName: string,
    routeId: string,
    message: string,
    eligible: readonly MemberSnapshot[],
  ): Promise<RouteClaim[]> {
    if (eligible.length === 0) return [];
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadlineResult = new Promise<{ kind: 'timeout' }>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ kind: 'timeout' });
      }, this.claimWindowMs);
    });

    const results = await Promise.all(eligible.map(async (member): Promise<ClaimResult> => {
      const startedAt = Date.now();
      const request: ClaimRequest = {
        channelId,
        channelName,
        routeId,
        botId: member.member.botId,
        botName: member.bot?.name ?? member.member.botId,
        ...(member.bot?.profile !== undefined ? { profile: member.bot.profile } : {}),
        availability: 'idle',
        message,
      };
      const attempt = Promise.resolve()
        .then(() => this.evaluateClaim(request, controller.signal))
        .then((raw) => ({ kind: 'response' as const, raw }))
        .catch((error: unknown) => ({ kind: 'error' as const, error }));
      const result = await Promise.race([attempt, deadlineResult]);
      const latencyMs = Math.max(0, Date.now() - startedAt);
      if (result.kind === 'timeout' || Date.now() - startedAt >= this.claimWindowMs) {
        return {
          member,
          claim: {
            botId: member.member.botId,
            outcome: 'timeout',
            claim: false,
            confidence: 0,
            reason: 'claim window expired',
            latencyMs,
            receivedAt: safeDate(this.clock),
          },
        };
      }
      if (result.kind === 'error') {
        const reason = result.error instanceof Error ? result.error.message : String(result.error);
        return {
          member,
          claim: {
            botId: member.member.botId,
            outcome: 'error',
            claim: false,
            confidence: 0,
            reason: trimReason(reason),
            latencyMs,
            receivedAt: safeDate(this.clock),
          },
        };
      }
      const parsed = parseClaimResponse(result.raw);
      if (!parsed) {
        return {
          member,
          claim: {
            botId: member.member.botId,
            outcome: 'malformed',
            claim: false,
            confidence: 0,
            reason: 'malformed claim response',
            latencyMs,
            receivedAt: safeDate(this.clock),
          },
        };
      }
      return {
        member,
        claim: {
          botId: member.member.botId,
          outcome: parsed.claim ? 'claimed' : 'declined',
          claim: parsed.claim,
          confidence: parsed.claim ? parsed.confidence : 0,
          reason: trimReason(parsed.reason),
          latencyMs,
          receivedAt: safeDate(this.clock),
        },
      };
    }));
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
    return results.sort((left, right) => memberSort(left.member, right.member)).map(({ claim }) => claim);
  }

  private autonomousWinners(claims: readonly RouteClaim[], eligible: readonly MemberSnapshot[]): MemberSnapshot[] {
    const winner = claims
      .filter((claim) => claim.outcome === 'claimed' && claim.claim)
      .sort((left, right) => {
        const leftMember = eligible.find(({ member }) => member.botId === left.botId)?.member;
        const rightMember = eligible.find(({ member }) => member.botId === right.botId)?.member;
        return right.confidence - left.confidence
          || (leftMember?.priority ?? Number.MAX_SAFE_INTEGER) - (rightMember?.priority ?? Number.MAX_SAFE_INTEGER)
          || left.botId.localeCompare(right.botId);
      })[0];
    return winner ? eligible.filter(({ member }) => member.botId === winner.botId) : [];
  }

  private newStage(routeId: string, ownerBotId: string, ownerEpoch: number, index: number, committedAt: string): RouteStage {
    const id = stageId(routeId, index);
    return {
      stageId: id,
      ownerBotId,
      ownerEpoch,
      dispatchIdempotencyKey: dispatchIdempotencyKey(id),
      state: 'committed',
      committedAt,
    };
  }

  private async finish(route: RouteRecord, userEntry: JournalEntry): Promise<SendChannelMessageResult> {
    let current = route;
    if (current.blockedReason) {
      this.journal.append({
        conversationId: current.channelId,
        kind: 'error',
        body: blockedMessage(current.blockedReason),
        idempotencyKey: `route.error.${current.routeId}`,
      });
    } else {
      current = await this.settle(current, userEntry.body);
    }
    return { userEntry, route: current, replies: this.repliesFor(current) };
  }

  private async settle(route: RouteRecord, message: string): Promise<RouteRecord> {
    let current = route;
    const channel = this.directory.getChannel(route.channelId);
    for (const stage of current.stages) {
      const latest = current.stages.find((candidate) => candidate.stageId === stage.stageId);
      if (!latest || (latest.state !== 'committed' && latest.state !== 'dispatched')) continue;
      if (latest.ownerEpoch !== current.routeSeq) continue;

      const ownerStillMember = channel?.members.some((member) => member.botId === latest.ownerBotId) ?? false;
      if (latest.state === 'committed' && (!ownerStillMember || channel?.lifecycle !== 'active')) {
        const reason = channel?.lifecycle === 'archived' ? 'channel-archived' : 'membership-changed';
        current = this.updateStage(current, latest.stageId, {
          state: 'cancelled',
          reason,
          settledAt: safeDate(this.clock),
        });
        this.journal.append({
          conversationId: current.channelId,
          kind: 'lifecycle',
          body: `Stage ${latest.stageId} for Bot ${latest.ownerBotId} cancelled: ${reason}.`,
          idempotencyKey: `stage.cancelled.${latest.stageId}`,
        });
        continue;
      }

      if (latest.state === 'committed') {
        current = this.updateStage(current, latest.stageId, {
          state: 'dispatched',
          dispatchedAt: safeDate(this.clock),
        });
      }
      const owner = this.directory.resolveBot(latest.ownerBotId);
      if (!owner) {
        current = await this.failStage(current, latest, 'Bot is no longer available');
        continue;
      }
      try {
        const reply = await this.dispatch({
          channelId: current.channelId,
          channelName: channel?.name ?? current.channelId,
          routeId: current.routeId,
          stageId: latest.stageId,
          ownerBotId: latest.ownerBotId,
          ownerEpoch: latest.ownerEpoch,
          dispatchIdempotencyKey: latest.dispatchIdempotencyKey,
          message,
          memberNames: channel?.members.flatMap((member) => {
            const bot = this.directory.resolveBot(member.botId);
            return bot ? [bot.name] : [];
          }) ?? [],
          isFirstDispatch: !this.routes.list(current.channelId).some((candidate) => candidate.routeId !== current.routeId && candidate.stages.some((candidateStage) => candidateStage.ownerBotId === latest.ownerBotId && (candidateStage.state === 'completed' || candidateStage.state === 'dispatched'))),
        });
        this.journal.append({
          conversationId: current.channelId,
          authorBotId: latest.ownerBotId,
          kind: 'bot',
          body: reply,
          idempotencyKey: latest.dispatchIdempotencyKey,
        });
        current = this.updateStage(current, latest.stageId, {
          state: 'completed',
          settledAt: safeDate(this.clock),
        });
      } catch (error) {
        const reason = trimReason(error instanceof Error ? error.message : String(error));
        current = await this.failStage(current, latest, reason);
      }
    }
    return current;
  }

  private async failStage(route: RouteRecord, stage: RouteStage, reason: string): Promise<RouteRecord> {
    const current = this.updateStage(route, stage.stageId, {
      state: 'failed',
      reason,
      settledAt: safeDate(this.clock),
    });
    this.journal.append({
      conversationId: current.channelId,
      kind: 'error',
      body: reason,
      idempotencyKey: `stage.error.${stage.stageId}`,
    });
    return current;
  }

  private updateStage(route: RouteRecord, stageIdToUpdate: string, patch: Partial<RouteStage>): RouteRecord {
    const stages = route.stages.map((stage) => stage.stageId === stageIdToUpdate ? { ...stage, ...patch } : stage);
    return this.routes.update({ ...route, stages, updatedAt: safeDate(this.clock) });
  }

  private repliesFor(route: RouteRecord): JournalEntry[] {
    const keys = new Set(route.stages.map((stage) => stage.dispatchIdempotencyKey));
    return this.journal.list(route.channelId).filter((entry) => entry.kind === 'bot' && keys.has(entry.idempotencyKey));
  }
}

export { CLAIM_SCHEMA };
