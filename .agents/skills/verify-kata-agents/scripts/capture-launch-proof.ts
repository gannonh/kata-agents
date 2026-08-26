#!/usr/bin/env -S node --experimental-strip-types

import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { waitForOnboardingOrReady, waitForRootMounted } from "../../../../e2e/src/flows/shell.ts";
import { launchApp } from "../../../../e2e/src/harness/appLaunch.ts";
import { writeRunManifest } from "../../../../e2e/src/harness/artifacts.ts";
import {
  cleanupRunState,
  createIsolatedRun,
} from "../../../../e2e/src/harness/isolatedRun.ts";
import type { E2ERunContext } from "../../../../e2e/src/harness/isolatedRun.ts";
import { runDoctor } from "./doctor.ts";

async function requireEvidence(paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    await access(path);
  }
}

async function run(): Promise<void> {
  const context: E2ERunContext = await createIsolatedRun({
    projectName: "verify-kata-agents-launch-proof",
    launchTarget: "dev",
  });
  const manifestPath = await writeRunManifest(context);
  const evidence = [
    manifestPath,
    join(context.artifactRoot, "launch-actions.txt"),
    join(context.artifactRoot, "launch-proof.png"),
    join(context.artifactRoot, "launch-proof.aria.yml"),
  ];

  let runError: Error | undefined;
  let cleanupError: Error | undefined;
  try {
    const launched = await launchApp(context);
    const page = launched.window;
    await waitForRootMounted(page);
    await page.locator("#root").waitFor({ state: "attached" });
    const shell = await waitForOnboardingOrReady(page);
    const aria = await page.locator("#root").ariaSnapshot();

    await writeFile(
      join(context.artifactRoot, "launch-actions.txt"),
      [
        "Action: launch the real Electron app through the isolated Playwright desktop-dev harness.",
        `Run ID: ${context.runId}`,
        `Vite port: ${context.vitePort}`,
        `Observed shell: ${shell}`,
        "Result: #root mounted and the onboarding/ready shell became visible.",
      ].join("\n") + "\n",
      "utf8",
    );
    await writeFile(join(context.artifactRoot, "launch-proof.aria.yml"), `${aria}\n`, "utf8");
    await page.screenshot({
      path: join(context.artifactRoot, "launch-proof.png"),
      fullPage: true,
    });

    await runDoctor(manifestPath, { repoRoot: context.repoRoot });
    const fatalErrors = launched.readFatalErrors();
    if (fatalErrors.length > 0) {
      throw new Error(`Fatal renderer errors: ${fatalErrors.join(" | ")}`);
    }
  } catch (error) {
    runError = error instanceof Error ? error : new Error(String(error));
  } finally {
    try {
      await cleanupRunState(context);
    } catch (error) {
      cleanupError = error instanceof Error ? error : new Error(String(error));
    }
  }

  if (runError) {
    if (cleanupError) {
      runError = new Error(`${runError.message}; cleanup also failed: ${cleanupError.message}`);
    }
    throw runError;
  }
  if (cleanupError) {
    throw cleanupError;
  }

  await requireEvidence(evidence);
  console.log(`[verify] PASS ${context.runId}`);
  for (const path of evidence) console.log(`[verify] evidence: ${path}`);
}

run().catch((error: unknown) => {
  console.error(`[verify] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
