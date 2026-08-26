#!/usr/bin/env -S node --experimental-strip-types

import { access, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { platform } from "node:os";

import { readAgentProviderChain } from "../../../../e2e/src/harness/env.ts";

interface RunManifest {
  readonly runId: string;
  readonly projectName: string;
  readonly launchTarget: "dev" | "release";
  readonly configDir: string;
  readonly vitePort: number;
  readonly artifactRoot: string;
}

interface ProcessRow {
  readonly pid: number;
  readonly user: string;
  readonly command: string;
}

interface DoctorOptions {
  readonly repoRoot?: string;
  readonly requireLiveProcesses?: boolean;
  readonly requiresAgent?: boolean;
}

function commandOutput(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function readProcessRows(): ProcessRow[] {
  let output = "";
  try {
    output = execFileSync("ps", ["-axo", "pid=,user=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }

  return output
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      pid: Number.parseInt(match[1], 10),
      user: match[2],
      command: match[3],
    }));
}

function readListeningPids(port: number): number[] {
  try {
    const output = execFileSync(
      "lsof",
      ["-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return [...output.matchAll(/^p(\d+)$/gm)].map((match) =>
      Number.parseInt(match[1], 10),
    );
  } catch {
    return [];
  }
}

async function requirePath(path: string, label: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new Error(`${label} is missing: ${path}`);
  }
}

async function readManifest(manifestPath: string): Promise<RunManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read manifest ${manifestPath}: ${String(error)}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Invalid manifest ${manifestPath}: expected an object.`);
  }

  const manifest = parsed as Partial<RunManifest>;
  if (
    typeof manifest.runId !== "string" ||
    typeof manifest.projectName !== "string" ||
    (manifest.launchTarget !== "dev" && manifest.launchTarget !== "release") ||
    typeof manifest.configDir !== "string" ||
    !Number.isInteger(manifest.vitePort) ||
    typeof manifest.artifactRoot !== "string"
  ) {
    throw new Error(`Invalid manifest ${manifestPath}: missing run identity fields.`);
  }
  return manifest as RunManifest;
}

export async function runDoctor(
  manifestPath: string,
  options: DoctorOptions = {},
): Promise<void> {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const manifest = await readManifest(resolve(manifestPath));

  if (platform() !== "darwin") {
    throw new Error("Kata Agents Electron verification requires macOS.");
  }

  const packageJson = JSON.parse(
    await readFile(join(repoRoot, "package.json"), "utf8"),
  ) as { name?: string; version?: string };
  if (packageJson.name !== "kata-agents" || !packageJson.version) {
    throw new Error("The repository root does not identify the kata-agents package.");
  }

  const revision = commandOutput("git", ["rev-parse", "--short", "HEAD"], repoRoot);
  await requirePath(join(repoRoot, "apps/electron/dist/main.cjs"), "Electron main bundle");
  await requirePath(
    join(repoRoot, "apps/electron/dist/bootstrap-preload.cjs"),
    "Electron preload bundle",
  );
  await requirePath(manifest.configDir, "Run config directory");
  await requirePath(manifest.artifactRoot, "Run artifact directory");

  const rows = readProcessRows();
  const currentUser = commandOutput("id", ["-un"], repoRoot);
  const ownedElectron = rows.filter(
    (row) =>
      row.user === currentUser &&
      row.command.includes(repoRoot) &&
      row.command.includes("electron") &&
      row.command.includes("apps/electron"),
  );

  if (options.requireLiveProcesses ?? true) {
    if (ownedElectron.length === 0) {
      throw new Error("No Electron process owned by this verification run is live.");
    }

    if (manifest.launchTarget === "dev") {
      const listeningPids = readListeningPids(manifest.vitePort);
      const ownedVite = rows.filter(
        (row) =>
          listeningPids.includes(row.pid) &&
          row.user === currentUser &&
          row.command.includes(repoRoot) &&
          row.command.includes("vite"),
      );
      if (ownedVite.length === 0) {
        throw new Error(
          `Vite port ${manifest.vitePort} is not owned by this repository's Vite process.`,
        );
      }
      console.log(
        `[doctor] owned Vite pid(s) ${ownedVite.map((row) => row.pid).join(", ")} on port ${manifest.vitePort}`,
      );
    }
  }

  if (options.requiresAgent) {
    const chain = readAgentProviderChain();
    const ready = chain.filter((candidate) => candidate.ready);
    if (ready.length === 0) {
      throw new Error(
        `No configured agent provider candidate is ready: ${chain.map((candidate) => candidate.readyReason).join("; ")}`,
      );
    }
    console.log(
      `[doctor] configured agent candidate(s): ${ready.map((candidate) => `${candidate.provider}/${candidate.model}`).join(", ")}`,
    );
  } else {
    console.log("[doctor] provider-free tier: authentication is not required");
  }

  console.log(
    `[doctor] PASS ${manifest.runId}: kata-agents ${packageJson.version} at ${revision} (${manifest.launchTarget})`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const manifestPath = args.find((arg) => !arg.startsWith("--"));
  if (!manifestPath) {
    throw new Error(
      "Usage: node --experimental-strip-types .agents/skills/verify-kata-agents/scripts/doctor.ts <manifest-path> [--agent]",
    );
  }
  await runDoctor(manifestPath, { requiresAgent: args.includes("--agent") });
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`[doctor] FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
