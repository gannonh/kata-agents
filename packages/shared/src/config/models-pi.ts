/**
 * Pi Model & Provider Discovery (from SDK)
 *
 * Separated from models.ts because @mariozechner/pi-ai transitively pulls in
 * @aws-sdk/client-bedrock-runtime → @smithy/node-http-handler → Node.js `stream`,
 * which breaks the Vite renderer build (browser context, no Node.js modules).
 *
 * This file should ONLY be imported from:
 *   - Main process code (Electron main, IPC handlers)
 *   - Server-side code (build scripts, CLI)
 *   - Registration calls (e.g., registerPiModelResolver)
 *
 * NEVER import this file from renderer components or from files that the renderer imports.
 */

import { getProviders, getModels } from '@mariozechner/pi-ai';
import type { KnownProvider, Model, Api } from '@mariozechner/pi-ai';
import type { ModelDefinition } from './models.ts';

// ============================================
// PI MODEL DISCOVERY
// ============================================

/**
 * Convert a Pi SDK Model to our ModelDefinition format.
 */
function piModelToDefinition(m: Model<Api>): ModelDefinition {
  const lastPart = m.name.split(/[\s-]/).pop() ?? m.name;
  const shortName = m.name.length > 20 ? lastPart : m.name;

  return {
    id: `pi/${m.id}`,
    name: m.name,
    shortName,
    description: `${m.provider} model via Kata Agents Backend`,
    provider: 'pi',
    contextWindow: m.contextWindow,
    supportsThinking: m.reasoning,
  };
}

/**
 * Supplemental OpenAI model metadata that may land after the Pi SDK catalog.
 * Keep this provider-specific so the runtime can resolve the same models for
 * both OpenAI API-key and ChatGPT/Codex authentication.
 */
export interface SupplementalPiModel {
  id: string;
  name: string;
  description: string;
  provider: 'openai' | 'openai-codex';
  api: 'openai-responses' | 'openai-codex-responses';
  baseUrl: string;
  reasoning: boolean;
  thinkingLevelMap: Record<string, string | null | undefined>;
  input: Array<'text' | 'image'>;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
}

const GPT_56_MODEL_SPECS = [
  {
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6 Sol',
    description: 'Frontier GPT-5.6 model for complex work',
    cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  },
  {
    id: 'gpt-5.6-terra',
    name: 'GPT-5.6 Terra',
    description: 'Balanced GPT-5.6 model for everyday work',
    cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
  },
  {
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    description: 'Fast, cost-efficient GPT-5.6 model',
    cost: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0 },
  },
] as const;

/**
 * OpenAI's GPT-5.6 family is available in the official API and Codex
 * catalogs, but the currently pinned Pi SDK does not include it yet.
 */
export const SUPPLEMENTAL_OPENAI_MODELS: readonly SupplementalPiModel[] =
  (['openai', 'openai-codex'] as const).flatMap((provider) =>
    GPT_56_MODEL_SPECS.map((model) => ({
      ...model,
      provider,
      api: provider === 'openai' ? 'openai-responses' : 'openai-codex-responses',
      baseUrl: provider === 'openai' ? 'https://api.openai.com/v1' : 'https://chatgpt.com/backend-api',
      reasoning: true,
      thinkingLevelMap: provider === 'openai'
        ? { off: null, xhigh: 'xhigh' }
        : { minimal: 'low', xhigh: 'xhigh' },
      input: ['text', 'image'],
      contextWindow: 1_050_000,
      maxTokens: 128_000,
    } satisfies SupplementalPiModel)),
  );

function supplementalPiModelToDefinition(model: SupplementalPiModel): ModelDefinition {
  return {
    id: `pi/${model.id}`,
    name: model.name,
    shortName: model.name,
    description: `${model.description} via Kata Agents Backend`,
    provider: 'pi',
    contextWindow: model.contextWindow,
    supportsThinking: model.reasoning,
  };
}

function dedupeModelDefinitions(models: ModelDefinition[]): ModelDefinition[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

/**
 * Models to EXCLUDE from the Pi model list.
 * Temporary workaround for models that are broken in the current Pi SDK version.
 * e.g., gemini-1.5-flash fails with "not found for API version v1beta"
 */
const PI_EXCLUDED_MODELS: Set<string> = new Set([
  // Unsupported 1.5 models
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
  'gemini-1.5-pro',

  // Unsupported 2.0 models
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',

  // Stale alias exposed by some SDK catalogs; fails at runtime in OpenAI API-key flow
  'codex-mini-latest',
]);

/**
 * Prefixes to EXCLUDE from the Pi model list.
 * Keep this list narrow and intentional.
 */
const PI_EXCLUDED_MODEL_PREFIXES: string[] = [
  // Requested cleanup: hide legacy GPT-4 family variants (gpt-4, gpt-4.1, gpt-4o, ...)
  'gpt-4',
];

export function isDeprecatedClaudeOpus46Model(modelId: string): boolean {
  const lower = modelId.toLowerCase().replace(/^pi\//, '');
  return lower === 'claude-opus-4-6'
    || lower === 'claude-opus-4.6'
    || lower === 'anthropic/claude-opus-4-6'
    || lower === 'anthropic/claude-opus-4.6'
    || lower.endsWith('.anthropic.claude-opus-4-6-v1')
    || lower === 'anthropic.claude-opus-4-6-v1';
}

function isExcludedPiModel(modelId: string): boolean {
  if (PI_EXCLUDED_MODELS.has(modelId)) return true;
  if (isDeprecatedClaudeOpus46Model(modelId)) return true;
  return PI_EXCLUDED_MODEL_PREFIXES.some(prefix => modelId.startsWith(prefix));
}

/**
 * Check if a Bedrock model ID is a bare Claude model without a region prefix.
 * Bare IDs like `anthropic.claude-opus-4-8` are rejected by Bedrock which
 * requires inference profile IDs with a region prefix (`us.`, `eu.`, `global.`).
 * The Pi SDK catalog includes proper regional variants, so filtering bare models
 * doesn't remove any usable entries.
 */
function isBareBedrockClaudeModel(modelId: string): boolean {
  return modelId.startsWith('anthropic.claude-');
}

/**
 * Get Pi models for a specific auth provider directly from the Pi SDK.
 */
export function getPiModelsForAuthProvider(piAuthProvider: string): ModelDefinition[] {
  let models: ModelDefinition[] = [];
  try {
    models = getModels(piAuthProvider as KnownProvider)
      .filter(m => !isExcludedPiModel(m.id))
      // Bedrock: exclude bare Claude models without region prefix — they're
      // always rejected by Bedrock which requires inference profiles (us.*/eu.*/global.*).
      // Regional variants from the same catalog are kept.
      .filter(m => piAuthProvider !== 'amazon-bedrock' || !isBareBedrockClaudeModel(m.id))
      .map(piModelToDefinition);
  } catch {
    // Provider not recognized by SDK — use supplemental entries when available.
  }

  const supplemental = SUPPLEMENTAL_OPENAI_MODELS
    .filter(model => model.provider === piAuthProvider)
    .map(supplementalPiModelToDefinition);

  return dedupeModelDefinitions([...models, ...supplemental]);
}

/**
 * Get all Pi models across all providers from the SDK and supplemental catalog.
 */
export function getAllPiModels(): ModelDefinition[] {
  const allModels: ModelDefinition[] = [];
  for (const provider of getProviders()) {
    try {
      const models = getModels(provider);
      allModels.push(...models
        .filter(m => !isExcludedPiModel(m.id))
        .map(piModelToDefinition)
      );
    } catch {
      // Skip providers that fail
    }
  }

  const existingIds = new Set(allModels.map(model => model.id));
  allModels.push(...SUPPLEMENTAL_OPENAI_MODELS
    .filter(model => !existingIds.has(`pi/${model.id}`))
    .map(supplementalPiModelToDefinition));
  return allModels;
}

// ============================================
// PI PROVIDER DISCOVERY
// ============================================

/**
 * Display metadata for Pi SDK providers.
 *
 * Keep this keyed by string instead of `KnownProvider` so the UI metadata can
 * stay ahead of or lag behind the SDK's exact provider union without blocking
 * typecheck/commits when providers are added or renamed upstream.
 */
const PI_PROVIDER_DISPLAY: Partial<Record<string, { label: string; placeholder: string }>> = {
  'anthropic':              { label: 'Anthropic',          placeholder: 'sk-ant-...' },
  'google':                 { label: 'Google AI Studio',   placeholder: 'AIza...' },
  'openai':                 { label: 'OpenAI',             placeholder: 'sk-...' },
  'openrouter':             { label: 'OpenRouter',         placeholder: 'sk-or-...' },
  'groq':                   { label: 'Groq',               placeholder: 'gsk_...' },
  'mistral':                { label: 'Mistral',            placeholder: 'Paste your key here...' },
  'deepseek':               { label: 'DeepSeek',           placeholder: 'sk-...' },
  'xai':                    { label: 'xAI (Grok)',         placeholder: 'xai-...' },
  'cerebras':               { label: 'Cerebras',           placeholder: 'csk-...' },
  'amazon-bedrock':         { label: 'Amazon Bedrock',     placeholder: 'AKIA...' },
  'azure-openai-responses': { label: 'Azure OpenAI',       placeholder: 'Paste your key here...' },
  'vercel-ai-gateway':      { label: 'Vercel AI Gateway',  placeholder: 'Paste your key here...' },
  'huggingface':            { label: 'Hugging Face',       placeholder: 'hf_...' },
  'minimax':                { label: 'Minimax',            placeholder: 'Paste your key here...' },
  'kimi-coding':            { label: 'Kimi (Coding)',      placeholder: 'sk-kimi-...' },
  'zai':                    { label: 'z.ai (GLM)',         placeholder: 'Paste your key here...' },
};

/**
 * Providers to EXCLUDE from the Pi API key dropdown.
 */
const PI_EXCLUDED_PROVIDERS: Set<string> = new Set([
  'github-copilot',
  'openai-codex',
  'google-vertex',
]);

/** Info for a Pi provider available in the API key flow. */
export interface PiProviderInfo {
  key: string;
  label: string;
  placeholder: string;
}

/** Convert 'vercel-ai-gateway' → 'Vercel Ai Gateway' etc. */
function formatProviderName(key: string): string {
  return key.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * Get all Pi providers available for API key authentication.
 */
export function getPiApiKeyProviders(): PiProviderInfo[] {
  return getProviders()
    .filter(p => !PI_EXCLUDED_PROVIDERS.has(p))
    .map(p => {
      const display = PI_PROVIDER_DISPLAY[p];
      return {
        key: p,
        label: display?.label ?? formatProviderName(p),
        placeholder: display?.placeholder ?? 'sk-...',
      };
    })
    .sort((a, b) => {
      const priority = ['anthropic', 'google', 'openai'];
      const ai = priority.indexOf(a.key);
      const bi = priority.indexOf(b.key);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.label.localeCompare(b.label);
    });
}

/**
 * Get the base URL for a Pi SDK provider (e.g. 'anthropic' → 'https://api.anthropic.com').
 */
export function getPiProviderBaseUrl(provider: string): string | undefined {
  try {
    const models = getModels(provider as Parameters<typeof getModels>[0]);
    return models[0]?.baseUrl || undefined;
  } catch {
    return undefined;
  }
}
