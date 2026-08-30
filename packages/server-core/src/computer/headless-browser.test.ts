import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseComputerConfig,
  DEFAULT_BROWSER_PROFILE_ID,
  brandSessionId,
} from '@kata-sh/shared/computer'
import { Computer } from './computer.ts'
import { ProfileBusyError } from './errors.ts'

const chrome = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  .find((path) => existsSync(path))

const roots: string[] = []
const computers: Computer[] = []

afterEach(async () => {
  for (const computer of computers.splice(0)) {
    try {
      await computer.shutdown({ reason: 'operator', timeoutMs: 5_000 })
    } catch {
      // already closed
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('HeadlessBrowserPaneManager', () => {
  it('navigates a fixture site, hands off the default profile, and keeps cookies after restart', async () => {
    if (!chrome) {
      throw new Error('No Chromium executable on this host. Install google-chrome or set KATA_CHROMIUM_PATH.')
    }

    const root = mkdtempSync(join(tmpdir(), 'kata-computer-browser-'))
    roots.push(root)

    const fixture = Bun.serve({
      port: 0,
      fetch() {
        return new Response('<html><body><h1>fixture-ok</h1></body></html>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      },
    })
    const fixtureUrl = `http://127.0.0.1:${fixture.port}/`

    const config = parseComputerConfig({
      KATA_DATA_ROOT: root,
      KATA_SERVER_TOKEN: 'token-with-enough-entropy-0123456789',
      KATA_COMPUTER_KIND: 'self-hosted-headless',
      KATA_RPC_HOST: '127.0.0.1',
      KATA_CHROMIUM_PATH: chrome,
    }, { packaged: false })

    const first = await Computer.open(config)
    computers.push(first)
    expect(first.snapshotReadiness().browser.tag).toBe('ready')

    const bpmA = first.browserPaneManagerForSession('bot-a')
    const instanceA = await bpmA.createForSessionAsync('bot-a')
    const result = await bpmA.navigate(instanceA, fixtureUrl)
    expect(result.title.toLowerCase()).toContain('fixture-ok')
    const shot = await bpmA.screenshot(instanceA)
    expect(shot.imageBuffer.byteLength).toBeGreaterThan(100)
    await bpmA.evaluate(instanceA, 'document.cookie = "kata=shared; path=/"')
    expect(String(await bpmA.evaluate(instanceA, 'document.cookie'))).toContain('kata=shared')

    try {
      await first.browserPaneManagerForSession('bot-b').createForSessionAsync('bot-b')
      throw new Error('expected ProfileBusyError')
    } catch (error) {
      expect(error).toBeInstanceOf(ProfileBusyError)
    }

    await first.handoffProfile({
      profileId: DEFAULT_BROWSER_PROFILE_ID,
      fromSessionId: brandSessionId('bot-a'),
      toSessionId: brandSessionId('bot-b'),
      mode: 'lease-transfer',
    })

    const bpmB = first.browserPaneManagerForSession('bot-b')
    const instanceB = await bpmB.createForSessionAsync('bot-b')
    await bpmB.navigate(instanceB, fixtureUrl)
    expect(String(await bpmB.evaluate(instanceB, 'document.cookie'))).toContain('kata=shared')

    await first.shutdown({ reason: 'drain', timeoutMs: 5_000 })
    computers.splice(computers.indexOf(first), 1)

    const second = await Computer.open(config)
    computers.push(second)
    const bpmRestart = second.browserPaneManagerForSession('bot-b')
    const instanceRestart = await bpmRestart.createForSessionAsync('bot-b')
    await bpmRestart.navigate(instanceRestart, fixtureUrl)
    expect(String(await bpmRestart.evaluate(instanceRestart, 'document.cookie'))).toContain('kata=shared')

    fixture.stop()
  }, 60_000)
})
