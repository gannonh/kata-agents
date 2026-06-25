import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Repo root is three levels up from e2e/src/config.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * Minimal dotenv-style parser.
 *
 * Strip a ` #...` inline comment that follows a value, and honor quoted
 * values (strip the quotes, preserving interior whitespace). This is stricter
 * than scripts/electron-dev.ts:loadEnvFile but avoids a common footgun: a line
 * like `KEY="value"   # comment` must yield `value`, not `value   # comment`.
 * Existing process.env values always win so explicit overrides are not clobbered.
 */
const COMMENT_AFTER_VALUE = /\s+#.*$/;

function parseValue(raw: string): string {
  let value = raw.trim();
  const first = value[0];
  if (first === '"' || first === "'") {
    const closing = value.indexOf(first, 1);
    if (closing > 0) {
      // Quoted: take the interior literally; drop anything after the close quote.
      return value.slice(1, closing);
    }
  }
  return value.replace(COMMENT_AFTER_VALUE, "");
}

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
    out[key] = parseValue(trimmed.slice(eqIndex + 1));
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
