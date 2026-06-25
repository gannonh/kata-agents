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

// ----------------------------------------------------------------------------
// Agent provider configuration (@agent tier)
// ----------------------------------------------------------------------------

export type AgentProvider = "anthropic" | "openai";

export interface AgentProviderConfig {
  readonly provider: AgentProvider;
  readonly model: string;
  readonly apiKey: string;
}

// This repo's root .env uses KATA_-prefixed key names; unprefixed names are
// also accepted for parity with the adoption guide and external setups.
function anthropicApiKey(): string | undefined {
  return firstNonEmpty(process.env.KATA_ANTHROPIC_API_KEY, process.env.ANTHROPIC_API_KEY);
}

function openaiApiKey(): string | undefined {
  return firstNonEmpty(process.env.KATA_OPENAI_API_KEY, process.env.OPENAI_API_KEY);
}

const ANTHROPIC_KEY_NAMES = "KATA_ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY)";
const OPENAI_KEY_NAMES = "KATA_OPENAI_API_KEY (or OPENAI_API_KEY)";
const DEFAULT_MODELS: Record<AgentProvider, string> = {
  anthropic: "Haiku 4.5",
  openai: "gpt-5.4-mini",
};

function resolveProvider(): AgentProvider {
  const raw = firstNonEmpty(process.env.KATA_E2E_AGENT_PROVIDER)?.toLowerCase();
  if (raw === "openai" || raw === "anthropic") {
    return raw;
  }
  return "anthropic";
}

function keyNameFor(provider: AgentProvider): string {
  return provider === "openai" ? OPENAI_KEY_NAMES : ANTHROPIC_KEY_NAMES;
}

function apiKeyFor(provider: AgentProvider): string | undefined {
  return provider === "openai" ? openaiApiKey() : anthropicApiKey();
}

/** The `@agent` tier requires a real provider key in root .env. */
export function readAgentProviderPrerequisite(): PrerequisiteResult {
  const provider = resolveProvider();
  if (!apiKeyFor(provider)) {
    return { ok: false, missing: [keyNameFor(provider)] };
  }
  return { ok: true };
}

/**
 * Resolve the agent provider, model, and key for the @agent tier.
 * Provider defaults to anthropic; model defaults per provider; both are
 * overridable via KATA_E2E_AGENT_PROVIDER / KATA_E2E_AGENT_MODEL.
 */
export function readAgentProviderConfig(): AgentProviderConfig {
  const provider = resolveProvider();
  const apiKey = apiKeyFor(provider);
  if (!apiKey) {
    throw new Error(formatMissingPrerequisiteError("Agent provider config", [keyNameFor(provider)]));
  }
  const model = firstNonEmpty(process.env.KATA_E2E_AGENT_MODEL) ?? DEFAULT_MODELS[provider];
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
