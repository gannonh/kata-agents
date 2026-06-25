import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { formatMissingPrerequisiteError } from "./env.ts";

/**
 * Resolve the packaged macOS `.app` bundle path from KATA_E2E_RELEASE_APP.
 * Fails loud (with the variable name) when unset or missing.
 */
export function resolveReleaseAppBundlePath(): string {
  const configured = process.env.KATA_E2E_RELEASE_APP?.trim();
  if (!configured) {
    throw new Error(
      formatMissingPrerequisiteError("desktop-release launch", ["KATA_E2E_RELEASE_APP"]) +
        " Set KATA_E2E_RELEASE_APP to a built macOS .app bundle, e.g. /Applications/Kata Agents.app.",
    );
  }

  if (!existsSync(configured)) {
    throw new Error(
      `desktop-release launch: release app bundle does not exist at ${configured}. Build one (bun run e2e:build-release) or point KATA_E2E_RELEASE_APP at a local app.`,
    );
  }

  return configured;
}

/**
 * Resolve the executable inside a macOS `.app` bundle. Playwright's
 * _electron.launch needs the binary under Contents/MacOS, not the bundle dir.
 */
export function resolveReleaseExecutablePath(): string {
  const bundlePath = resolveReleaseAppBundlePath();
  const macOsDir = join(bundlePath, "Contents", "MacOS");

  if (!existsSync(macOsDir)) {
    throw new Error(
      `desktop-release launch: expected macOS bundle layout at ${macOsDir}. Supply a .app bundle via KATA_E2E_RELEASE_APP.`,
    );
  }

  const executables = readdirSync(macOsDir).filter((entry) => !entry.startsWith("."));
  if (executables.length === 0) {
    throw new Error(
      `desktop-release launch: no executable found under ${macOsDir}. Supply a valid macOS app bundle.`,
    );
  }

  const preferred =
    executables.find((entry) => entry.toLowerCase().includes("kata")) ?? executables[0];
  return join(macOsDir, preferred);
}
