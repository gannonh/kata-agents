import { describe, expect, it } from 'bun:test';
import { piDriver, toModelDefinitions } from './pi.ts';

describe('Copilot reasoning capabilities', () => {
  it('preserves models and maps known reported efforts', () => {
    const [model] = toModelDefinitions([{
      id: 'gpt-5-copilot',
      name: 'GPT-5 Copilot',
      supportedReasoningEfforts: ['minimal', 'high', 'future-effort'],
    }]);

    expect(model).toMatchObject({
      id: 'gpt-5-copilot',
      supportsThinking: true,
      supportedThinkingLevels: ['minimal', 'high'],
    });
  });

  it('ignores malformed reported effort values without dropping the model', () => {
    const [model] = toModelDefinitions([{
      id: 'malformed',
      name: 'Malformed',
      supportedReasoningEfforts: [1 as any, null as any, 'high'],
    }]);

    expect(model).toMatchObject({
      id: 'malformed',
      supportsThinking: true,
      supportedThinkingLevels: ['high'],
    });
  });

  it('distinguishes missing and explicitly empty effort metadata', () => {
    const models = toModelDefinitions([
      { id: 'unknown', name: 'Unknown' },
      { id: 'disabled', name: 'Disabled', supportedReasoningEfforts: [] },
      { id: 'future-only', name: 'Future', supportedReasoningEfforts: ['future-effort'] },
    ]);

    expect(models[0]?.supportedThinkingLevels).toBeUndefined();
    expect(models[0]?.supportsThinking).toBeUndefined();
    expect(models[1]).toMatchObject({ supportsThinking: false, supportedThinkingLevels: [] });
    expect(models[2]).toMatchObject({ supportsThinking: false, supportedThinkingLevels: [] });
  });
});

describe('piDriver.buildRuntime custom endpoint models', () => {
  it('preserves explicit per-model supportsImages values', () => {
    const runtime = piDriver.buildRuntime({
      context: {
        provider: 'pi',
        authType: 'api_key',
        resolvedModel: 'vision-model',
        capabilities: { needsHttpPoolServer: false },
        connection: {
          slug: 'custom-endpoint',
          name: 'Custom Endpoint',
          providerType: 'pi',
          authType: 'api_key',
          baseUrl: 'http://127.0.0.1:11111/v1',
          customEndpoint: { api: 'anthropic-messages', supportsImages: true },
          models: [
            { id: 'vision-model', contextWindow: 262_144, supportsImages: true },
            { id: 'text-only-model', supportsImages: false },
            { id: 'plain-model' },
          ],
          createdAt: Date.now(),
        } as any,
      },
      coreConfig: {} as any,
      hostRuntime: {} as any,
      resolvedPaths: {
        piServerPath: '/tmp/pi-agent-server.js',
        interceptorBundlePath: '/tmp/interceptor.cjs',
        nodeRuntimePath: '/usr/bin/node',
      },
    });

    expect(runtime.customModels).toEqual([
      { id: 'vision-model', contextWindow: 262_144, supportsImages: true },
      { id: 'text-only-model', supportsImages: false },
      'plain-model',
    ]);
  });
});
