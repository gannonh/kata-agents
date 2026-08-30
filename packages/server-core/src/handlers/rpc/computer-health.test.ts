import { describe, expect, it } from 'bun:test'
import { getHealthCheck } from './server.ts'

describe('getHealthCheck computer dimensions', () => {
  it('reports degraded when only the browser dimension failed', () => {
    const health = getHealthCheck({
      sessionManager: { getWorkspaces: () => [] },
      computer: {
        snapshotReadiness: () => ({
          process: { tag: 'ready' as const },
          storage: { tag: 'ready' as const },
          browser: { tag: 'failed' as const, reason: 'chromium down' },
          checkedAt: '2026-08-30T00:00:00.000Z',
        }),
        healthStatus: () => 'degraded' as const,
      },
    } as never)

    expect(health.status).toBe('degraded')
    expect(health.checks.find((check) => check.name === 'computer_process')?.status).toBe('pass')
    expect(health.checks.find((check) => check.name === 'computer_storage')?.status).toBe('pass')
    expect(health.checks.find((check) => check.name === 'computer_browser')?.status).toBe('fail')
  })

  it('reports unhealthy when storage failed', () => {
    const health = getHealthCheck({
      sessionManager: { getWorkspaces: () => [] },
      computer: {
        snapshotReadiness: () => ({
          process: { tag: 'ready' as const },
          storage: { tag: 'failed' as const, reason: 'corrupt' },
          browser: { tag: 'ready' as const },
          checkedAt: '2026-08-30T00:00:00.000Z',
        }),
        healthStatus: () => 'unhealthy' as const,
      },
    } as never)

    expect(health.status).toBe('unhealthy')
  })
})
