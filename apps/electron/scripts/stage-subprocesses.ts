import { cp, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface StageSubprocessesOptions {
  rootDir: string;
  resourcesDir: string;
}

const REQUIRED_SERVERS = ['pi-agent-server', 'session-mcp-server'] as const;

export async function stageSubprocesses({ rootDir, resourcesDir }: StageSubprocessesOptions): Promise<void> {
  const sources = REQUIRED_SERVERS.map((serverName) => ({
    serverName,
    source: join(rootDir, 'packages', serverName, 'dist'),
    destination: join(resourcesDir, serverName),
  }));

  for (const { serverName, source } of sources) {
    try {
      if (!(await stat(source)).isDirectory()) {
        throw new Error('not a directory');
      }
    } catch {
      throw new Error(`Missing built ${serverName} at ${source}. Run bun run server:build:subprocess first.`);
    }
  }

  await Promise.all(sources.map(async ({ source, destination }) => {
    await rm(destination, { recursive: true, force: true });
    await cp(source, destination, { recursive: true });
  }));
}

if (import.meta.main) {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  await stageSubprocesses({
    rootDir: resolve(scriptDir, '../../..'),
    resourcesDir: resolve(scriptDir, '..', 'resources'),
  });
}
