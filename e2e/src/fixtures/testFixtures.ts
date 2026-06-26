import { test as base, expect, type ElectronApplication, type Page } from "@playwright/test";

import { completeDeferredSetup } from "../flows/onboarding.ts";
import { waitForAppReady, waitForRootMounted } from "../flows/shell.ts";
import { launchApp, type LaunchedApp } from "../harness/appLaunch.ts";
import { writeRunManifest } from "../harness/artifacts.ts";
import { assertMacOsHost } from "../harness/env.ts";
import { logHarnessPhase } from "../harness/log.ts";
import {
  cleanupRunState,
  createIsolatedRun,
  type E2ERunContext,
  type LaunchTarget,
} from "../harness/isolatedRun.ts";

const LAUNCH_TARGETS = new Set<LaunchTarget>(["dev", "release"]);

function readLaunchTarget(testInfo: {
  project: { name: string; metadata: unknown };
}): LaunchTarget {
  const metadata = testInfo.project.metadata;
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !("launchTarget" in metadata) ||
    typeof metadata.launchTarget !== "string" ||
    !LAUNCH_TARGETS.has(metadata.launchTarget as LaunchTarget)
  ) {
    throw new Error(
      `E2E project "${testInfo.project.name}" must define metadata.launchTarget as "dev" or "release".`,
    );
  }
  return metadata.launchTarget as LaunchTarget;
}

export interface E2EFixtures {
  launchTarget: LaunchTarget;
  runContext: E2ERunContext;
  launchedApp: LaunchedApp;
  electronApp: ElectronApplication;
  appWindow: Page;
  authenticatedAppWindow: Page;
}

export const test = base.extend<E2EFixtures>({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixture with no upstream deps.
  launchTarget: async ({}, use, testInfo) => {
    await use(readLaunchTarget(testInfo));
  },
  runContext: async ({ launchTarget }, use, testInfo) => {
    assertMacOsHost();
    const context = await createIsolatedRun({
      projectName: testInfo.project.name,
      launchTarget,
    });
    await writeRunManifest(context);
    await use(context);
    await cleanupRunState(context);
  },
  launchedApp: async ({ runContext }, use) => {
    const launched = await launchApp(runContext);
    await use(launched);
  },
  electronApp: async ({ launchedApp }, use) => {
    await use(launchedApp.electronApp);
  },
  appWindow: async ({ launchedApp }, use) => {
    logHarnessPhase("Waiting for renderer #root to mount...");
    await waitForRootMounted(launchedApp.window);
    await use(launchedApp.window);
  },
  authenticatedAppWindow: async ({ appWindow }, use) => {
    logHarnessPhase("Driving deferred setup to reach the ready shell...");
    await completeDeferredSetup(appWindow);
    await waitForAppReady(appWindow);
    logHarnessPhase("Ready shell is visible.");
    await use(appWindow);
  },
});

export { expect };
