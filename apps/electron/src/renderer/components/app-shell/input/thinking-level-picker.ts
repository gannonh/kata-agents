import { modelIdsMatch, type ModelDefinition } from '@config/models'
import {
  getThinkingLevelDefinitionsForModel,
  normalizeThinkingLevelForModel,
  type ThinkingLevel,
  type ThinkingLevelDefinition,
} from '@kata-sh/shared/agent/thinking-levels'

export interface ThinkingLevelPickerState {
  levels: readonly ThinkingLevelDefinition[]
  displayedLevel: ThinkingLevel
  disabled: boolean
}

/** Find the capability-bearing definition for the currently selected model. */
export function findSelectedModel(
  models: readonly (ModelDefinition | string)[],
  currentModel: string,
): ModelDefinition | undefined {
  const selected = models.find(
    model => typeof model !== 'string' && modelIdsMatch(model.id, currentModel),
  )
  return selected && typeof selected !== 'string' ? selected : undefined
}

/** Resolve one consistent reasoning-control state for the desktop and compact pickers. */
export function resolveThinkingLevelPickerState(
  thinkingLevel: ThinkingLevel,
  model?: ModelDefinition,
  unavailable = false,
): ThinkingLevelPickerState {
  const levels = unavailable ? [] : getThinkingLevelDefinitionsForModel(model)
  return {
    levels,
    displayedLevel: normalizeThinkingLevelForModel(thinkingLevel, model) ?? thinkingLevel,
    disabled: levels.length === 0,
  }
}
