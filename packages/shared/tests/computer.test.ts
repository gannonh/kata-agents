import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ComputerConfigError,
  aggregateHealth,
  filterCapabilitiesForComputer,
  openDataRootLayout,
  parseComputerConfig,
} from '@kata-sh/shared/computer';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'kata-computer-'));
  tempRoots.push(root);
  return root;
}

function expectConfigCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error(`expected ${code}`);
  } catch (error) {
    if (!(error instanceof ComputerConfigError)) throw error;
    expect(error.code).toBe(code);
  }
}

describe('parseComputerConfig', () => {
  it('unpackaged parse picks KATA_DATA_ROOT', () => {
    const config = parseComputerConfig({
      KATA_DATA_ROOT: '/tmp/kata-data-root',
      KATA_CONFIG_DIR: '/tmp/should-not-win',
    });
    expect(config.dataRoot).toBe('/tmp/kata-data-root');
    expect(config.kind).toBe('local-client');
    expect(config.packaged).toBe(false);
  });

  it('packaged missing data root throws', () => {
    expectConfigCode(
      () => parseComputerConfig({
        KATA_IS_PACKAGED: 'true',
        KATA_CONFIG_DIR: '/tmp/should-not-satisfy-packaged',
        KATA_SERVER_TOKEN: 'token-with-enough-entropy-01',
      }),
      'missing-data-root',
    );
  });

  it('token file wins over env', () => {
    const root = tempRoot();
    const tokenFile = join(root, 'token');
    writeFileSync(tokenFile, '  file-token-with-entropy-01  \n');
    const config = parseComputerConfig({
      KATA_DATA_ROOT: root,
      KATA_SERVER_TOKEN: 'env-token-with-entropy-012',
      KATA_SERVER_TOKEN_FILE: tokenFile,
    });
    expect(config.rpc.token).toBe('file-token-with-entropy-01');
  });

  it('TLS incomplete throws', () => {
    expectConfigCode(
      () => parseComputerConfig({
        KATA_DATA_ROOT: tempRoot(),
        KATA_RPC_TLS_CERT: '/certs/cert.pem',
      }),
      'tls-incomplete',
    );
  });

  it('insecure public bind throws', () => {
    expectConfigCode(
      () => parseComputerConfig({
        KATA_DATA_ROOT: tempRoot(),
        KATA_RPC_HOST: '0.0.0.0',
      }, { argv: [] }),
      'insecure-public-bind',
    );
  });

  it('falls back to KATA_CONFIG_DIR then the default home path', () => {
    const configDir = tempRoot();
    const fromConfigDir = parseComputerConfig({
      KATA_CONFIG_DIR: configDir,
    });
    expect(fromConfigDir.dataRoot).toBe(configDir);

    const fromHome = parseComputerConfig({});
    expect(fromHome.dataRoot).toBe(join(homedir(), '.kata-agents'));
  });

  it('packaged missing token throws', () => {
    expectConfigCode(
      () => parseComputerConfig({
        KATA_IS_PACKAGED: 'true',
        KATA_DATA_ROOT: tempRoot(),
      }),
      'missing-token',
    );
  });

  it('weak token throws', () => {
    expectConfigCode(
      () => parseComputerConfig({
        KATA_DATA_ROOT: tempRoot(),
        KATA_SERVER_TOKEN: 'short',
      }),
      'weak-token',
    );
    expectConfigCode(
      () => parseComputerConfig({
        KATA_DATA_ROOT: tempRoot(),
        KATA_SERVER_TOKEN: 'aaaaaaaaaaaaaaaa',
      }),
      'weak-token',
    );
  });

  it('rejects a port value that is not entirely an integer', () => {
    expectConfigCode(
      () => parseComputerConfig({
        KATA_DATA_ROOT: tempRoot(),
        KATA_RPC_PORT: '9100junk',
      }),
      'invalid-port',
    );
    expectConfigCode(
      () => parseComputerConfig({
        KATA_DATA_ROOT: tempRoot(),
        KATA_HEALTH_PORT: '9101junk',
      }),
      'invalid-port',
    );
  });

  it('rejects --allow-insecure-bind in packaged mode before listen', () => {
    expectConfigCode(
      () => parseComputerConfig({
        KATA_IS_PACKAGED: 'true',
        KATA_DATA_ROOT: tempRoot(),
        KATA_SERVER_TOKEN: 'token-with-enough-entropy-01',
        KATA_RPC_HOST: '127.0.0.1',
      }, { argv: ['--allow-insecure-bind'] }),
      'packaged-insecure-bind',
    );
  });

  it('still allows --allow-insecure-bind outside packaged mode', () => {
    const config = parseComputerConfig({
      KATA_DATA_ROOT: tempRoot(),
      KATA_RPC_HOST: '0.0.0.0',
    }, { argv: ['--allow-insecure-bind'] });
    expect(config.packaged).toBe(false);
    expect(config.rpc.allowInsecurePublicBind).toBe(true);
  });
});

describe('openDataRootLayout', () => {
  it('openDataRootLayout creates manifest v1', () => {
    const root = tempRoot();
    const opened = openDataRootLayout(root);
    expect(opened.tag).toBe('opened');
    if (opened.tag !== 'opened') return;
    expect(opened.created).toBe(true);

    const manifestPath = join(root, 'computer', 'manifest.json');
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new Error('manifest is not an object');
    }
    const record = manifest as { layoutVersion?: unknown; computerId?: unknown };
    expect(record.layoutVersion).toBe(1);
    expect(typeof record.computerId).toBe('string');
    expect(String(record.computerId).length).toBeGreaterThan(0);

    expect(existsSync(join(root, 'workspaces'))).toBe(true);
    expect(existsSync(join(root, 'worktrees'))).toBe(true);
    expect(existsSync(join(root, 'browser', 'profiles'))).toBe(true);
    expect(existsSync(join(root, 'browser', 'displays'))).toBe(true);
    expect(existsSync(join(root, 'browser', 'locks'))).toBe(true);
    expect(existsSync(join(root, 'computer', 'shutdown'))).toBe(true);

    const again = openDataRootLayout(root);
    expect(again.tag).toBe('opened');
    if (again.tag !== 'opened') return;
    expect(again.created).toBe(false);
    expect(again.computerId).toBe(opened.computerId);
  });

  it('corrupt manifest returns corrupt', () => {
    const root = tempRoot();
    const manifestPath = join(root, 'computer', 'manifest.json');
    mkdirSync(join(root, 'computer'), { recursive: true });
    writeFileSync(manifestPath, '{not-json');
    const result = openDataRootLayout(root);
    expect(result.tag).toBe('corrupt');
    if (result.tag !== 'corrupt') return;
    expect(result.path).toBe(manifestPath);
    expect(readFileSync(manifestPath, 'utf8')).toBe('{not-json');
  });

  it('incompatible version returns incompatible', () => {
    const root = tempRoot();
    const manifestPath = join(root, 'computer', 'manifest.json');
    mkdirSync(join(root, 'computer'), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify({ layoutVersion: 99, computerId: 'cmp_old' }));
    const result = openDataRootLayout(root);
    expect(result.tag).toBe('incompatible');
    if (result.tag !== 'incompatible') return;
    expect(result.found).toBe(99);
    expect(readFileSync(manifestPath, 'utf8')).toContain('"layoutVersion":99');
  });
});

describe('aggregateHealth', () => {
  it('aggregateHealth browser-fail is degraded', () => {
    expect(aggregateHealth({
      process: { tag: 'ready' },
      storage: { tag: 'ready' },
      browser: { tag: 'failed', reason: 'chromium down' },
      checkedAt: '2026-08-30T00:00:00.000Z',
    })).toBe('degraded');
  });

  it('treats process or storage failure as unhealthy', () => {
    expect(aggregateHealth({
      process: { tag: 'failed', reason: 'dead' },
      storage: { tag: 'ready' },
      browser: { tag: 'ready' },
      checkedAt: '2026-08-30T00:00:00.000Z',
    })).toBe('unhealthy');
    expect(aggregateHealth({
      process: { tag: 'ready' },
      storage: { tag: 'failed', reason: 'corrupt' },
      browser: { tag: 'ready' },
      checkedAt: '2026-08-30T00:00:00.000Z',
    })).toBe('unhealthy');
  });
});

describe('filterCapabilitiesForComputer', () => {
  it('filterCapabilitiesForComputer drops invoke on self-hosted', () => {
    expect(filterCapabilitiesForComputer('self-hosted-headless', [
      'client:browser:invoke',
      'other',
    ])).toEqual(['other']);
  });

  it('leaves client:browser:invoke for local-client', () => {
    expect(filterCapabilitiesForComputer('local-client', [
      'client:browser:invoke',
    ])).toEqual(['client:browser:invoke']);
  });
});
