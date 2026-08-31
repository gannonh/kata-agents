import { Cron } from 'croner'
import type { RoutineTrigger } from '@kata-sh/core'

function parseAfter(after: string): Date {
  const date = new Date(after)
  if (!Number.isFinite(date.getTime())) throw new TypeError('after must be an ISO timestamp')
  return date
}

function cronFor(trigger: Extract<RoutineTrigger, { kind: 'schedule' }>): Cron {
  if (trigger.dst.gap !== 'skip' || trigger.dst.fold !== 'once') throw new TypeError('Unsupported DST policy')
  return new Cron(trigger.cron, { timezone: trigger.timezone })
}

/** Return the next real UTC instant after `after`; Croner skips gaps and emits one fold instant. */
export function nextScheduledInstant(
  trigger: Extract<RoutineTrigger, { kind: 'schedule' }>,
  after: string,
): string | null {
  const next = cronFor(trigger).nextRun(parseAfter(after))
  return next?.toISOString() ?? null
}

/** Return the latest real UTC instant at or before `to`. */
export function latestScheduledInstant(
  trigger: Extract<RoutineTrigger, { kind: 'schedule' }>,
  to: string,
): string | null {
  const end = parseAfter(to)
  const previous = cronFor(trigger).previousRuns(1, new Date(end.getTime() + 1_000))[0]
  return previous?.toISOString() ?? null
}

/** Return all real UTC instants strictly after `from` and at or before `to`. */
export function scheduledInstantsBetween(
  trigger: Extract<RoutineTrigger, { kind: 'schedule' }>,
  from: string,
  to: string,
): string[] {
  const start = parseAfter(from)
  const end = parseAfter(to)
  if (end.getTime() <= start.getTime()) return []
  const cron = cronFor(trigger)
  const instants: string[] = []
  let after = start
  // ponytail: cap catch-up at 10,000 instants; batch older downtime across ticks.
  for (let count = 0; count < 10_000; count += 1) {
    const next = cron.nextRun(after)
    if (!next || next.getTime() > end.getTime()) break
    instants.push(next.toISOString())
    after = next
  }
  return instants
}
