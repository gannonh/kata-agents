import type { DirectChatRecord } from '@kata-sh/core';
import { ConversationJournal, type ConversationRef, readJsonFile } from '../conversations/index.ts';
import { botsRootPath, chatRecordPath } from './layout.ts';
import { assertDirectChatRecord } from './validation.ts';

export interface DirectChatJournalOptions {
  readonly workspaceRoot: string;
  readonly workspaceId: string;
  readonly clock?: () => string;
}

/**
 * The journal over a Bot's one DirectChat. The owning Bot is the sole author of
 * every non-user entry.
 */
export function createDirectChatJournal(options: DirectChatJournalOptions): ConversationJournal {
  const journalRoot = botsRootPath(options.workspaceRoot);
  return new ConversationJournal({
    journalRoot,
    workspaceId: options.workspaceId,
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    resolveConversation: (conversationId): ConversationRef | null => {
      const record = readJsonFile(chatRecordPath(journalRoot, conversationId));
      if (!record) return null;
      const chat: DirectChatRecord = assertDirectChatRecord(record);
      return {
        conversationId: chat.chatId,
        workspaceId: chat.workspaceId,
        soleAuthorBotId: chat.botId,
      };
    },
  });
}
