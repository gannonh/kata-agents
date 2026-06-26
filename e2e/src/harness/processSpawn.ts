import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";

import { appendProcessLog } from "./artifacts.ts";
import type { E2ERunContext } from "./isolatedRun.ts";

function openArtifactLogFd(artifactRoot: string, label: string): number {
  mkdirSync(artifactRoot, { recursive: true });
  return openSync(join(artifactRoot, `${label}.log`), "a");
}

export function spawnWithArtifactLogs(
  context: E2ERunContext,
  input: {
    readonly label: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly env: NodeJS.ProcessEnv;
    readonly cwd: string;
  },
): ChildProcess {
  const stdoutFd = openArtifactLogFd(context.artifactRoot, `${input.label}-stdout`);
  const stderrFd = openArtifactLogFd(context.artifactRoot, `${input.label}-stderr`);

  const child = spawn(input.command, [...input.args], {
    cwd: input.cwd,
    env: input.env,
    stdio: ["ignore", stdoutFd, stderrFd],
  });

  closeSync(stdoutFd);
  closeSync(stderrFd);

  child.on("error", (error) => {
    void appendProcessLog(
      context,
      `${input.label}-spawn-error`,
      `${input.command} ${input.args.join(" ")}\ncwd=${input.cwd}\n${error.message}\n`,
    );
  });

  return child;
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export async function terminateChildProcess(child: ChildProcess): Promise<void> {
  if (childHasExited(child)) {
    return;
  }

  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    if (childHasExited(child)) {
      resolve();
      return;
    }

    child.kill("SIGTERM");
    setTimeout(() => {
      if (!childHasExited(child)) {
        child.kill("SIGKILL");
      }
    }, 5_000).unref();
  });
}
