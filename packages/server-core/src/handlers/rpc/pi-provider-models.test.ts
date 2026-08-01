import { describe, expect, it } from 'bun:test'
import { toPiProviderModelInfo } from './pi-provider-models.ts'

describe('toPiProviderModelInfo', () => {
  it('preserves provider-converted capability metadata for OpenAI/Codex DTOs', () => {
    const openai = toPiProviderModelInfo({
      id: 'gpt-5.6-sol',
      name: 'GPT-5.6 Sol',
      costInput: 5,
      costOutput: 30,
      contextWindow: 1_050_000,
      reasoning: true,
      thinkingLevelMap: { off: null, xhigh: 'xhigh' },
    })
    const codex = toPiProviderModelInfo({
      id: 'gpt-5.6-sol',
      name: 'GPT-5.6 Sol',
      costInput: 5,
      costOutput: 30,
      contextWindow: 1_050_000,
      reasoning: true,
      thinkingLevelMap: { minimal: 'low', xhigh: 'xhigh' },
    })

    expect(openai.id).toBe('pi/gpt-5.6-sol')
    expect(openai.supportedThinkingLevels).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh'])
    expect(codex.supportedThinkingLevels).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh'])
  })

  it('uses live conversion metadata when a provider discovery path supplies it', () => {
    const result = toPiProviderModelInfo({
      id: 'gpt-5-copilot',
      name: 'GPT-5 Copilot',
      costInput: 0,
      costOutput: 0,
      contextWindow: 200_000,
      reasoning: true,
    }, {
      supportedThinkingLevels: ['minimal', 'high'],
    })

    expect(result.supportedThinkingLevels).toEqual(['minimal', 'high'])
  })

  it('retains off as the Pi capability for non-reasoning models', () => {
    expect(toPiProviderModelInfo({
      id: 'text-model',
      name: 'Text model',
      costInput: 0,
      costOutput: 0,
      contextWindow: 32_000,
      reasoning: false,
    }).supportedThinkingLevels).toEqual(['off'])
  })
})
