import { platform } from "node:os";

export type PrerequisiteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly missing: string[] };

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

export function formatMissingPrerequisiteError(phase: string, missing: readonly string[]): string {
  return `${phase}: missing required environment variable(s): ${missing.join(", ")}. See e2e/README.md for setup.`;
}

// This repo's root .env uses the KATA_-prefixed name; the unprefixed name is
// also accepted for parity with the adoption guide and external setups.
function anthropicApiKey(): string | undefined {
  return firstNonEmpty(process.env.KATA_ANTHROPIC_API_KEY, process.env.ANTHROPIC_API_KEY);
}

const ANTHROPIC_KEY_NAMES = "KATA_ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY)";

/** The `@agent` tier requires a real Anthropic key from root .env. */
export function readAnthropicKeyPrerequisite(): PrerequisiteResult {
  if (!anthropicApiKey()) {
    return { ok: false, missing: [ANTHROPIC_KEY_NAMES] };
  }
  return { ok: true };
}

export function readAnthropicApiKey(): string {
  const key = anthropicApiKey();
  if (!key) {
    throw new Error(formatMissingPrerequisiteError("Agent provider config", [ANTHROPIC_KEY_NAMES]));
  }
  return key;
}

/** Path to a packaged .app for the desktop-release project. Fails loud when unset. */
export function readReleaseAppPath(): string {
  const path = firstNonEmpty(process.env.KATA_E2E_RELEASE_APP);
  if (!path) {
    throw new Error(
      formatMissingPrerequisiteError("Release launch", ["KATA_E2E_RELEASE_APP"]),
    );
  }
  return path;
}

export function readWorkerCount(): number {
  const configured = Number.parseInt(process.env.KATA_E2E_WORKERS ?? "1", 10);
  return Number.isInteger(configured) && configured > 0 ? configured : 1;
}

export function isVideoEnabled(): boolean {
  return process.env.KATA_E2E_VIDEO === "1";
}

export function assertMacOsHost(): void {
  if (platform() !== "darwin") {
    throw new Error(
      "Kata Agents local Electron E2E currently supports macOS only. Run these tests on a macOS GUI session.",
    );
  }
}
