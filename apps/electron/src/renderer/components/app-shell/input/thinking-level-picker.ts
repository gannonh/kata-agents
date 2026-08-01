import type { ModelDefinition } from '@config/models'
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
