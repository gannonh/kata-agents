import { describe, it, expect } from 'bun:test';
import {
  deriveSupportedThinkingLevelsFromPiModel,
  getPiApiKeyProviders,
  getPiModelsForAuthProvider,
  mapReportedReasoningEfforts,
} from '../src/config/models-pi.ts';

describe('models-pi filtering', () => {
  it('excludes codex-mini-latest for openai models', () => {
    const models = getPiModelsForAuthProvider('openai');
    const ids = models.map(m => m.id);
    expect(ids.includes('pi/codex-mini-latest')).toBe(false);
  });

  it('excludes all gpt-4* models for openai models', () => {
    const models = getPiModelsForAuthProvider('openai');
    const ids = models.map(m => m.id);
    expect(ids.some(id => id.startsWith('pi/gpt-4'))).toBe(false);
  });

  it('excludes deprecated Claude Opus 4.6 models from Anthropic catalogs', () => {
    const anthropicIds = getPiModelsForAuthProvider('anthropic').map(m => m.id);
    expect(anthropicIds).not.toContain('pi/claude-opus-4-6');

    const copilotIds = getPiModelsForAuthProvider('github-copilot').map(m => m.id);
    expect(copilotIds).not.toContain('pi/claude-opus-4.6');

    const bedrockIds = getPiModelsForAuthProvider('amazon-bedrock').map(m => m.id);
    expect(bedrockIds.some(id => id.includes('claude-opus-4-6'))).toBe(false);
  });

  it('includes DeepSeek in the Pi API key provider list with a human-readable label', () => {
    const providers = getPiApiKeyProviders();
    expect(providers.some(provider => provider.key === 'deepseek' && provider.label === 'DeepSeek')).toBe(true);
  });

  it('returns current DeepSeek models from the Pi SDK catalog', () => {
    const models = getPiModelsForAuthProvider('deepseek');
    const ids = models.map(m => m.id);
    expect(ids).toContain('pi/deepseek-v4-flash');
    expect(ids).toContain('pi/deepseek-v4-pro');
  });

  it('derives Pi capability levels using null and xhigh map semantics', () => {
    expect(deriveSupportedThinkingLevelsFromPiModel(true, {
      off: null,
      xhigh: 'xhigh',
    })).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh']);
    expect(deriveSupportedThinkingLevelsFromPiModel(true, {
      minimal: 'low',
      xhigh: 'xhigh',
    })).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
    expect(deriveSupportedThinkingLevelsFromPiModel(true, {
      xhigh: null,
    })).toEqual(['off', 'minimal', 'low', 'medium', 'high']);
    expect(deriveSupportedThinkingLevelsFromPiModel(false, {
      xhigh: 'xhigh',
    })).toEqual(['off']);
  });

  it('maps known Copilot effort labels and ignores unknown labels', () => {
    expect(mapReportedReasoningEfforts(['minimal', 'medium', 'future-effort', 'xhigh'])).toEqual([
      'minimal', 'medium', 'xhigh',
    ]);
    expect(mapReportedReasoningEfforts([])).toEqual([]);
    expect(mapReportedReasoningEfforts(undefined)).toBeUndefined();
    expect(mapReportedReasoningEfforts([1, null] as any)).toEqual([]);
    expect(mapReportedReasoningEfforts('malformed' as any)).toBeUndefined();
  });

  it('includes GPT-5.6 models for OpenAI API and Codex catalogs', () => {
    const expected = ['pi/gpt-5.6-sol', 'pi/gpt-5.6-terra', 'pi/gpt-5.6-luna'];

    for (const provider of ['openai', 'openai-codex']) {
      const models = getPiModelsForAuthProvider(provider);
      const ids = models.map(m => m.id);
      expect(ids).toEqual(expect.arrayContaining(expected));
      const gpt = models.find(m => m.id === 'pi/gpt-5.6-sol');
      expect(gpt?.supportedThinkingLevels).toEqual(provider === 'openai'
        ? ['minimal', 'low', 'medium', 'high', 'xhigh']
        : ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
    }
  });
});
