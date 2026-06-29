import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWebuiHandler } from '../http-server';

const TEMP_DIRS: string[] = [];

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as any;

function createTestWebuiDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kata-webui-token-auth-test-'));
  TEMP_DIRS.push(dir);
  writeFileSync(join(dir, 'login.html'), '<!doctype html><html><body>login</body></html>');
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>app</body></html>');
  return dir;
}

afterEach(() => {
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// The password is hashed asynchronously at handler creation; wait for it by
// hitting /api/auth once with the correct password so verifyPassword is ready.
async function withReadyHandler(run: (handler: ReturnType<typeof createWebuiHandler>) => Promise<void>): Promise<void> {
  const handler = createWebuiHandler({
    webuiDir: createTestWebuiDir(),
    secret: 'test-secret',
    password: 'dev-password',
    wsProtocol: 'wss',
    wsPort: 9100,
    getHealthCheck: () => ({ status: 'ok' }),
    logger,
  });

  // Prime the password hash by attempting a form login with the correct value.
  await handler.fetch(
    new Request('http://127.0.0.1/api/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'dev-password' }),
    }),
  );

  try {
    await run(handler);
  } finally {
    handler.dispose();
  }
}

describe('WebUI /api/auth/token', () => {
  it('sets a session cookie and redirects to / for a valid token', async () => {
    await withReadyHandler(async (handler) => {
      const response = await handler.fetch(
        new Request('http://127.0.0.1/api/auth/token?token=dev-password', {
          redirect: 'manual',
        }),
      );

      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/');
      const cookie = response.headers.get('set-cookie') ?? '';
      expect(cookie).toContain('craft_session=');
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Path=/');
    });
  });

  it('redirects to /login for an invalid token', async () => {
    await withReadyHandler(async (handler) => {
      const response = await handler.fetch(
        new Request('http://127.0.0.1/api/auth/token?token=wrong', {
          redirect: 'manual',
        }),
      );

      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/login');
      expect(response.headers.get('set-cookie')).toBeNull();
    });
  });

  it('rejects requests with no token parameter', async () => {
    await withReadyHandler(async (handler) => {
      const response = await handler.fetch(
        new Request('http://127.0.0.1/api/auth/token', { redirect: 'manual' }),
      );

      expect(response.status).toBe(400);
    });
  });
});
