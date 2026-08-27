import { describe, expect, it } from 'bun:test'
import { parseCompoundRoute } from '../route-parser'

describe('route-parser: channels routes', () => {
  it('parses channels and channels/channel/{channelId}', () => {
    expect(parseCompoundRoute('channels')).toEqual({
      navigator: 'channels',
      details: null,
    })
    expect(parseCompoundRoute('channels/channel/channel-1')).toEqual({
      navigator: 'channels',
      details: { type: 'channel', id: 'channel-1' },
    })
  })

  it('rejects trailing segments after channels/channel/{channelId}', () => {
    expect(parseCompoundRoute('channels/channel/channel-1/extra')).toBeNull()
    expect(parseCompoundRoute('channels/channel/channel-1/foo/bar')).toBeNull()
  })

  it('rejects malformed channel routes', () => {
    expect(parseCompoundRoute('channels/channel')).toBeNull()
    expect(parseCompoundRoute('channels/other/channel-1')).toBeNull()
  })
})
