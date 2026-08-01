import { describe, expect, it } from 'bun:test';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';

describe('native Pi models', () => {
  it('resolves GPT-5.6 Sol, Terra, and Luna from Pi 0.83 for OpenAI and Codex', async () => {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      allowModelNetwork: false,
    });
    const registry = new ModelRegistry(runtime);

    for (const provider of ['openai', 'openai-codex']) {
      for (const modelId of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
        expect(registry.find(provider, modelId)).toMatchObject({
          id: modelId,
          provider,
          contextWindow: 272_000,
          maxTokens: 128_000,
        });
      }
    }
  });
});
