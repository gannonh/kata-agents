import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Repo root is three levels up from e2e/src/config.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * Minimal .env parser mirroring loadEnvFile() in scripts/electron-dev.ts:98-120.
 * Existing process.env values win so explicit overrides are not clobbered.
 */
function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  const content = readFileSync(path, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadRepoEnv(): void {
  // .env.local overrides .env; neither overrides an already-set process.env key.
  for (const fileName of [".env", ".env.local"]) {
    const path = join(repoRoot, fileName);
    if (!existsSync(path)) {
      continue;
    }
    const parsed = parseEnvFile(path);
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

loadRepoEnv();
