import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { ChannelDirectory } from '../src/channels/directory.ts';

function makeDirectory(workspaceId = 'workspace-one') {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'kata-channel-'));
  const bots = new Map([
    ['bot-a', { botId: 'bot-a', name: 'Alpha', lifecycle: 'active' as const }],
    ['bot-b', { botId: 'bot-b', name: 'Beta', lifecycle: 'active' as const }],
  ]);
  const directory = new ChannelDirectory({
    workspaceRoot,
    workspaceId,
    randomId: () => 'fixed',
    clock: (() => {
      let sequence = 0;
      return () => new Date(Date.UTC(2026, 0, 1, 0, 0, sequence++)).toISOString();
    })(),
    resolveBot: (botId) => bots.get(botId) ?? null,
  });
  return { workspaceRoot, directory, bots };
}

describe('ChannelDirectory', () => {
  it('creates idempotently and keeps membership priorities stable', () => {
    const { directory } = makeDirectory();
    const first = directory.createChannel({ name: 'Work', botIds: ['bot-a', 'bot-b'], idempotencyKey: 'create-1' });
    const retry = directory.createChannel({ name: 'Different name is ignored on retry', idempotencyKey: 'create-1' });

    expect(retry).toEqual(first);
    expect(first.members.map((member) => member.priority)).toEqual([0, 1]);
    expect(directory.removeMember(first.channelId, 'bot-a').membershipRevision).toBe(2);
    expect(directory.addMember(first.channelId, 'bot-a').membershipRevision).toBe(3);
    expect(directory.getChannel(first.channelId)?.members.map((member) => member.priority)).toEqual([1, 2]);
  });

  it('rejects unknown or foreign Bots', () => {
    const { directory, bots } = makeDirectory();
    const channel = directory.createChannel({ name: 'Work', idempotencyKey: 'create-2' });
    expect(() => directory.addMember(channel.channelId, 'missing')).toThrow('Bot not found');
    bots.delete('bot-b');
    expect(() => directory.addMember(channel.channelId, 'bot-b')).toThrow('Bot not found');
  });

  it('rejects reading a record through another workspace identity', () => {
    const { workspaceRoot, directory } = makeDirectory();
    const channel = directory.createChannel({ name: 'Work', idempotencyKey: 'create-3' });
    expect(() => new ChannelDirectory({
      workspaceRoot,
      workspaceId: 'workspace-two',
      resolveBot: () => null,
    })).toThrow('belongs to another workspace');
    expect(directory.getChannel(channel.channelId)?.workspaceId).toBe('workspace-one');
  });

  it('supports rename, archive, reopen, filtering, and delete', () => {
    const { directory } = makeDirectory();
    const channel = directory.createChannel({ name: 'Old', idempotencyKey: 'create-4' });
    expect(directory.renameChannel(channel.channelId, 'New').name).toBe('New');
    expect(directory.archiveChannel(channel.channelId).lifecycle).toBe('archived');
    expect(directory.listChannels()).toEqual([]);
    expect(directory.listChannels({ lifecycle: 'archived' })).toHaveLength(1);
    expect(directory.reopenChannel(channel.channelId).lifecycle).toBe('active');
    directory.deleteChannel(channel.channelId);
    expect(directory.getChannel(channel.channelId)).toBeNull();
    expect(directory.listChannels({ lifecycle: 'all' })).toEqual([]);
  });
});
