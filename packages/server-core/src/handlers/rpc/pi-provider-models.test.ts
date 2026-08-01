import { describe, expect, it } from 'bun:test'
import { getModels } from '@earendil-works/pi-ai/compat'
import { toPiProviderModelInfo } from './pi-provider-models.ts'

function getNativeGpt56Sol(provider: 'openai' | 'openai-codex') {
  const model = getModels(provider).find(candidate => candidate.id === 'gpt-5.6-sol')
  if (!model) throw new Error(`Pi catalog is missing GPT-5.6 Sol for ${provider}`)
  return {
    id: model.id,
    name: model.name,
    costInput: model.cost.input,
    costOutput: model.cost.output,
    contextWindow: model.contextWindow,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
  }
}

describe('toPiProviderModelInfo', () => {
  it('converts native Pi catalog records into provider-specific GPT-5.6 Sol DTOs', () => {
    const openaiModel = getNativeGpt56Sol('openai')
    const codexModel = getNativeGpt56Sol('openai-codex')
    const openai = toPiProviderModelInfo(openaiModel)
    const codex = toPiProviderModelInfo(codexModel)

    expect(openai).toMatchObject({
      id: 'pi/gpt-5.6-sol',
      contextWindow: openaiModel.contextWindow,
      supportedThinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
    })
    expect(codex).toMatchObject({
      id: 'pi/gpt-5.6-sol',
      contextWindow: codexModel.contextWindow,
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
