import { describe, expect, it } from 'bun:test'
import openaiIcon from '@/assets/provider-icons/openai.svg'
import openaiWhiteIcon from '@/assets/provider-icons/openai-white.svg'
import { getOpenAiIcon, getProviderIconForTheme, providerIcons } from '../provider-icons'

describe('OpenAI provider icon theme variants', () => {
  it('uses a white OpenAI mark in dark themes so ChatGPT connections remain visible', () => {
    expect(getOpenAiIcon(true)).toBe(openaiWhiteIcon)
    expect(getProviderIconForTheme(providerIcons.openai, true)).toBe(openaiWhiteIcon)
  })

  it('uses the black OpenAI mark in light themes', () => {
    expect(getOpenAiIcon(false)).toBe(openaiIcon)
    expect(getProviderIconForTheme(providerIcons.openai, false)).toBe(openaiIcon)
  })

  it('leaves other provider icons and missing icons unchanged', () => {
    expect(getProviderIconForTheme(providerIcons.anthropic, true)).toBe(providerIcons.anthropic)
    expect(getProviderIconForTheme(null, true)).toBeNull()
  })
})
