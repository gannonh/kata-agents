import { getModels } from '@mariozechner/pi-ai';
import type { Api, KnownProvider, Model } from '@mariozechner/pi-ai';
import { ModelRegistry } from '@mariozechner/pi-coding-agent';
import {
  SUPPLEMENTAL_OPENAI_MODELS,
  type SupplementalPiModel,
} from '../../shared/src/config/models-pi.ts';

type RegisteredModel = NonNullable<
  NonNullable<Parameters<ModelRegistry['registerProvider']>[1]['models']>
>[number];

function toRegisteredModel(model: Model<Api>): RegisteredModel {
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    headers: model.headers,
    compat: model.compat,
  };
}

function supplementalToRegisteredModel(model: SupplementalPiModel): RegisteredModel {
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

/**
 * Register OpenAI's newest models in the Pi runtime until the pinned Pi SDK
 * catalog includes them. AuthStorage remains the source of credentials; the
 * placeholder API key only satisfies ModelRegistry's provider registration
 * validation and is never sent when a credential is configured there.
 */
export function registerSupplementalOpenAIModels(registry: ModelRegistry): void {
  for (const provider of ['openai', 'openai-codex'] as const) {
    const existing = getModels(provider as KnownProvider).map(toRegisteredModel);
    const supplemental = SUPPLEMENTAL_OPENAI_MODELS
      .filter(model => model.provider === provider)
      .map(supplementalToRegisteredModel);
    const seen = new Set<string>();
    const models = [...existing, ...supplemental].filter(model => {
      if (seen.has(model.id)) return false;
      seen.add(model.id);
      return true;
    });

    registry.registerProvider(provider, {
      apiKey: 'KATA_AUTH_STORAGE',
      baseUrl: provider === 'openai'
        ? 'https://api.openai.com/v1'
        : 'https://chatgpt.com/backend-api',
      models,
    });
  }
}
