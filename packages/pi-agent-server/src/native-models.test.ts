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
