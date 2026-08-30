import type { ComputerReadiness } from './types.ts'

export function aggregateHealth(readiness: ComputerReadiness): 'ok' | 'degraded' | 'unhealthy' {
  if (readiness.process.tag === 'failed' || readiness.storage.tag === 'failed') return 'unhealthy'
  if (
    readiness.process.tag !== 'ready'
    || readiness.storage.tag !== 'ready'
    || readiness.browser.tag !== 'ready'
  ) {
    return 'degraded'
  }
  return 'ok'
}
