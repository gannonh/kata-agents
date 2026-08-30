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

/**
 * How a candidate authenticates. OAuth candidates reuse the existing codex
 * OAuth credential (chatgpt-plus connection); api-key candidates enter a key.
 */
export type AgentAuthMode = "oauth" | "api-key";

/**
 * One entry in the agent provider fallback chain. The chain is read from
 * KATA_E2E_AGENT_PROVIDER (+ KATA_E2E_AGENT_MODEL) plus numbered fallbacks
 * KATA_E2E_AGENT_PROVIDER_02/MODEL_02, _03, ... so new fallback levels can be
 * added to root .env without any code change. Tests walk the chain via
 * runWithAgentProviderFallback and only fail after every option is exhausted.
 */
export interface AgentProviderCandidate {
  /** 1-based position in the chain (1 = primary). */
  readonly index: number;
  /** Provider id, e.g. openai-codex, opencode-go, openrouter, deepseek, anthropic. */
  readonly provider: string;
  readonly model: string;
  readonly auth: AgentAuthMode;
  /** API key for api-key candidates (and the openai-codex OAuth fallback). */
  readonly apiKey?: string;
  /** Human-readable credential source for logs and errors. */
  readonly keySource: string;
  /** False when the candidate cannot run (missing key/model env). */
  readonly ready: boolean;
  /** Why the candidate is not ready (empty when ready). */
  readonly readyReason: string;
}

/** Root .env key that carries the API key for each provider. */
const PROVIDER_KEY_ENV: Record<string, string> = {
  "openai-codex": "KATA_OPENAI_API_KEY",
  "opencode-go": "KATA_OPENCODE_GO_API_KEY",
  "openrouter": "KATA_OPENROUTER_API_KEY",
  "deepseek": "KATA_DEEPSEEK_API_KEY",
  "anthropic": "KATA_ANTHROPIC_API_KEY",
};

/** Providers that authenticate through the existing codex OAuth credential. */
const OAUTH_PROVIDERS: ReadonlySet<string> = new Set(["openai-codex"]);

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-haiku-4-5-20251001",
  "openai-codex": "gpt-5.6-luna",
};

function keyNameForProvider(provider: string): string {
  return PROVIDER_KEY_ENV[provider] ?? `KATA_*_API_KEY (unknown provider ${provider})`;
}

/** Read a numbered fallback env var (e.g. KATA_E2E_AGENT_MODEL_03). */
function numberedEnv(prefix: string, index: number): string | undefined {
  return firstNonEmpty(process.env[`${prefix}_${String(index).padStart(2, "0")}`]);
}

function buildCandidate(index: number, providerRaw: string, modelRaw: string | undefined): AgentProviderCandidate {
  const provider = providerRaw.trim().toLowerCase();
  const keyEnv = PROVIDER_KEY_ENV[provider];
  if (!keyEnv) {
    return {
      index,
      provider,
      model: modelRaw?.trim() ?? "",
      auth: "api-key",
      keySource: keyNameForProvider(provider),
      ready: false,
      readyReason: `unknown provider; supported: ${Object.keys(PROVIDER_KEY_ENV).join(", ")}`,
    };
  }

  const oauth = OAUTH_PROVIDERS.has(provider);
  const apiKey = firstNonEmpty(process.env[keyEnv]);
  const model = firstNonEmpty(modelRaw) ?? DEFAULT_MODELS[provider];

  if (!model) {
    return {
      index,
      provider,
      model: "",
      auth: oauth ? "oauth" : "api-key",
      apiKey,
      keySource: keyEnv,
      ready: false,
      readyReason: `KATA_E2E_AGENT_MODEL${index === 1 ? "" : `_${String(index).padStart(2, "0")}`} is not set`,
    };
  }

  // OAuth providers prefer the existing credential; the API key is the
  // fallback when the OAuth credential is unavailable at runtime.
  if (oauth) {
    return {
      index,
      provider,
      model,
      auth: "oauth",
      apiKey,
      keySource: "chatgpt-plus OAuth (codex harness)",
      ready: true,
      readyReason: "",
    };
  }

  if (!apiKey) {
    return {
      index,
      provider,
      model,
      auth: "api-key",
      keySource: keyEnv,
      ready: false,
      readyReason: `${keyEnv} is not set`,
    };
  }

  return {
    index,
    provider,
    model,
    auth: "api-key",
    apiKey,
    keySource: keyEnv,
    ready: true,
    readyReason: "",
  };
}

/**
 * The ordered agent provider fallback chain: the primary candidate from
 * KATA_E2E_AGENT_PROVIDER / KATA_E2E_AGENT_MODEL (openai-codex default), then
 * every numbered KATA_E2E_AGENT_PROVIDER_0N / KATA_E2E_AGENT_MODEL_0N pair up
 * to the first gap. Unready candidates stay in the chain (skipped with a
 * logged reason) so the exhausted error lists every option.
 */
export function readAgentProviderChain(): AgentProviderCandidate[] {
  const chain: AgentProviderCandidate[] = [];
  chain.push(
    buildCandidate(1, process.env.KATA_E2E_AGENT_PROVIDER ?? "openai-codex", process.env.KATA_E2E_AGENT_MODEL),
  );
  for (let index = 2; index <= 99; index++) {
    const provider = numberedEnv("KATA_E2E_AGENT_PROVIDER", index);
    if (!provider) break;
    chain.push(buildCandidate(index, provider, numberedEnv("KATA_E2E_AGENT_MODEL", index)));
  }
  return chain;
}

/**
 * The @agent tier requires at least one ready credential in the fallback
 * chain (codex OAuth and/or any KATA_*_API_KEY). Missing entries are listed
 * so the failure names every option that is not configured.
 */
export function readAgentProviderPrerequisite(): PrerequisiteResult {
  const chain = readAgentProviderChain();
  const ready = chain.find((candidate) => candidate.ready);
  if (ready) {
    return { ok: true };
  }
  return {
    ok: false,
    missing: chain.map((candidate) =>
      candidate.readyReason ? `${candidate.keySource} (${candidate.readyReason})` : candidate.keySource,
    ),
  };
}

/**
 * The primary (or first ready) candidate. Kept for callers that only need a
 * single config; agent-requiring tests should use the full chain via
 * {@link readAgentProviderChain} and {@link runWithAgentProviderFallback}.
 */
export function readAgentProviderConfig(): AgentProviderCandidate {
  const chain = readAgentProviderChain();
  return chain.find((candidate) => candidate.ready) ?? chain[0];
}

export function readWorkerCount(): number {
  const configured = Number.parseInt(process.env.KATA_E2E_WORKERS ?? "1", 10);
  return Number.isInteger(configured) && configured > 0 ? configured : 1;
}

export function isVideoEnabled(): boolean {
  return process.env.KATA_E2E_VIDEO === "1";
}

export function readComputerHeadlessPrerequisite(): PrerequisiteResult {
  const missing: string[] = [];
  if (!firstNonEmpty(process.env.KATA_E2E_COMPUTER_URL)) {
    missing.push("KATA_E2E_COMPUTER_URL");
  }
  if (!firstNonEmpty(process.env.KATA_E2E_COMPUTER_TOKEN)) {
    missing.push("KATA_E2E_COMPUTER_TOKEN");
  }
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true };
}

export function assertMacOsHost(): void {
  if (platform() !== "darwin") {
    throw new Error(
      "Kata Agents local Electron E2E currently supports macOS only. Run these tests on a macOS GUI session.",
    );
  }
}
