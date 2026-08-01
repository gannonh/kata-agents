import { describe, expect, it } from 'bun:test';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { registerSupplementalOpenAIModels } from './supplemental-models.ts';

describe('supplemental OpenAI models', () => {
  it('registers GPT-5.6 models for OpenAI and Codex runtimes', async () => {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      allowModelNetwork: false,
    });
    const registry = new ModelRegistry(runtime);
    registerSupplementalOpenAIModels(registry);

    for (const provider of ['openai', 'openai-codex']) {
      for (const modelId of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
        const model = registry.find(provider, modelId);
        expect(model?.id).toBe(modelId);
        expect(model?.provider).toBe(provider);
        expect(model?.contextWindow).toBe(1_050_000);
        expect(model?.maxTokens).toBe(128_000);
      }
    }
  });
});
