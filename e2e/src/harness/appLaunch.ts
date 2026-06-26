import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";

import { appendProcessLog } from "./artifacts.ts";
import { E2E_TIMEOUTS } from "../config/timeouts.ts";
import { startDevStack } from "./devStack.ts";
import type { E2ERunContext } from "./isolatedRun.ts";
import { registerCleanup } from "./isolatedRun.ts";
import { logHarnessPhase } from "./log.ts";
import { buildElectronLaunchEnv, isRendererWindow } from "./launchEnv.ts";
import { resolveReleaseExecutablePath } from "./releaseTarget.ts";

// Console error messages that are network/resource noise rather than fatal
// bootstrap JS failures. The dev index.html injects a React DevTools script
// (http://localhost:8097) that is absent in E2E, producing a benign
// ERR_CONNECTION_REFUSED resource error.
function isBenignConsoleError(text: string): boolean {
  return (
    text.startsWith("Failed to load resource") &&
    text.includes("localhost:8097") &&
    text.includes("ERR_CONNECTION_REFUSED")
  );
}

/**
 * Attach console + pageerror listeners to every renderer window — those already
 * open and any opened later — and return a fatal-error reader for the
 * launch-health assertion. Registered synchronously after electron.launch
 * resolves so the initial window's bootstrap events are captured before
 * resolveRendererWindow completes. A fatal bootstrap pageerror otherwise
 * prevents the window from resolving, leaving the smoke assertion unrun.
 */
function attachRendererTracking(
  context: E2ERunContext,
  app: ElectronApplication,
): () => readonly string[] {
  const fatalErrors: string[] = [];

  const track = (page: Page): void => {
    const isCurrentRenderer = () =>
      isRendererWindow(page.url(), context.vitePort, context.launchTarget);

    page.on("console", (message) => {
      void appendProcessLog(
        context,
        "renderer-console",
        `[${message.type()}] ${message.text()}\n`,
      );
      if (
        isCurrentRenderer() &&
        message.type() === "error" &&
        !isBenignConsoleError(message.text())
      ) {
        fatalErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) => {
      if (!isCurrentRenderer()) {
        return;
      }
      fatalErrors.push(error.message);
      void appendProcessLog(
        context,
        "renderer-pageerror",
        `${error.message}\n${error.stack ?? ""}\n`,
      );
    });
  };

  for (const page of app.windows()) {
    track(page);
  }
  app.on("window", track);

  return () => [...fatalErrors];
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
    // startDevStack asserts the desktop build artifacts before spawning Vite.
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

  const readFatalErrors = attachRendererTracking(context, electronApp);

  logHarnessPhase("Waiting for the Electron renderer window...");
  const window = await resolveRendererWindow(
    electronApp,
    context.vitePort,
    E2E_TIMEOUTS.electronWindowMs,
    context.launchTarget,
  );
  logHarnessPhase("Electron renderer window is ready.");

  return { electronApp, window, readFatalErrors };
}
