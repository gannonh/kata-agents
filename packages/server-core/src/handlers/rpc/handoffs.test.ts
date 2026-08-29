import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HandoffWaitRegistry } from './handoffs'

describe('HandoffWaitRegistry', () => {
  it('replaces only the matching client wait and preserves the successor', () => {
    const waits = new HandoffWaitRegistry()
    const first = waits.begin('client-a', 'wait-1')
    const otherClient = waits.begin('client-b', 'wait-1')
    const successor = waits.begin('client-a', 'wait-1')

    expect(first.signal.aborted).toBe(true)
    expect(successor.signal.aborted).toBe(false)
    expect(otherClient.signal.aborted).toBe(false)

    waits.finish('client-a', 'wait-1', first)
    expect(waits.cancelWait('client-a', 'wait-1')).toBe(true)
    expect(successor.signal.aborted).toBe(true)
    expect(otherClient.signal.aborted).toBe(false)
  })

  it('cancels every wait owned by a disconnected client', () => {
    const waits = new HandoffWaitRegistry()
    const first = waits.begin('client-a', 'wait-1')
    const second = waits.begin('client-a', 'wait-2')
    const otherClient = waits.begin('client-b', 'wait-1')

    waits.cancelClient('client-a')

    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(true)
    expect(otherClient.signal.aborted).toBe(false)
    expect(waits.cancelWait('client-a', 'wait-1')).toBe(false)
  })
})

describe('handoff RPC authority boundary', () => {
  it('uses the production workspace resolver for every durable handoff operation', () => {
    const root = mkdtempSync(join(tmpdir(), 'handoff-rpc-authority-'))
    try {
      const fixture = fileURLToPath(new URL('../../__tests__/fixtures/handoffs-authority.isolated.ts', import.meta.url))
      const result = Bun.spawnSync([process.execPath, fixture], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          KATA_CONFIG_DIR: join(root, 'config'),
          KATA_HANDOFF_TEST_WORKSPACE: join(root, 'workspace'),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const stderr = result.stderr.toString()
      expect(result.exitCode, stderr).toBe(0)
      expect(result.stdout.toString()).toContain('handoff authority verified')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
