import { describe, expect, it } from 'bun:test'
import {
  defaultSessionOptions,
  preserveSessionOptionsOnDefaultChange,
  type SessionOptions,
} from '../useSessionOptions'

describe('preserveSessionOptionsOnDefaultChange', () => {
  it('preserves existing session values while leaving new-session fallback to the new default', () => {
    const current = new Map<string, SessionOptions>([
      ['explicit', { permissionMode: 'ask', thinkingLevel: 'high' }],
    ])
    const result = preserveSessionOptionsOnDefaultChange(current, [
      { id: 'explicit', thinkingLevel: 'high' },
      { id: 'persisted', thinkingLevel: 'medium' },
      { id: 'implicit', thinkingLevel: undefined },
    ], 'medium')

    expect(result.get('explicit')?.thinkingLevel).toBe('high')
    expect(result.get('persisted')?.thinkingLevel).toBe('medium')
    expect(result.get('implicit')?.thinkingLevel).toBe('medium')
    expect(result.get('new')).toBeUndefined()
    expect(defaultSessionOptions.thinkingLevel).toBe('medium')
  })
})
