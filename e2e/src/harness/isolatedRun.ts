import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { findAvailablePort } from "./ports.ts";
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
  readonly devEnv: NodeJS.ProcessEnv;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const cleanupCallbacksByRunId = new Map<string, Array<() => Promise<void> | void>>();

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
  // scripts/electron-dev.ts:277-292. Single owner for E2E dev-stack env.
  const devEnv: NodeJS.ProcessEnv = {
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
    devEnv,
  };
}

export async function cleanupRunState(context: E2ERunContext): Promise<void> {
  const callbacks = cleanupCallbacksByRunId.get(context.runId) ?? [];
  for (const callback of [...callbacks].reverse()) {
    await callback();
  }
  cleanupCallbacksByRunId.delete(context.runId);
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
