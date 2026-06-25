import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { E2ERunContext } from "./isolatedRun.ts";

const e2eRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function resolveE2eRoot(): string {
  return e2eRoot;
}

export function resolveArtifactRoot(): string {
  return join(e2eRoot, "test-results");
}

export function resolveRunManifestPath(runId: string): string {
  return join(resolveArtifactRoot(), runId, "manifest.json");
}

export interface RunManifest {
  readonly runId: string;
  readonly projectName: string;
  readonly launchTarget: "dev" | "release";
  readonly configDir: string;
  readonly vitePort: number;
  readonly artifactRoot: string;
  readonly createdAt: string;
}

export async function writeRunManifest(context: E2ERunContext): Promise<string> {
  const manifestPath = resolveRunManifestPath(context.runId);
  await mkdir(dirname(manifestPath), { recursive: true });

  const manifest: RunManifest = {
    runId: context.runId,
    projectName: context.projectName,
    launchTarget: context.launchTarget,
    configDir: context.configDir,
    vitePort: context.vitePort,
    artifactRoot: context.artifactRoot,
    createdAt: new Date().toISOString(),
  };

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifestPath;
}

export async function appendProcessLog(
  context: E2ERunContext,
  label: string,
  chunk: string,
): Promise<void> {
  const logPath = join(context.artifactRoot, `${label}.log`);
  await mkdir(dirname(logPath), { recursive: true });
  await writeFile(logPath, chunk, { flag: "a" });
}
