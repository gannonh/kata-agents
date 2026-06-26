import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveArtifactRoot } from "./artifacts.ts";

export type LaunchTarget = "dev" | "release";

export interface E2ERunContext {
  readonly runId: string;
  readonly projectName: string;
  readonly launchTarget: LaunchTarget;
  readonly repoRoot: string;
  readonly configDir: string;
  readonly vitePort: number;
  readonly artifactRoot: string;
  /** Base env for the dev stack + Electron launch, mirroring getElectronEnv(). */
  readonly baseEnv: NodeJS.ProcessEnv;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const cleanupCallbacksByRunId = new Map<string, Array<() => Promise<void> | void>>();

/**
 * Allocate a free TCP port by binding to port 0 on the loopback interface and
 * reading the OS-assigned port. Kata Agents uses a single Vite port per run
 * (no server/web offset pair), so this is intentionally minimal.
 *
 * Note: there is an inherent race between releasing the probe socket and the
 * caller binding the port. V1 runs `workers: 1`, so concurrent allocation is
 * not a concern; a follow-up issue tracks subprocess server-port isolation for
 * `workers > 1`.
 */
function findAvailablePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "localhost", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate a TCP port (no address from net server)."));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function createRunId(): string {
  return `e2e-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

export async function createIsolatedRun(input: {
  readonly projectName: string;
  readonly launchTarget: LaunchTarget;
}): Promise<E2ERunContext> {
  const runId = createRunId();
  const vitePort = await findAvailablePort();
  const configDir = await mkdtemp(join(tmpdir(), `kata-agents-e2e-config-${runId}-`));
  const artifactRoot = join(resolveArtifactRoot(), runId);
  const cleanupCallbacks: Array<() => Promise<void> | void> = [];

  // Mirror the dev-stack env keys from getElectronEnv() in
  // scripts/electron-dev.ts:277-292. Single owner for E2E launch env.
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    KATA_CONFIG_DIR: configDir,
    KATA_VITE_PORT: String(vitePort),
    VITE_DEV_SERVER_URL: `http://localhost:${vitePort}`,
    KATA_APP_NAME: "Kata Agents [E2E]",
    KATA_DEEPLINK_SCHEME: "kataagentse2e",
  };

  cleanupCallbacks.push(async () => {
    await rm(configDir, { recursive: true, force: true });
  });
  cleanupCallbacksByRunId.set(runId, cleanupCallbacks);

  return {
    runId,
    projectName: input.projectName,
    launchTarget: input.launchTarget,
    repoRoot,
    configDir,
    vitePort,
    artifactRoot,
    baseEnv,
  };
}

export async function cleanupRunState(context: E2ERunContext): Promise<void> {
  const callbacks = cleanupCallbacksByRunId.get(context.runId) ?? [];
  const errors: Error[] = [];
  try {
    for (const callback of [...callbacks].reverse()) {
      try {
        await callback();
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
  } finally {
    cleanupCallbacksByRunId.delete(context.runId);
  }
  if (errors.length > 0) {
    throw new Error(
      `E2E cleanup failed for ${context.runId}: ${errors.map((error) => error.message).join("; ")}`,
    );
  }
}

export function registerCleanup(
  context: E2ERunContext,
  callback: () => Promise<void> | void,
): void {
  const callbacks = cleanupCallbacksByRunId.get(context.runId);
  if (!callbacks) {
    throw new Error(`E2E run ${context.runId} is not registered for cleanup.`);
  }
  callbacks.push(callback);
}
