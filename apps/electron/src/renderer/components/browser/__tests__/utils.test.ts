import { describe, expect, it } from 'bun:test'
import { browserDisplayLabel, getHostname } from '../utils'

describe('getHostname', () => {
  it('returns stripped hostname for https URLs', () => {
    expect(getHostname('https://www.example.com/path?q=1')).toBe('example.com')
  })

  it('returns an empty string for about:blank', () => {
    expect(getHostname('about:blank')).toBe('')
  })

  it('returns filename for file URLs', () => {
    expect(getHostname('file:///Users/tester/report.html')).toBe('report.html')
  })

  it('returns Local File for file URLs without basename', () => {
    expect(getHostname('file:///Users/tester/folder/')).toBe('Local File')
  })

  it('returns protocol token for custom schemes with empty hostname', () => {
    expect(getHostname('data:text/html,hello')).toBe('data')
  })

  it('falls back to original input for malformed URLs', () => {
    expect(getHostname('not a url')).toBe('not a url')
  })
})

describe('browserDisplayLabel', () => {
  it('uses the blank label for placeholder titles on about:blank', () => {
    expect(browserDisplayLabel({ title: 'New Tab', url: 'about:blank' }, 'Browser')).toBe('Browser')
    expect(browserDisplayLabel({ title: 'Browser', url: 'about:blank' }, 'Browser')).toBe('Browser')
  })

  it('prefers a real page title', () => {
    expect(browserDisplayLabel({ title: 'Example', url: 'https://example.com' }, 'Browser')).toBe('Example')
  })

  it('falls back to hostname when the title is a placeholder', () => {
    expect(browserDisplayLabel({ title: 'New Tab', url: 'https://www.example.com' }, 'Browser')).toBe('example.com')
  })
})
