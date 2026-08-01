import { describe, expect, it } from 'bun:test'
import {
  THINKING_LEVEL_IDS,
  THINKING_TO_EFFORT,
  getThinkingLevelDefinitionsForModel,
  normalizeThinkingLevelForModel,
} from '../thinking-levels.ts'

describe('thinking level capabilities', () => {
  it('includes minimal in the shared vocabulary and maps it to low Anthropic effort', () => {
    expect(THINKING_LEVEL_IDS).toContain('minimal')
    expect(THINKING_TO_EFFORT.minimal).toBe('low')
  })

  it('uses the compatibility list when model capabilities are absent', () => {
    expect(getThinkingLevelDefinitionsForModel()).toHaveLength(THINKING_LEVEL_IDS.length)
  })

  it('honors an explicit empty capability list', () => {
    expect(getThinkingLevelDefinitionsForModel({ supportedThinkingLevels: [] })).toEqual([])
    expect(normalizeThinkingLevelForModel('medium', { supportedThinkingLevels: [] })).toBeUndefined()
  })

  it('falls back safely when renderer capability data is malformed', () => {
    const model = { provider: 'pi' as const, supportedThinkingLevels: 'invalid' as any }
    expect(getThinkingLevelDefinitionsForModel(model).map(level => level.id)).toContain('minimal')
    expect(normalizeThinkingLevelForModel('max', model)).toBe('max')
  })

  it('normalizes using Pi ordering and prefers higher levels on ties', () => {
    const model = {
      provider: 'pi' as const,
      supportsThinking: true,
      supportedThinkingLevels: ['low', 'high'] as const,
    }

    expect(normalizeThinkingLevelForModel('medium', model)).toBe('high')
    expect(normalizeThinkingLevelForModel('off', model)).toBe('low')
    expect(normalizeThinkingLevelForModel('medium', {
      provider: 'pi',
      supportsThinking: true,
      supportedThinkingLevels: ['low', 'xhigh'],
    })).toBe('low')
  })

  it('aliases max to native xhigh for Pi capability lists', () => {
    const model = {
      provider: 'pi' as const,
      supportsThinking: true,
      supportedThinkingLevels: ['minimal', 'low', 'medium', 'high', 'xhigh'] as const,
    }

    expect(getThinkingLevelDefinitionsForModel(model).map(level => level.id)).toEqual([
      'minimal', 'low', 'medium', 'high', 'xhigh',
    ])
    expect(normalizeThinkingLevelForModel('max', model)).toBe('xhigh')
  })
})
