import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HANDOFF_LIMITS, type HandoffMailState } from '@kata-sh/core';
import {
  getWorkspaceHandoffsPath,
  handoffByHandoffPath,
  handoffDeliveryVersionsPath,
  HandoffDeliveryClaimConflictError,
  HandoffDeliveryStore,
  type CreateHandoffDeliveryInput,
} from '../src/handoffs/index.ts';

const at = '2026-08-26T00:00:00.000Z';
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'handoff-delivery-'));
  tempRoots.push(root);
  return root;
}

function createStore(root = tempWorkspace()): HandoffDeliveryStore {
  return new HandoffDeliveryStore({ workspaceRoot: root, clock: () => at, randomId: () => 'unused' });
}

function createInput(overrides: Partial<CreateHandoffDeliveryInput> = {}): CreateHandoffDeliveryInput {
  return {
    deliveryId: 'delivery_a',
    handoffId: 'handoff_a',
    workspaceId: 'ws_1',
    conversationId: 'chat_a',
    sourceBotId: 'bot_source',
    targetBotId: 'bot_target',
    request: 'take over this task',
    ...overrides,
  };
}

function claim(store: HandoffDeliveryStore, deliveryId: string, claimId: string, expectedOwnerEpoch = 0) {
  const delivery = store.get(deliveryId);
  if (delivery?.mailState !== 'delivery-failed' && !delivery?.spawnTaskId) {
    store.attachSpawnTask(deliveryId, `task_${deliveryId}`);
  }
  return store.claimDelivery(deliveryId, { claimId, recipientBotId: 'bot_target', expectedOwnerEpoch });
}

function acknowledge(
  store: HandoffDeliveryStore,
  deliveryId: string,
  claimId: string,
  ownerEpoch: number,
  recipientBotId = 'bot_target',
) {
  return store.acknowledgeDelivery(deliveryId, { claimId, recipientBotId, ownerEpoch });
}

function acknowledgeNew(store: HandoffDeliveryStore, deliveryId: string, claimId: string) {
  claim(store, deliveryId, claimId);
  return acknowledge(store, deliveryId, claimId, 1);
}

function diskRecord(root: string, deliveryId: string): string {
  const versionsPath = handoffDeliveryVersionsPath(getWorkspaceHandoffsPath(root), deliveryId);
  const latest = readdirSync(versionsPath).sort().at(-1);
  if (!latest) throw new Error(`Delivery ${deliveryId} has no versions`);
  return readFileSync(join(versionsPath, latest), 'utf8');
}

describe('HandoffDeliveryStore create and reads', () => {
  it('persists a pending delivery and serves it by ID, handoff ID, and conversation', () => {
    const root = tempWorkspace();
    const store = createStore(root);
    const created = store.create(createInput());

    expect(created).toEqual({
      schemaVersion: 1,
      version: 1,
      deliveryId: 'delivery_a',
      handoffId: 'handoff_a',
      workspaceId: 'ws_1',
      conversationId: 'chat_a',
      sourceBotId: 'bot_source',
      targetBotId: 'bot_target',
      request: 'take over this task',
      mailState: 'pending',
      createdAt: at,
      updatedAt: at,
    });
    expect(store.get('delivery_a')).toEqual(created);
    expect(store.getByHandoff('handoff_a')).toEqual(created);
    expect(store.listByConversation('chat_a')).toEqual([created]);
    expect(store.get('delivery_missing')).toBeNull();
    expect(store.getByHandoff('handoff_missing')).toBeNull();
    expect(store.listByConversation('chat_missing')).toEqual([]);
  });

  it('rejects a duplicate deliveryId and a duplicate handoffId', () => {
    const store = createStore();
    store.create(createInput());

    expect(() => store.create(createInput({ handoffId: 'handoff_b' }))).toThrow('already exists');
    expect(() => store.create(createInput({ deliveryId: 'delivery_b' }))).toThrow(/handoff_a is already owned/);
    expect(store.get('delivery_b')).toBeNull();
  });

  it('bounds the request payload in UTF-8 bytes', () => {
    const store = createStore();
    expect(() => store.create(createInput({ request: 'é'.repeat(HANDOFF_LIMITS.requestBytes) }))).toThrow('byte limit');

    const withinLimit = store.create(createInput({ request: 'é'.repeat(HANDOFF_LIMITS.requestBytes / 2) }));
    expect(withinLimit.request).toHaveLength(HANDOFF_LIMITS.requestBytes / 2);
  });

  it('rejects traversal-style IDs', () => {
    const store = createStore();
    expect(() => store.create(createInput({ deliveryId: '../escape' }))).toThrow('path-safe');
    expect(() => store.create(createInput({ handoffId: 'handoff/../../escape' }))).toThrow('path-safe');
  });

  it('orders conversation deliveries by createdAt then deliveryId', () => {
    let tick = 0;
    const root = tempWorkspace();
    const store = new HandoffDeliveryStore({
      workspaceRoot: root,
      clock: () => `2026-08-26T00:00:0${tick % 10}.${String(tick).padStart(3, '0')}Z`,
    });
    tick = 1;
    store.create(createInput({ deliveryId: 'delivery_b', handoffId: 'handoff_b' }));
    tick = 0;
    store.create(createInput({ deliveryId: 'delivery_c', handoffId: 'handoff_c' }));
    tick = 0;
    store.create(createInput({ deliveryId: 'delivery_a', handoffId: 'handoff_a' }));

    expect(store.listByConversation('chat_a').map((record) => record.deliveryId)).toEqual([
      'delivery_a',
      'delivery_c',
      'delivery_b',
    ]);
  });
});

describe('HandoffDeliveryStore claim CAS', () => {
  it('claims a pending delivery at epoch 0 and re-claims with the matching epoch', () => {
    const store = createStore();
    store.create(createInput());
    const first = claim(store, 'delivery_a', 'claim_one');

    expect(first.mailState).toBe('claimed');
    expect(first.claim).toEqual({ claimId: 'claim_one', ownerEpoch: 1, claimedAt: at });

    const renewal = claim(store, 'delivery_a', 'claim_two', 1);
    expect(renewal.claim).toEqual({ claimId: 'claim_two', ownerEpoch: 2, claimedAt: at });
  });

  it('rejects a concurrent claim with a stale expected epoch, a wrong recipient, and terminal states', () => {
    const store = createStore();
    store.create(createInput());
    claim(store, 'delivery_a', 'claim_one');

    expect(() => claim(store, 'delivery_a', 'claim_two', 0)).toThrow('stale');
    expect(() => claim(store, 'delivery_a', 'claim_two', 99)).toThrow('stale');
    expect(() => store.claimDelivery('delivery_a', {
      claimId: 'claim_three',
      recipientBotId: 'bot_other',
      expectedOwnerEpoch: 1,
    })).toThrow(/addressed to bot_target/);

    store.acknowledgeDelivery('delivery_a', {
      claimId: 'claim_one',
      recipientBotId: 'bot_target',
      ownerEpoch: 1,
    });
    expect(() => claim(store, 'delivery_a', 'claim_four', 1)).toThrow('Illegal handoff mail transition: acknowledged -> claimed');
  });

  it('allows only one stale store instance to claim and acknowledge a delivery', () => {
    const root = tempWorkspace();
    const first = createStore(root);
    first.create(createInput());
    first.attachSpawnTask('delivery_a', 'task_a');
    const second = createStore(root);

    const accepted = first.claimDelivery('delivery_a', {
      claimId: 'claim_one',
      recipientBotId: 'bot_target',
      expectedOwnerEpoch: 0,
    });
    expect(() => second.claimDelivery('delivery_a', {
      claimId: 'claim_two',
      recipientBotId: 'bot_target',
      expectedOwnerEpoch: 0,
    })).toThrow(HandoffDeliveryClaimConflictError);
    expect(() => second.acknowledgeDelivery('delivery_a', {
      claimId: 'claim_two',
      recipientBotId: 'bot_target',
      ownerEpoch: 1,
    })).toThrow(HandoffDeliveryClaimConflictError);

    if (!accepted.claim) throw new Error('Expected the winning delivery claim');
    expect(first.acknowledgeDelivery('delivery_a', {
      claimId: accepted.claim.claimId,
      recipientBotId: 'bot_target',
      ownerEpoch: accepted.claim.ownerEpoch,
    }).mailState).toBe('acknowledged');
  });

  it('rejects a claim on a delivery-failed delivery', () => {
    const store = createStore();
    store.create(createInput());
    store.failDelivery('delivery_a', { code: 'provider_error', message: 'boom' });
    expect(() => claim(store, 'delivery_a', 'claim_one', 0)).toThrow('Illegal handoff mail transition: delivery-failed -> claimed');
  });
});

describe('HandoffDeliveryStore acknowledge', () => {
  it('acknowledges the current claim and retains it', () => {
    const store = createStore();
    store.create(createInput());
    const acked = acknowledgeNew(store, 'delivery_a', 'claim_one');

    expect(acked.mailState).toBe('acknowledged');
    expect(acked.claim).toEqual({ claimId: 'claim_one', ownerEpoch: 1, claimedAt: at });
  });

  it('rejects acknowledge from pending, with a stale claim id or epoch, and double-acknowledge', () => {
    const store = createStore();
    store.create(createInput());
    expect(() => acknowledge(store, 'delivery_a', 'claim_one', 1)).toThrow(
      'Illegal handoff mail transition: pending -> acknowledged',
    );

    acknowledgeNew(store, 'delivery_a', 'claim_one');
    expect(() => acknowledge(store, 'delivery_a', 'claim_one', 1)).toThrow(
      'Illegal handoff mail transition: acknowledged -> acknowledged',
    );
  });

  it('rejects a stale claimant on a claimed delivery', () => {
    const store = createStore();
    store.create(createInput());
    claim(store, 'delivery_a', 'claim_one');
    expect(() => acknowledge(store, 'delivery_a', 'claim_other', 1)).toThrow('stale');
    expect(() => acknowledge(store, 'delivery_a', 'claim_one', 2)).toThrow('stale');
    expect(() => acknowledge(store, 'delivery_a', 'claim_one', 1, 'bot_other'))
      .toThrow(HandoffDeliveryClaimConflictError);
    expect(store.get('delivery_a')?.mailState).toBe('claimed');
  });
});

describe('HandoffDeliveryStore fail', () => {
  it('fails from pending without a claim and drops any claim from a claimed delivery', () => {
    const store = createStore();
    store.create(createInput());
    const failedFromPending = store.failDelivery('delivery_a', { code: 'provider_error', message: 'boom' });

    expect(failedFromPending.mailState).toBe('delivery-failed');
    expect(failedFromPending.failure).toEqual({ code: 'provider_error', message: 'boom', at });
    expect(failedFromPending).not.toHaveProperty('claim');

    store.create(createInput({ deliveryId: 'delivery_b', handoffId: 'handoff_b' }));
    claim(store, 'delivery_b', 'claim_b');
    const failedFromClaimed = store.failDelivery('delivery_b', {
      code: 'provider_error',
      message: 'boom',
      claim: { claimId: 'claim_b', recipientBotId: 'bot_target', ownerEpoch: 1 },
    });
    expect(failedFromClaimed.mailState).toBe('delivery-failed');
    expect(failedFromClaimed).not.toHaveProperty('claim');
  });

  it('rejects failure from acknowledged, from terminal failure, and with a stale claim', () => {
    const store = createStore();
    store.create(createInput());
    acknowledgeNew(store, 'delivery_a', 'claim_one');
    expect(() => store.failDelivery('delivery_a', { code: 'provider_error', message: 'boom' })).toThrow(
      'Illegal handoff mail transition: acknowledged -> delivery-failed',
    );

    store.create(createInput({ deliveryId: 'delivery_b', handoffId: 'handoff_b' }));
    store.failDelivery('delivery_b', { code: 'provider_error', message: 'boom' });
    expect(() => store.failDelivery('delivery_b', { code: 'provider_error', message: 'boom' })).toThrow(
      'Illegal handoff mail transition: delivery-failed -> delivery-failed',
    );

    store.create(createInput({ deliveryId: 'delivery_c', handoffId: 'handoff_c' }));
    claim(store, 'delivery_c', 'claim_c');
    expect(() => store.failDelivery('delivery_c', {
      code: 'provider_error',
      message: 'boom',
      claim: { claimId: 'claim_c', recipientBotId: 'bot_other', ownerEpoch: 1 },
    })).toThrow('stale');
    expect(() => store.failDelivery('delivery_c', {
      code: 'provider_error',
      message: 'boom',
      claim: { claimId: 'claim_c', recipientBotId: 'bot_target', ownerEpoch: 7 },
    })).toThrow('stale');
    expect(store.get('delivery_c')?.mailState).toBe('claimed');
  });
});

describe('HandoffDeliveryStore attachSpawnTask', () => {
  it('attaches once, is idempotent for the same task, and rejects a different task', () => {
    const store = createStore();
    store.create(createInput());
    const attached = store.attachSpawnTask('delivery_a', 'task_1');
    expect(attached.spawnTaskId).toBe('task_1');

    const reattached = store.attachSpawnTask('delivery_a', 'task_1');
    expect(reattached.spawnTaskId).toBe('task_1');
    expect(reattached.updatedAt).toBe(at);
    expect(() => store.attachSpawnTask('delivery_a', 'task_2')).toThrow('already attached to spawned task task_1');
  });

  it('keeps the attachment through claim and acknowledge but refuses new attachments afterwards', () => {
    const store = createStore();
    store.create(createInput());
    store.attachSpawnTask('delivery_a', 'task_1');
    const acked = acknowledgeNew(store, 'delivery_a', 'claim_one');
    expect(acked.spawnTaskId).toBe('task_1');
    expect(() => store.attachSpawnTask('delivery_a', 'task_3')).toThrow('in state acknowledged');
  });
});

describe('HandoffDeliveryStore result unread tracking', () => {
  it('marks unread on an acknowledged delivery and clears it with a matching version', () => {
    const store = createStore();
    store.create(createInput());
    acknowledgeNew(store, 'delivery_a', 'claim_one');

    const unread = store.markResultUnread('delivery_a', { taskVersion: 3, at });
    expect(unread.resultUnread).toEqual({ taskVersion: 3, at });
    expect(unread.resultReadTaskVersion).toBeUndefined();

    expect(store.markResultUnread('delivery_a', { taskVersion: 3, at }).resultUnread).toEqual({ taskVersion: 3, at });
    expect(store.markResultUnread('delivery_a', { taskVersion: 2, at }).resultUnread).toEqual({ taskVersion: 3, at });

    const read = store.markResultRead('delivery_a', { expectedTaskVersion: 3 });
    expect(read.resultUnread).toBeUndefined();
    expect(read.resultReadTaskVersion).toBe(3);
  });

  it('throws on a version mismatch and leaves the record intact', () => {
    const store = createStore();
    store.create(createInput());
    acknowledgeNew(store, 'delivery_a', 'claim_one');
    store.markResultUnread('delivery_a', { taskVersion: 3, at });

    expect(() => store.markResultRead('delivery_a', { expectedTaskVersion: 2 })).toThrow('does not match expected 2');
    expect(store.get('delivery_a')?.resultUnread).toEqual({ taskVersion: 3, at });
    expect(store.get('delivery_a')?.resultReadTaskVersion).toBeUndefined();

    expect(() => store.markResultRead('delivery_a', { expectedTaskVersion: 3 })).not.toThrow();
    expect(() => store.markResultRead('delivery_a', { expectedTaskVersion: 3 })).toThrow('does not match expected 3');
  });

  it('acknowledges one handoff result without clearing another', () => {
    const store = createStore();
    store.create(createInput());
    store.create(createInput({ deliveryId: 'delivery_b', handoffId: 'handoff_b' }));
    acknowledgeNew(store, 'delivery_a', 'claim_a');
    acknowledgeNew(store, 'delivery_b', 'claim_b');
    store.markResultUnread('delivery_a', { taskVersion: 3, at });
    store.markResultUnread('delivery_b', { taskVersion: 7, at });

    store.markResultRead('delivery_a', { expectedTaskVersion: 3 });

    expect(store.get('delivery_a')?.resultUnread).toBeUndefined();
    expect(store.get('delivery_a')?.resultReadTaskVersion).toBe(3);
    expect(store.get('delivery_b')?.resultUnread).toEqual({ taskVersion: 7, at });
    expect(store.get('delivery_b')?.resultReadTaskVersion).toBeUndefined();
  });

  it('rejects unread marking on non-acknowledged deliveries', () => {
    const store = createStore();
    store.create(createInput());
    expect(() => store.markResultUnread('delivery_a', { taskVersion: 1, at })).toThrow('must be acknowledged');

    claim(store, 'delivery_a', 'claim_one');
    expect(() => store.markResultUnread('delivery_a', { taskVersion: 1, at })).toThrow('must be acknowledged');
  });
});

describe('HandoffDeliveryStore reload', () => {
  it('rebuilds identical records in a new store instance over the same root', () => {
    const root = tempWorkspace();
    const store = createStore(root);
    store.create(createInput());
    store.create(createInput({ deliveryId: 'delivery_b', handoffId: 'handoff_b', conversationId: 'channel_b' }));
    store.attachSpawnTask('delivery_b', 'task_b');
    acknowledgeNew(store, 'delivery_b', 'claim_b');
    store.markResultUnread('delivery_b', { taskVersion: 4, at });
    const reloaded = new HandoffDeliveryStore({ workspaceRoot: root, clock: () => at });

    expect(reloaded.get('delivery_a')).toEqual(store.get('delivery_a'));
    expect(reloaded.get('delivery_b')).toEqual(store.get('delivery_b'));
    expect(reloaded.getByHandoff('handoff_b')).toEqual(store.get('delivery_b'));
    expect(reloaded.listByConversation('channel_b')).toEqual([store.get('delivery_b')]);
    expect(reloaded.getLoadErrors()).toEqual({});
  });

  it('isolates a corrupt record into loadErrors without breaking other records', () => {
    const root = tempWorkspace();
    const store = createStore(root);
    store.create(createInput());

    const handoffsRoot = getWorkspaceHandoffsPath(root);
    mkdirSync(join(handoffsRoot, 'deliveries', 'delivery_bad', 'versions'), { recursive: true });
    writeFileSync(join(handoffsRoot, 'deliveries', 'delivery_bad', 'versions', '000000000001.json'), '{ not json', 'utf8');

    const reloaded = new HandoffDeliveryStore({ workspaceRoot: root, clock: () => at });
    expect(reloaded.get('delivery_a')).toEqual(store.get('delivery_a'));
    expect(reloaded.get('delivery_bad')).toBeNull();
    expect(typeof reloaded.getLoadErrors()['delivery_bad']).toBe('string');

    expect(() => reloaded.create(createInput({ deliveryId: 'delivery_bad', handoffId: 'handoff_bad' }))).toThrow(
      'already exists',
    );
  });

  it('repairs only a missing handoff pointer and preserves a conflicting owner', () => {
    const root = tempWorkspace();
    const store = createStore(root);
    store.create(createInput());
    const pointerPath = handoffByHandoffPath(getWorkspaceHandoffsPath(root), 'handoff_a');

    rmSync(pointerPath);
    expect(store.repairHandoffPointerIfMissing('delivery_a')).toBe('repaired');
    expect(JSON.parse(readFileSync(pointerPath, 'utf8'))).toEqual({ deliveryId: 'delivery_a' });

    writeFileSync(pointerPath, `${JSON.stringify({ deliveryId: 'delivery_other' })}\n`, 'utf8');
    expect(store.repairHandoffPointerIfMissing('delivery_a')).toBe('conflict');
    expect(JSON.parse(readFileSync(pointerPath, 'utf8'))).toEqual({ deliveryId: 'delivery_other' });
  });
});

describe('HandoffDeliveryStore mail transition table', () => {
  interface Attempt {
    readonly state: HandoffMailState;
    readonly op: 'claim' | 'acknowledge' | 'fail';
    readonly legal: boolean;
    readonly run: (store: HandoffDeliveryStore, deliveryId: string, claimId: string) => unknown;
  }

  const attempts: readonly Attempt[] = [
    {
      state: 'pending', op: 'claim', legal: true,
      run: (store, deliveryId) => claim(store, deliveryId, 'claim_x'),
    },
    {
      state: 'pending', op: 'acknowledge', legal: false,
      run: (store, deliveryId) => acknowledge(store, deliveryId, 'claim_x', 1),
    },
    {
      state: 'pending', op: 'fail', legal: true,
      run: (store, deliveryId) => store.failDelivery(deliveryId, { code: 'provider_error', message: 'boom' }),
    },
    {
      state: 'claimed', op: 'claim', legal: true,
      run: (store, deliveryId, claimId) => claim(store, deliveryId, 'claim_renewal', 1),
    },
    {
      state: 'claimed', op: 'acknowledge', legal: true,
      run: (store, deliveryId, claimId) => acknowledge(store, deliveryId, claimId, 1),
    },
    {
      state: 'claimed', op: 'fail', legal: true,
      run: (store, deliveryId, claimId) => store.failDelivery(deliveryId, {
        code: 'provider_error',
        message: 'boom',
        claim: { claimId, recipientBotId: 'bot_target', ownerEpoch: 1 },
      }),
    },
    {
      state: 'acknowledged', op: 'claim', legal: false,
      run: (store, deliveryId, claimId) => claim(store, deliveryId, 'claim_x', 1),
    },
    {
      state: 'acknowledged', op: 'acknowledge', legal: false,
      run: (store, deliveryId, claimId) => acknowledge(store, deliveryId, claimId, 1),
    },
    {
      state: 'acknowledged', op: 'fail', legal: false,
      run: (store, deliveryId, claimId) => store.failDelivery(deliveryId, {
        code: 'provider_error',
        message: 'boom',
        claim: { claimId, recipientBotId: 'bot_target', ownerEpoch: 1 },
      }),
    },
    {
      state: 'delivery-failed', op: 'claim', legal: false,
      run: (store, deliveryId) => claim(store, deliveryId, 'claim_x'),
    },
    {
      state: 'delivery-failed', op: 'acknowledge', legal: false,
      run: (store, deliveryId) => acknowledge(store, deliveryId, 'claim_x', 1),
    },
    {
      state: 'delivery-failed', op: 'fail', legal: false,
      run: (store, deliveryId) => store.failDelivery(deliveryId, { code: 'provider_error', message: 'boom' }),
    },
  ];

  it('accepts legal API transitions and rejects illegal ones without mutating disk', () => {
    for (const attempt of attempts) {
      const root = tempWorkspace();
      const store = createStore(root);
      const deliveryId = `delivery_${attempt.op}`;
      store.create(createInput({ deliveryId, handoffId: `handoff_${attempt.op}` }));
      let claimId = '';
      if (attempt.state !== 'pending') {
        claimId = `claim_${attempt.op}`;
        claim(store, deliveryId, claimId);
        if (attempt.state === 'acknowledged') acknowledge(store, deliveryId, claimId, 1);
        if (attempt.state === 'delivery-failed') {
          store.failDelivery(deliveryId, { code: 'provider_error', message: 'boom' });
        }
      }
      const before = diskRecord(root, deliveryId);
      if (attempt.legal) {
        expect(() => attempt.run(store, deliveryId, claimId)).not.toThrow();
      } else {
        expect(() => attempt.run(store, deliveryId, claimId)).toThrow();
        expect(diskRecord(root, deliveryId)).toBe(before);
      }
    }
  });
});
