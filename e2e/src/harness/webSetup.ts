/**
 * Web E2E fixture — starts an isolated WebUI server, authenticates the page
 * via the /login password form, and tears the server down when the fixture
 * scope ends.
 *
 * Setup/teardown lives in the fixture (not Playwright `webServer` config) so it
 * works identically for `bun run e2e:web`, direct-file runs, and the VS Code
 * Playwright extension — none of them need to detect which project is running.
 *
 * Mirrors the kata-code e2e/src/harness/webSetup.ts pattern.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Page, test as base, expect } from "@playwright/test";

const WEB_PORT = Number(process.env["KATA_WEBUI_E2E_PORT"] ?? 9100);
const WEB_PASSWORD = process.env["KATA_WEBUI_PASSWORD"] ?? "dev";
const WEB_BASE_URL = process.env["KATA_WEBUI_E2E_URL"] ?? `http://localhost:${WEB_PORT}`;
const SERVER_READY_TIMEOUT_MS = 120_000;

export interface WebFixture {
  webUrl: string;
}

function resolveRepoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

/**
 * Allocate a free TCP port by binding to port 0 and reading the OS-assigned
 * port. Avoids a hard-coded port colliding with a developer's running server.
 */
function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate a TCP port for the WebUI server."));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function isServerReady(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: "GET", redirect: "manual" });
    return response.status > 0;
  } catch {
    return false;
  }
}

/**
 * Start the isolated WebUI server script as a detached child process and poll
 * /login until it responds. Returns the process handle for teardown.
 */
async function startWebServer(port: number, configDir: string): Promise<ChildProcess> {
  const repoRoot = resolveRepoRoot();
  const script = join(repoRoot, "e2e", "scripts", "start-web-e2e-server.sh");

  const child = spawn("bash", [script], {
    cwd: repoRoot,
    env: {
      ...process.env,
      KATA_CONFIG_DIR: configDir,
      KATA_WEBUI_PASSWORD: WEB_PASSWORD,
      KATA_RPC_PORT: String(port),
    },
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
  });

  const readyUrl = `http://localhost:${port}/login`;
  const startedAt = Date.now();
  while (Date.now() - startedAt < SERVER_READY_TIMEOUT_MS) {
    if (await isServerReady(readyUrl)) {
      return child;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`WebUI server exited before becoming ready.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Timed out waiting for WebUI server at ${readyUrl}.`);
}

/**
 * Authenticate a Playwright page by filling the /login password form. The app
 * sets a session cookie and redirects to "/".
 */
async function authenticatePage(page: Page, webUrl: string, password: string): Promise<void> {
  await page.goto(`${webUrl}/login`);
  await page.getByLabel("Server Token").fill(password);
  await page.getByRole("button", { name: "Sign In" }).click();
  await page.waitForURL((url) => url.pathname === "/", { timeout: 30_000 });
  await expect(page.locator("#root")).toBeAttached();
}

export const webTest = base.extend<{ webPage: Page; webFixture: WebFixture }>({
  webFixture: async ({}, use) => {
    const port = await findAvailablePort();
    const configDir = mkdtempSync(join(tmpdir(), "kata-agents-web-e2e-config-"));
    const webUrl = `http://localhost:${port}`;
    let server: ChildProcess | null = null;

    try {
      server = await startWebServer(port, configDir);
      await use({ webUrl });
    } finally {
      if (server && server.pid) {
        try {
          process.kill(-server.pid, "SIGTERM");
        } catch {
          server.kill("SIGTERM");
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
        try {
          if (server.pid) process.kill(-server.pid, "SIGKILL");
        } catch {
          server.kill("SIGKILL");
        }
      }
      rmSync(configDir, { recursive: true, force: true });
    }
  },
  webPage: async ({ page, webFixture }, use) => {
    await authenticatePage(page, webFixture.webUrl, WEB_PASSWORD);
    await use(page);
  },
});

export { expect };
