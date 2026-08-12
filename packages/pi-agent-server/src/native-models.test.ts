import { describe, expect, it } from 'bun:test';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';

describe('native Pi models', () => {
  it('resolves GPT-5.6 Sol, Terra, and Luna from Pi 0.84.1 for OpenAI and Codex', async () => {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      allowModelNetwork: false,
    });
    const registry = new ModelRegistry(runtime);
    const expectedCosts = {
      'gpt-5.6-sol': { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
      'gpt-5.6-terra': { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
      'gpt-5.6-luna': { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
    };

    for (const provider of ['openai', 'openai-codex']) {
      for (const modelId of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'] as const) {
        expect(registry.find(provider, modelId)).toMatchObject({
          id: modelId,
          provider,
          contextWindow: 272_000,
          maxTokens: 128_000,
          cost: expectedCosts[modelId],
        });
      }
    }
  });

  it('accepts native OAuth credentials for the OAuth-only Codex provider', async () => {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify('openai-codex', async () => ({
      type: 'oauth',
      access: 'access-token',
      refresh: 'refresh-token',
      expires: Date.now() + 60 * 60_000,
    }));
    const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
    const model = runtime.getModel('openai-codex', 'gpt-5.6-luna');

    expect(model).toBeDefined();
    await expect(runtime.getAuth(model!)).resolves.toMatchObject({
      auth: { apiKey: 'access-token' },
      source: 'OAuth',
    });
  });
});
