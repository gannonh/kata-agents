import { describe, expect, it } from 'bun:test'
import type { ModelDefinition } from '@config/models'
import { findSelectedModel, resolveThinkingLevelPickerState } from '../thinking-level-picker'

function model(overrides: Partial<ModelDefinition> = {}): ModelDefinition {
  return {
    id: 'pi/test-model',
    name: 'Test model',
    shortName: 'Test',
    description: '',
    provider: 'pi',
    contextWindow: 128_000,
    ...overrides,
  }
}

describe('resolveThinkingLevelPickerState', () => {
  it('filters the picker to the selected model capabilities', () => {
    const state = resolveThinkingLevelPickerState('medium', model({
      supportedThinkingLevels: ['minimal', 'low', 'medium', 'high', 'xhigh'],
      supportsThinking: true,
    }))

    expect(state.levels.map(level => level.id)).toEqual([
      'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
    ])
    expect(state.displayedLevel).toBe('medium')
    expect(state.disabled).toBe(false)
  })

  it('retains max when Pi supports xhigh and disables explicit non-reasoning models', () => {
    const piState = resolveThinkingLevelPickerState('max', model({
      supportedThinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
      supportsThinking: true,
    }))
    const textState = resolveThinkingLevelPickerState('medium', model({
      supportedThinkingLevels: ['off'],
      supportsThinking: false,
    }))

    expect(piState.displayedLevel).toBe('max')
    expect(textState.levels).toEqual([])
    expect(textState.disabled).toBe(true)
  })

  it('resolves Pi metadata when the selected model ID omits the catalog prefix', () => {
    const selected = findSelectedModel([
      model({ id: 'pi/gpt-5.6-luna', supportedThinkingLevels: ['minimal', 'xhigh'] }),
    ], 'gpt-5.6-luna')

    expect(selected?.id).toBe('pi/gpt-5.6-luna')
  })

  it('keeps the compatibility list when a model has no capability metadata', () => {
    const state = resolveThinkingLevelPickerState('minimal', model())
    expect(state.levels.map(level => level.id)).toContain('minimal')
    expect(state.levels.map(level => level.id)).toContain('max')
  })
})
