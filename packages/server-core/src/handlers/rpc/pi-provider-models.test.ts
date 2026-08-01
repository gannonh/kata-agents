import { describe, expect, it } from 'bun:test'
import { toPiProviderModelInfo } from './pi-provider-models.ts'

describe('toPiProviderModelInfo', () => {
  it('preserves native Pi 0.83 GPT-5.6 Sol metadata for OpenAI/Codex DTOs', () => {
    const openai = toPiProviderModelInfo({
      id: 'gpt-5.6-sol',
      name: 'GPT-5.6 Sol',
      costInput: 5,
      costOutput: 30,
      contextWindow: 272_000,
      reasoning: true,
      thinkingLevelMap: {
        off: 'none',
        minimal: null,
        low: 'low',
        medium: 'medium',
        high: 'high',
        xhigh: 'xhigh',
        max: 'max',
      },
    })
    const codex = toPiProviderModelInfo({
      id: 'gpt-5.6-sol',
      name: 'GPT-5.6 Sol',
      costInput: 5,
      costOutput: 30,
      contextWindow: 272_000,
      reasoning: true,
      thinkingLevelMap: { minimal: 'low', xhigh: 'xhigh', max: 'max' },
    })

    expect(openai).toMatchObject({
      id: 'pi/gpt-5.6-sol',
      contextWindow: 272_000,
      supportedThinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
    })
    expect(codex).toMatchObject({
      id: 'pi/gpt-5.6-sol',
      contextWindow: 272_000,
      supportedThinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    })
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
