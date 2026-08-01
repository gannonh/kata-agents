import {
  deriveSupportedThinkingLevelsFromPiModel,
  type ModelDefinition,
} from '@kata-sh/shared/config'
import type { ThinkingLevel } from '@kata-sh/shared/agent/thinking-levels'

export interface PiProviderModelRecord {
  id: string
  name: string
  costInput: number
  costOutput: number
  contextWindow: number
  reasoning: boolean
  thinkingLevelMap?: Record<string, string | null | undefined>
}

export interface PiProviderModelInfo {
  id: string
  name: string
  costInput: number
  costOutput: number
  contextWindow: number
  reasoning: boolean
  supportedThinkingLevels: ThinkingLevel[]
}

/** Convert a Pi discovery record to the renderer-facing provider-model DTO. */
export function toPiProviderModelInfo(
  model: PiProviderModelRecord,
  definition?: Pick<ModelDefinition, 'supportedThinkingLevels'>,
): PiProviderModelInfo {
  return {
    id: model.id.startsWith('pi/') ? model.id : `pi/${model.id}`,
    name: model.name,
    costInput: model.costInput,
    costOutput: model.costOutput,
    contextWindow: model.contextWindow,
    reasoning: model.reasoning,
    supportedThinkingLevels: definition?.supportedThinkingLevels
      ?? deriveSupportedThinkingLevelsFromPiModel(model.reasoning, model.thinkingLevelMap),
  }
}
