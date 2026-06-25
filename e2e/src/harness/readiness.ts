import { setTimeout as delay } from "node:timers/promises";

import { E2E_TIMEOUTS } from "../config/timeouts.ts";

export async function waitForViteDevServer(
  vitePort: number,
  timeoutMs = E2E_TIMEOUTS.devStackMs,
  signal?: AbortSignal,
): Promise<void> {
  // Vite binds to `localhost` (which may resolve to IPv6 ::1), matching
  // VITE_DEV_SERVER_URL. Probe the same host rather than forcing 127.0.0.1.
  const url = `http://localhost:${vitePort}`;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (signal?.aborted) {
      throw signal.reason ?? new Error("waitForViteDevServer aborted");
    }

    try {
      const response = await fetch(url, { redirect: "manual", signal });
      if (response.status > 0) {
        return;
      }
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
    }

    await delay(500, undefined, signal ? { signal } : undefined);
  }

  throw new Error(`Timed out waiting for Vite dev server at ${url}.`);
}
