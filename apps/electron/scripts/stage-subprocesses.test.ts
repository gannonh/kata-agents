import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageSubprocesses } from './stage-subprocesses.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('stageSubprocesses', () => {
  test('stages the built Pi and session servers for Electron packaging', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'kata-electron-stage-'));
    temporaryDirectories.push(rootDir);

    const piSource = join(rootDir, 'packages/pi-agent-server/dist');
    const sessionSource = join(rootDir, 'packages/session-mcp-server/dist');
    const resourcesDir = join(rootDir, 'apps/electron/resources');
    await Promise.all([
      mkdir(piSource, { recursive: true }),
      mkdir(sessionSource, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(piSource, 'index.js'), 'pi server'),
      writeFile(join(sessionSource, 'index.js'), 'session server'),
    ]);

    await stageSubprocesses({ rootDir, resourcesDir });

    expect(await Bun.file(join(resourcesDir, 'pi-agent-server/index.js')).text()).toBe('pi server');
    expect(await Bun.file(join(resourcesDir, 'session-mcp-server/index.js')).text()).toBe('session server');
  });

  test('fails before packaging when a required built server is absent', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'kata-electron-stage-'));
    temporaryDirectories.push(rootDir);
    const resourcesDir = join(rootDir, 'apps/electron/resources');
    await mkdir(join(rootDir, 'packages/pi-agent-server/dist'), { recursive: true });

    await expect(stageSubprocesses({ rootDir, resourcesDir })).rejects.toThrow(
      'Missing built session-mcp-server',
    );
    expect(existsSync(join(resourcesDir, 'pi-agent-server'))).toBe(false);
  });
});
