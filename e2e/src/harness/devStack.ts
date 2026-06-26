import { access } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { E2E_TIMEOUTS } from "../config/timeouts.ts";
import type { E2ERunContext } from "./isolatedRun.ts";
import { registerCleanup } from "./isolatedRun.ts";
import { logHarnessPhase } from "./log.ts";
import { spawnWithArtifactLogs, terminateChildProcess } from "./processSpawn.ts";

// Dev launch loads the renderer from Vite (VITE_DEV_SERVER_URL), so the renderer
// dist is not required. The main + preload bundles must exist for Electron to boot.
const REQUIRED_DEV_ARTIFACTS = [
  "apps/electron/dist/main.cjs",
  "apps/electron/dist/bootstrap-preload.cjs",
] as const;

async function assertDesktopBuildArtifacts(repoRoot: string): Promise<void> {
  for (const relative of REQUIRED_DEV_ARTIFACTS) {
    const path = join(repoRoot, relative);
    try {
      await access(path);
    } catch {
      throw new Error(
        `desktop-dev launch: missing ${path}. Run "bun run ensure:electron" and "bun run electron:build" before E2E.`,
      );
    }
  }
}

/**
 * Vite only. Playwright launches the single Electron instance; running
 * electron:dev would also spawn its own Electron and duplicate backends.
 * Mirrors the Vite spawn in scripts/electron-dev.ts:541.
 */
function buildViteArgs(vitePort: number): string[] {
  return [
    "dev",
    "--config",
    "apps/electron/vite.config.ts",
    "--port",
    String(vitePort),
    "--strictPort",
  ];
}

// Vite binds to `localhost` (which may resolve to IPv6 ::1), matching
// VITE_DEV_SERVER_URL. Probe the same host rather than forcing 127.0.0.1.
async function waitForViteDevServer(vitePort: number, timeoutMs: number): Promise<void> {
  const url = `http://localhost:${vitePort}`;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status > 0) {
        return;
      }
    } catch {
      // Vite not up yet; keep polling.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for Vite dev server at ${url}.`);
}

async function readLogTail(context: E2ERunContext, label: string): Promise<string | undefined> {
  try {
    const log = await readFile(join(context.artifactRoot, `${label}.log`), "utf8");
    return log.trimEnd().split("\n").slice(-20).join("\n");
  } catch {
    return undefined;
  }
}

/**
 * Start Vite (only) on the allocated port and wait for it to serve. Asserts the
 * desktop build artifacts first. The returned process is tracked for cleanup;
 * callers do not need the handle.
 */
export async function startDevStack(context: E2ERunContext): Promise<void> {
  await assertDesktopBuildArtifacts(context.repoRoot);

  logHarnessPhase(
    `Starting Vite dev server (port=${context.vitePort}, config=${context.configDir})`,
  );

  const viteBin = join(context.repoRoot, "node_modules", ".bin", "vite");
  const child = spawnWithArtifactLogs(context, {
    label: "dev-stack",
    command: viteBin,
    args: buildViteArgs(context.vitePort),
    cwd: context.repoRoot,
    env: context.baseEnv,
  });

  registerCleanup(context, async () => {
    await terminateChildProcess(child);
  });

  logHarnessPhase("Waiting for Vite dev server...");
  try {
    await waitForViteDevServer(context.vitePort, E2E_TIMEOUTS.devStackMs);
  } catch (error) {
    const stderr = await readLogTail(context, "dev-stack-stderr");
    const spawnError = await readLogTail(context, "dev-stack-spawn-error");
    const details = [spawnError && `spawn-error:\n${spawnError}`, stderr && `stderr:\n${stderr}`]
      .filter(Boolean)
      .join("\n\n");
    throw new Error(`${(error as Error).message}\n${details}`);
  }
  logHarnessPhase("Vite dev server is ready.");
}
