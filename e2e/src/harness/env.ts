import { platform } from "node:os";

export type PrerequisiteResult =
  { readonly ok: true } | { readonly ok: false; readonly missing: string[] };

function firstNonEmpty(
  ...values: Array<string | undefined>
): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

export function formatMissingPrerequisiteError(
  phase: string,
  missing: readonly string[],
): string {
  return `${phase}: missing required environment variable(s): ${missing.join(", ")}. See e2e/README.md for setup.`;
}

// ----------------------------------------------------------------------------
// Agent provider configuration (@agent tier)
// ----------------------------------------------------------------------------

export type AgentProvider = "anthropic" | "openai-codex";

export interface AgentProviderConfig {
  readonly provider: AgentProvider;
  readonly model: string;
  /** API-key providers populate this value; OAuth providers leave it undefined. */
  readonly apiKey?: string;
}

// This repo's root .env uses KATA_-prefixed key names; unprefixed names are
// also accepted for parity with the adoption guide and external setups.
function anthropicApiKey(): string | undefined {
  return firstNonEmpty(
    process.env.KATA_ANTHROPIC_API_KEY,
    process.env.ANTHROPIC_API_KEY,
  );
}

const ANTHROPIC_KEY_NAMES = "KATA_ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY)";
const DEFAULT_MODELS: Record<AgentProvider, string> = {
  anthropic: "claude-haiku-4-5-20251001",
  "openai-codex": "gpt-5.6-luna",
};

function resolveProvider(): AgentProvider {
  const raw = firstNonEmpty(process.env.KATA_E2E_AGENT_PROVIDER)?.toLowerCase();
  if (raw === undefined) {
    // The local E2E harness should use the existing subscription by default.
    // Anthropic remains available as an explicit API-key override.
    return "openai-codex";
  }
  if (raw === "openai-codex") {
    return raw;
  }
  if (raw === "anthropic") {
    return raw;
  }
  throw new Error(
    `Unknown KATA_E2E_AGENT_PROVIDER="${raw}". Supported values: openai-codex or anthropic (or omit for the ChatGPT OAuth default).`,
  );
}

function keyNameFor(provider: AgentProvider): string {
  return provider === "openai-codex"
    ? "existing ChatGPT OAuth credentials for the chatgpt-plus connection"
    : ANTHROPIC_KEY_NAMES;
}

function apiKeyFor(provider: AgentProvider): string | undefined {
  return provider === "openai-codex" ? undefined : anthropicApiKey();
}

/** The `@agent` tier requires a real key or existing OAuth credential. */
export function readAgentProviderPrerequisite(): PrerequisiteResult {
  const provider = resolveProvider();
  if (provider === "openai-codex") {
    return { ok: true };
  }
  if (!apiKeyFor(provider)) {
    return { ok: false, missing: [keyNameFor(provider)] };
  }
  return { ok: true };
}

/**
 * Resolve the agent provider, model, and credential source for the @agent tier.
 * Provider defaults to openai-codex; model defaults per provider; both are
 * overridable via KATA_E2E_AGENT_PROVIDER / KATA_E2E_AGENT_MODEL. The
 * openai-codex path reuses the existing ChatGPT OAuth credential and never
 * reads or asks for an API key.
 */
export function readAgentProviderConfig(): AgentProviderConfig {
  const provider = resolveProvider();
  const apiKey = apiKeyFor(provider);
  if (provider !== "openai-codex" && !apiKey) {
    throw new Error(
      formatMissingPrerequisiteError("Agent provider config", [
        keyNameFor(provider),
      ]),
    );
  }
  const model =
    firstNonEmpty(process.env.KATA_E2E_AGENT_MODEL) ?? DEFAULT_MODELS[provider];
  return { provider, model, apiKey };
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
