import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import type { RouteRecord } from '@kata-sh/core';
import { ChannelDirectory } from '../src/channels/directory.ts';
import { createChannelJournal } from '../src/channels/conversation.ts';
import { ChannelRouter, ChannelMentionError, type DispatchRequest } from '../src/channels/router.ts';
import { RouteStore } from '../src/channels/routes.ts';
import { dispatchIdempotencyKey, stageId } from '../src/channels/ids.ts';

function makeFixture(options?: {
  claimWindowMs?: number;
  bots?: Record<string, { name: string; lifecycle: 'active' | 'hidden' | 'archived'; profile?: string }>;
  evaluate?: (botId: string) => Promise<string | null>;
  dispatch?: (ownerBotId: string, request: DispatchRequest) => Promise<string>;
  onRouteCommitted?: (route: RouteRecord) => void;
}) {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'kata-channel-router-'));
  const botRecords = new Map(Object.entries(options?.bots ?? {
    'bot-a': { name: 'Alpha Bot', lifecycle: 'active' as const, profile: 'research' },
    'bot-b': { name: 'Beta Bot', lifecycle: 'active' as const, profile: 'release' },
  }));
  let id = 0;
  let tick = 0;
  const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, tick++)).toISOString();
  const directory = new ChannelDirectory({
    workspaceRoot,
    workspaceId: 'workspace-one',
    clock,
    randomId: () => `channel-${id++}`,
    resolveBot: (botId) => {
      const bot = botRecords.get(botId);
      return bot ? { botId, ...bot } : null;
    },
  });
  const channel = directory.createChannel({ name: 'Engineering', idempotencyKey: 'channel-create' });
  for (const botId of botRecords.keys()) directory.addMember(channel.channelId, botId);
  const journal = createChannelJournal({ workspaceRoot, workspaceId: 'workspace-one', directory, clock });
  const routes = new RouteStore({ workspaceRoot, workspaceId: 'workspace-one', clock });
  let dispatchCount = 0;
  const router = new ChannelRouter({
    directory,
    journal,
    routes,
    clock,
    claimWindowMs: options?.claimWindowMs ?? 100,
    evaluateClaim: async (request) => options?.evaluate?.(request.botId) ?? JSON.stringify({ claim: true, confidence: request.botId === 'bot-a' ? 80 : 60, reason: request.botId }),
    dispatch: async (request) => {
      dispatchCount += 1;
      return options?.dispatch?.(request.ownerBotId, request) ?? `reply from ${request.ownerBotId}`;
    },
    onRouteCommitted: options?.onRouteCommitted,
  });
  return { directory, journal, routes, router, channel, botRecords, get dispatchCount() { return dispatchCount; } };
}

describe('ChannelRouter', () => {
  it('selects the highest-confidence autonomous claimant and persists evidence', async () => {
    const fixture = makeFixture();
    const result = await fixture.router.send({ channelId: fixture.channel.channelId, message: 'Which owner should handle this?', idempotencyKey: 'send-1' });

    expect(result.route.mode).toBe('autonomous');
    expect(result.route.membershipRevision).toBe(3);
    expect(result.route.routeSeq).toBe(result.userEntry.seq);
    expect(Date.parse(result.route.offerDeadline) - Date.parse(result.route.createdAt)).toBe(100);
    expect(result.route.claims.map((claim) => claim.outcome)).toEqual(['claimed', 'claimed']);
    expect(result.route.stages).toHaveLength(1);
    expect(result.route.stages[0]?.ownerBotId).toBe('bot-a');
    expect(result.route.stages[0]?.ownerEpoch).toBe(result.route.routeSeq);
    expect(result.route.stages[0]?.dispatchIdempotencyKey).toBe(dispatchIdempotencyKey(result.route.stages[0]?.stageId ?? ''));
    expect(result.replies).toHaveLength(1);
  });

  it('notifies after durable commit and before provider dispatch', async () => {
    const events: string[] = [];
    let committed: RouteRecord | undefined;
    const fixture = makeFixture({
      onRouteCommitted: (route) => {
        events.push('committed');
        committed = route;
      },
      dispatch: async () => {
        events.push('dispatched');
        return 'reply';
      },
    });

    const result = await fixture.router.send({
      channelId: fixture.channel.channelId,
      message: 'notify me',
      idempotencyKey: 'send-committed-callback',
    });

    expect(events).toEqual(['committed', 'dispatched']);
    expect(committed?.routeId).toBe(result.route.routeId);
    expect(committed?.stages[0]?.state).toBe('committed');
  });

  it('breaks equal confidence by Channel priority', async () => {
    const fixture = makeFixture({
      bots: {
        'bot-a': { name: 'Alpha', lifecycle: 'active' },
        'bot-b': { name: 'Beta', lifecycle: 'active' },
      },
      evaluate: async () => JSON.stringify({ claim: true, confidence: 50, reason: 'tie' }),
    });
    fixture.directory.removeMember(fixture.channel.channelId, 'bot-a');
    fixture.directory.addMember(fixture.channel.channelId, 'bot-a');
    const result = await fixture.router.send({ channelId: fixture.channel.channelId, message: 'tie', idempotencyKey: 'send-2' });
    expect(result.route.stages[0]?.ownerBotId).toBe('bot-b');
  });

  it('records malformed, timeout, and no-claim outcomes without dispatching', async () => {
    const fixture = makeFixture({
      claimWindowMs: 5,
      evaluate: async (botId) => {
        if (botId === 'bot-a') return 'not json';
        await new Promise((resolve) => setTimeout(resolve, 20));
        return JSON.stringify({ claim: true, confidence: 99, reason: 'late' });
      },
    });
    const result = await fixture.router.send({ channelId: fixture.channel.channelId, message: 'nothing should claim', idempotencyKey: 'send-3' });
    expect(result.route.claims.map((claim) => claim.outcome)).toEqual(['malformed', 'timeout']);
    expect(result.route.blockedReason).toBe('no-claim');
    expect(fixture.dispatchCount).toBe(0);
    expect(fixture.journal.list(fixture.channel.channelId).some((entry) => entry.kind === 'error')).toBe(true);
  });

  it('blocks without evaluator calls when no member is eligible', async () => {
    let evaluations = 0;
    const fixture = makeFixture({
      bots: {
        'bot-a': { name: 'Alpha', lifecycle: 'archived' },
      },
      evaluate: async () => {
        evaluations += 1;
        return JSON.stringify({ claim: true, confidence: 100, reason: 'unexpected' });
      },
    });
    const result = await fixture.router.send({ channelId: fixture.channel.channelId, message: 'blocked', idempotencyKey: 'send-4' });
    expect(result.route.blockedReason).toBe('no-eligible-members');
    expect(evaluations).toBe(0);
    expect(fixture.dispatchCount).toBe(0);
  });

  it('bypasses claims for a mention and fans out for multiple mentions and everyone', async () => {
    let evaluations = 0;
    const fixture = makeFixture({ evaluate: async () => { evaluations += 1; return null; } });
    const explicit = await fixture.router.send({ channelId: fixture.channel.channelId, message: '@Beta Bot please respond', idempotencyKey: 'send-5' });
    expect(explicit.route.mode).toBe('explicit');
    expect(explicit.route.stages.map((stage) => stage.ownerBotId)).toEqual(['bot-b']);
    expect(evaluations).toBe(0);

    const fanOut = await fixture.router.send({ channelId: fixture.channel.channelId, message: '@Alpha Bot @Beta Bot respond separately', idempotencyKey: 'send-6' });
    expect(fanOut.route.stages.map((stage) => stage.ownerBotId)).toEqual(['bot-a', 'bot-b']);

    const everyone = await fixture.router.send({ channelId: fixture.channel.channelId, message: '@everyone status update', idempotencyKey: 'send-7' });
    expect(everyone.route.stages.map((stage) => stage.ownerBotId)).toEqual(['bot-a', 'bot-b']);
  });

  it('rejects a non-member mention before appending a journal entry', async () => {
    const fixture = makeFixture();
    await expect(fixture.router.send({ channelId: fixture.channel.channelId, message: '@Unknown please help', idempotencyKey: 'send-8' })).rejects.toBeInstanceOf(ChannelMentionError);
    expect(fixture.journal.list(fixture.channel.channelId)).toEqual([]);
  });

  it('makes duplicate sends idempotent', async () => {
    const fixture = makeFixture();
    const input = { channelId: fixture.channel.channelId, message: 'retry me', idempotencyKey: 'send-9' };
    const first = await fixture.router.send(input);
    const second = await fixture.router.send(input);
    expect(second.userEntry.entryId).toBe(first.userEntry.entryId);
    expect(second.route.routeId).toBe(first.route.routeId);
    expect(fixture.journal.list(fixture.channel.channelId).filter((entry) => entry.kind === 'user')).toHaveLength(1);
    expect(fixture.dispatchCount).toBe(1);
  });

  it('serializes concurrent retries for one route', async () => {
    const fixture = makeFixture({
      dispatch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return 'one reply';
      },
    });
    const input = { channelId: fixture.channel.channelId, message: 'concurrent retry', idempotencyKey: 'send-concurrent' };
    const [first, second] = await Promise.all([
      fixture.router.send(input),
      fixture.router.send(input),
    ]);

    expect(first.route.routeId).toBe(second.route.routeId);
    expect(fixture.dispatchCount).toBe(1);
    expect(fixture.journal.list(fixture.channel.channelId).filter((entry) => entry.kind === 'bot')).toHaveLength(1);
  });

  it('cancels a committed stage when membership changes before dispatch', async () => {
    const base = makeFixture();
    class MembershipChangingRoutes extends RouteStore {
      override commit(record: RouteRecord): RouteRecord {
        const committed = super.commit(record);
        base.directory.removeMember(base.channel.channelId, 'bot-a');
        return committed;
      }
    }
    const routes = new MembershipChangingRoutes({ workspaceRoot: base.directory.rootPath.replace(/\/channels$/, ''), workspaceId: 'workspace-one' });
    const router = new ChannelRouter({
      directory: base.directory,
      journal: base.journal,
      routes,
      evaluateClaim: async () => JSON.stringify({ claim: true, confidence: 100, reason: 'winner' }),
      dispatch: async () => 'must not run',
    });
    const result = await router.send({ channelId: base.channel.channelId, message: 'race', idempotencyKey: 'send-10' });
    expect(result.route.stages[0]?.state).toBe('cancelled');
    expect(result.route.stages[0]?.reason).toBe('membership-changed');
  });

  it('recovers a route left committed by a crash without duplicating a reply', async () => {
    const fixture = makeFixture();
    let crash = true;
    class CrashAfterCommitRoutes extends RouteStore {
      override commit(record: RouteRecord): RouteRecord {
        const committed = super.commit(record);
        if (crash) {
          crash = false;
          throw new Error('simulated crash');
        }
        return committed;
      }
    }
    const crashRoutes = new CrashAfterCommitRoutes({ workspaceRoot: fixture.directory.rootPath.replace(/\/channels$/, ''), workspaceId: 'workspace-one' });
    const crashingRouter = new ChannelRouter({
      directory: fixture.directory,
      journal: fixture.journal,
      routes: crashRoutes,
      evaluateClaim: async () => JSON.stringify({ claim: true, confidence: 100, reason: 'winner' }),
      dispatch: async () => 'recovered reply',
    });
    await expect(crashingRouter.send({ channelId: fixture.channel.channelId, message: 'recover me', idempotencyKey: 'send-11' })).rejects.toThrow('simulated crash');

    const recoveryRouter = new ChannelRouter({
      directory: fixture.directory,
      journal: fixture.journal,
      routes: new RouteStore({ workspaceRoot: fixture.directory.rootPath.replace(/\/channels$/, ''), workspaceId: 'workspace-one' }),
      evaluateClaim: async () => null,
      dispatch: async () => 'recovered reply',
    });
    const recovered = await recoveryRouter.recover(fixture.channel.channelId);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.stages[0]?.state).toBe('completed');
    await recoveryRouter.recover(fixture.channel.channelId);
    expect(fixture.journal.list(fixture.channel.channelId).filter((entry) => entry.kind === 'bot')).toHaveLength(1);
  });

  it('settles a dispatched stage from the load path without a new send when a journal reply already exists', async () => {
    const fixture = makeFixture();
    const sent = await fixture.router.send({
      channelId: fixture.channel.channelId,
      message: 'finish me later',
      idempotencyKey: 'send-dispatched-journal',
    });
    const stage = sent.route.stages[0];
    if (!stage) throw new Error('expected a stage');

    const pending: RouteRecord = {
      ...sent.route,
      stages: [{
        ...stage,
        state: 'dispatched',
        dispatchedAt: stage.dispatchedAt ?? sent.route.createdAt,
        settledAt: undefined,
      }],
      updatedAt: sent.route.updatedAt,
    };
    fixture.routes.update(pending);

    let dispatches = 0;
    const loadRouter = new ChannelRouter({
      directory: fixture.directory,
      journal: fixture.journal,
      routes: new RouteStore({ workspaceRoot: fixture.directory.rootPath.replace(/\/channels$/, ''), workspaceId: 'workspace-one' }),
      evaluateClaim: async () => null,
      dispatch: async () => {
        dispatches += 1;
        return 'should not run';
      },
    });
    const recovered = await loadRouter.recover(fixture.channel.channelId);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.stages[0]?.state).toBe('completed');
    expect(dispatches).toBe(0);
    expect(fixture.journal.list(fixture.channel.channelId).filter((entry) => entry.kind === 'bot')).toHaveLength(1);
  });

  it('carries first-dispatch context only once per Bot and never copies the Channel transcript', async () => {
    const requests: DispatchRequest[] = [];
    const fixture = makeFixture({
      dispatch: async (_owner, request) => {
        requests.push(request);
        return 'ok';
      },
    });
    await fixture.router.send({ channelId: fixture.channel.channelId, message: 'first', idempotencyKey: 'send-12' });
    await fixture.router.send({ channelId: fixture.channel.channelId, message: 'second', idempotencyKey: 'send-13' });

    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.isFirstDispatch)).toEqual([true, false]);

    const dispatchKeys = [
      'channelId',
      'channelName',
      'routeId',
      'stageId',
      'ownerBotId',
      'ownerEpoch',
      'dispatchIdempotencyKey',
      'message',
      'memberNames',
      'isFirstDispatch',
      'sourceEntryId',
    ] as const;
    for (const [index, message] of (['first', 'second'] as const).entries()) {
      const request = requests[index];
      expect(request).toMatchObject({
        channelId: fixture.channel.channelId,
        channelName: 'Engineering',
        ownerBotId: 'bot-a',
        message,
        memberNames: ['Alpha Bot', 'Beta Bot'],
        isFirstDispatch: index === 0,
      });
      expect(Object.keys(request!).sort()).toEqual([...dispatchKeys].sort());
      expect(request).not.toHaveProperty('transcript');
      expect(request).not.toHaveProperty('journal');
      expect(request).not.toHaveProperty('entries');
      expect(request).not.toHaveProperty('history');
      expect(request!.message).not.toContain(index === 0 ? 'second' : 'first');
    }
  });

  it('exposes deterministic stage IDs', () => {
    expect(stageId('route_abc', 2)).toBe('route_abc.s2');
  });
});
