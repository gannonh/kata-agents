import type { ConversationRef, ConversationJournal } from '../conversations/index.ts';
import { ConversationJournal as Journal, readJsonFile } from '../conversations/index.ts';
import type { ChannelDirectory } from './directory.ts';
import { channelRecordPath, channelsRootPath } from './layout.ts';
import { assertChannelRecord } from './validation.ts';

export function createChannelJournal(options: {
  workspaceRoot: string;
  workspaceId: string;
  directory: ChannelDirectory;
  clock?: () => string;
}): ConversationJournal {
  const journalRoot = channelsRootPath(options.workspaceRoot);
  return new Journal({
    journalRoot,
    workspaceId: options.workspaceId,
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    resolveConversation: (conversationId): ConversationRef | null => {
      const record = readJsonFile(channelRecordPath(journalRoot, conversationId));
      if (!record) return null;
      const channel = assertChannelRecord(record);
      return {
        conversationId: channel.channelId,
        workspaceId: channel.workspaceId,
        mayAuthor: (botId) => options.directory.isMember(channel.channelId, botId),
      };
    },
  });
}

