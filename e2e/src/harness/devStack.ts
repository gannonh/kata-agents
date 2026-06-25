import { type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { E2E_TIMEOUTS } from "../config/timeouts.ts";
import { assertDesktopBuildArtifacts } from "./desktopArtifacts.ts";
import type { E2ERunContext } from "./isolatedRun.ts";
import { registerCleanup } from "./isolatedRun.ts";
import { logHarnessPhase } from "./log.ts";
import { spawnWithArtifactLogs, terminateChildProcess } from "./processSpawn.ts";
import { waitForViteDevServer } from "./readiness.ts";

export interface DevStackHandle {
  readonly process: ChildProcess;
}

/**
 * Vite only. Playwright launches the single Electron instance; running
 * electron:dev would also spawn its own Electron and duplicate backends.
 * Mirrors the Vite spawn in scripts/electron-dev.ts:541.
 */
export function buildViteArgs(vitePort: number): string[] {
  return [
    "dev",
    "--config",
    "apps/electron/vite.config.ts",
    "--port",
    String(vitePort),
    "--strictPort",
  ];
}

async function readLogTail(context: E2ERunContext, label: string): Promise<string | undefined> {
  try {
    const log = await readFile(join(context.artifactRoot, `${label}.log`), "utf8");
    return log.trimEnd().split("\n").slice(-20).join("\n");
  } catch {
    return undefined;
  }
}

export async function startDevStack(context: E2ERunContext): Promise<DevStackHandle> {
  await assertDesktopBuildArtifacts(context.repoRoot);

  logHarnessPhase(
    `Starting Vite dev server (port=${context.vitePort}, config=${context.configDir})`,
  );

  const viteBin = join(context.repoRoot, "node_modules", ".bin", "vite");
  const { process: child } = spawnWithArtifactLogs(context, {
    label: "dev-stack",
    command: viteBin,
    args: buildViteArgs(context.vitePort),
    cwd: context.repoRoot,
    env: context.devEnv,
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

  return { process: child };
}
