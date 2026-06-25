import type { CliRpcClient } from './client.ts'
import { err } from './output.ts'

export async function resolveWorkspace(
  client: CliRpcClient,
  explicit?: string,
): Promise<string | undefined> {
  if (explicit) {
    await client.invoke('window:switchWorkspace', explicit).catch(() => {})
    return explicit
  }
  try {
    const workspaces = (await client.invoke('workspaces:get')) as Array<{ id: string }>
    if (workspaces?.length > 0) {
      const id = workspaces[0].id
      await client.invoke('window:switchWorkspace', id).catch(() => {})
      return id
    }
  } catch {
    // Fall through — workspace may not be needed
  }
  return undefined
}

export async function requireWorkspace(
  client: CliRpcClient,
  explicit?: string,
): Promise<string> {
  const workspaceId = await resolveWorkspace(client, explicit)
  if (!workspaceId) {
    err('No workspace available. Use --workspace <id>')
    process.exit(1)
  }
  return workspaceId
}
