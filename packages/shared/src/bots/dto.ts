import type { BotPublicDto, BotRecord } from '@kata-sh/core';

export function toBotPublicDto(record: BotRecord): BotPublicDto {
  return {
    botId: record.botId,
    workspaceId: record.workspaceId,
    directChatId: record.directChatId,
    name: record.name,
    ...(record.profile !== undefined ? { profile: record.profile } : {}),
    permissionMode: record.permissionMode,
    providerConfig: { providerId: record.providerConfig.providerId, modelId: record.providerConfig.modelId },
    lifecycle: record.lifecycle,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.archivedAt !== undefined ? { archivedAt: record.archivedAt } : {}),
    ...(record.hiddenAt !== undefined ? { hiddenAt: record.hiddenAt } : {}),
  };
}
