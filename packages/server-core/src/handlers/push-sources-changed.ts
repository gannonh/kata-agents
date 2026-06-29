import { getWorkspaceByNameOrId } from '@kata-sh/shared/config';
import { RPC_CHANNELS } from '@kata-sh/shared/protocol';
import { loadWorkspaceSources } from '@kata-sh/shared/sources';
import { pushTyped, type RpcServer } from '../transport';

export function createPushSourcesChanged(wsServer: RpcServer): (workspaceId: string) => void {
  return (workspaceId: string) => {
    const ws = getWorkspaceByNameOrId(workspaceId);
    const sources = ws ? loadWorkspaceSources(ws.rootPath) : [];
    pushTyped(
      wsServer,
      RPC_CHANNELS.sources.CHANGED,
      { to: 'workspace', workspaceId },
      workspaceId,
      sources,
    );
  };
}
