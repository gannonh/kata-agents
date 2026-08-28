import type { ChannelPublicDto, ChannelRecord } from '@kata-sh/core';

export function toChannelPublicDto(record: ChannelRecord): ChannelPublicDto {
  return {
    channelId: record.channelId,
    workspaceId: record.workspaceId,
    name: record.name,
    lifecycle: record.lifecycle,
    membershipRevision: record.membershipRevision,
    members: record.members.map((member) => ({ ...member })),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.archivedAt !== undefined ? { archivedAt: record.archivedAt } : {}),
  };
}

