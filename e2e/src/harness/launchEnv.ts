import type { E2ERunContext } from "./isolatedRun.ts";

const DEV_ONLY_ENV_KEYS = ["VITE_DEV_SERVER_URL", "KATA_VITE_PORT"] as const;

export function buildElectronLaunchEnv(context: E2ERunContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...context.devEnv,
    ELECTRON_ENABLE_LOGGING: "1",
  };
  delete env.ELECTRON_RUN_AS_NODE;

  if (context.launchTarget === "release") {
    // Packaged apps load from an embedded build, not Vite. Strip dev-only keys.
    for (const key of DEV_ONLY_ENV_KEYS) {
      delete env[key];
    }
  }

  return env;
}

/**
 * Dev: the renderer window is served by Vite on the allocated port.
 * Release: the packaged app loads the renderer from a file:// URL
 * (window-manager.ts loadFile renderer/index.html). Non-renderer windows use
 * about:blank or devtools URLs and must be excluded in both modes.
 */
export function isRendererWindow(
  url: string,
  vitePort: number,
  launchTarget: "dev" | "release" = "dev",
): boolean {
  if (!url || url === "about:blank" || url.startsWith("devtools://")) {
    return false;
  }

  try {
    const parsed = new URL(url);

    if (launchTarget === "release") {
      // Packaged renderer is a file:// URL pointing at renderer/index.html.
      return parsed.protocol === "file:" && parsed.pathname.endsWith("index.html");
    }

    const host = parsed.hostname;
    const port =
      parsed.port.length > 0
        ? Number.parseInt(parsed.port, 10)
        : parsed.protocol === "https:"
          ? 443
          : 80;
    return (host === "127.0.0.1" || host === "localhost") && port === vitePort;
  } catch {
    return false;
  }
}
