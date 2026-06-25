import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";

import { appendProcessLog } from "./artifacts.ts";
import { E2E_TIMEOUTS } from "../config/timeouts.ts";
import { assertDesktopBuildArtifacts } from "./desktopArtifacts.ts";
import { startDevStack } from "./devStack.ts";
import type { E2ERunContext } from "./isolatedRun.ts";
import { registerCleanup } from "./isolatedRun.ts";
import { logHarnessPhase } from "./log.ts";
import { buildElectronLaunchEnv, isRendererWindow } from "./launchEnv.ts";
import { resolveReleaseExecutablePath } from "./releaseTarget.ts";

function attachElectronLogging(context: E2ERunContext, app: ElectronApplication): void {
  app.on("window", (page) => {
    page.on("console", (message) => {
      void appendProcessLog(context, "renderer-console", `[${message.type()}] ${message.text()}\n`);
    });
    page.on("pageerror", (error) => {
      void appendProcessLog(
        context,
        "renderer-pageerror",
        `${error.message}\n${error.stack ?? ""}\n`,
      );
    });
  });
}

// Console error messages that are network/resource noise rather than fatal
// bootstrap JS failures. The dev index.html injects a React DevTools script
// (http://localhost:8097) that is absent in E2E, producing a benign
// ERR_CONNECTION_REFUSED resource error.
function isBenignConsoleError(text: string): boolean {
  return (
    text.startsWith("Failed to load resource") ||
    text.includes("localhost:8097") ||
    text.includes("ERR_CONNECTION_REFUSED")
  );
}

function attachFatalLaunchErrorTracking(page: Page): () => readonly string[] {
  const errors: string[] = [];
  // Uncaught exceptions are always fatal.
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error" && !isBenignConsoleError(message.text())) {
      errors.push(message.text());
    }
  });
  return () => errors;
}

/** Playwright's electron.launch env requires defined string values. */
function toStringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

export interface LaunchedApp {
  readonly electronApp: ElectronApplication;
  readonly window: Page;
  readonly readFatalErrors: () => readonly string[];
}

async function resolveRendererWindow(
  electronApp: ElectronApplication,
  rendererPort: number,
  timeoutMs: number,
  launchTarget: "dev" | "release",
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  const expectation =
    launchTarget === "release" ? "file:// renderer window" : `Vite on port ${rendererPort}`;

  return await new Promise<Page>((resolve, reject) => {
    const onClose = () => {
      const windowUrls = electronApp.windows().map((page) => page.url());
      reject(
        new Error(
          `Electron exited before the renderer window opened (expected ${expectation}). Last windows: ${windowUrls.join(", ") || "(none)"}`,
        ),
      );
    };
    electronApp.once("close", onClose);

    const poll = async () => {
      while (Date.now() < deadline) {
        for (const page of electronApp.windows()) {
          if (isRendererWindow(page.url(), rendererPort, launchTarget)) {
            electronApp.off("close", onClose);
            resolve(page);
            return;
          }
        }
        await delay(250);
      }
      electronApp.off("close", onClose);
      const windowUrls = electronApp.windows().map((page) => page.url());
      reject(
        new Error(
          `Electron renderer window not found within ${timeoutMs}ms (expected ${expectation}). Open windows: ${windowUrls.join(", ") || "(none)"}`,
        ),
      );
    };
    void poll().catch(reject);
  });
}

export async function launchApp(context: E2ERunContext): Promise<LaunchedApp> {
  const env = buildElectronLaunchEnv(context);
  let electronApp: ElectronApplication;

  const launchEnv = toStringEnv(env);
  if (context.launchTarget === "release") {
    // Launch the packaged .app's executable. Fails loud when KATA_E2E_RELEASE_APP
    // is unset or the bundle is missing.
    const executablePath = resolveReleaseExecutablePath();
    logHarnessPhase("Launching packaged Electron app (release)...");
    electronApp = await electron.launch({ executablePath, env: launchEnv });
  } else {
    await assertDesktopBuildArtifacts(context.repoRoot);
    await startDevStack(context);
    logHarnessPhase("Launching Electron (dev)...");
    // Equivalent to `electron apps/electron`; Playwright resolves the local binary.
    electronApp = await electron.launch({
      args: [join(context.repoRoot, "apps/electron")],
      cwd: context.repoRoot,
      env: launchEnv,
    });
  }

  registerCleanup(context, async () => {
    await electronApp.close();
  });

  attachElectronLogging(context, electronApp);
  logHarnessPhase("Waiting for the Electron renderer window...");
  const window = await resolveRendererWindow(
    electronApp,
    context.vitePort,
    E2E_TIMEOUTS.electronWindowMs,
    context.launchTarget,
  );
  logHarnessPhase("Electron renderer window is ready.");

  const readFatalErrors = attachFatalLaunchErrorTracking(window);
  return { electronApp, window, readFatalErrors };
}
