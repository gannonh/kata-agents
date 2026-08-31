/** Durable Bot-owned routine contracts. Provider session identities are intentionally absent. */

export const ROUTINE_SCHEMA_VERSION = 1 as const

export type RoutineId = string & { readonly __routineId: unique symbol }
export type RoutineRunId = string & { readonly __routineRunId: unique symbol }
export type TriggerOccurrenceId = string & { readonly __triggerOccurrenceId: unique symbol }

export type RoutineLifecycle = 'enabled' | 'paused' | 'deleted'
export type RoutineApprovalBoundary = 'safe' | 'ask' | 'allow-all'
export type RoutineFailurePolicy = 'stop' | 'retry' | 'uncertain'

export interface RoutineEventMatcher {
  readonly field: string
  readonly equals?: string
  readonly matches?: string
}

export type RoutineTrigger =
  | {
      readonly kind: 'schedule'
      readonly cron: string
      readonly timezone: string
      readonly dst: { readonly gap: 'skip'; readonly fold: 'once' }
    }
  | {
      readonly kind: 'event'
      readonly source: string
      readonly matcher: RoutineEventMatcher
    }
  | { readonly kind: 'on-demand' }

export type RoutineDestination =
  | { readonly kind: 'direct'; readonly chatId: string }
  | { readonly kind: 'channel'; readonly channelId: string }

export interface RoutineRecord {
  readonly schemaVersion: typeof ROUTINE_SCHEMA_VERSION
  readonly routineId: RoutineId
  readonly workspaceId: string
  readonly ownerBotId: string
  readonly name: string
  readonly lifecycle: RoutineLifecycle
  readonly activeRevision: number
  readonly createdAt: string
  readonly updatedAt: string
}

export interface RoutineRevision {
  readonly schemaVersion: typeof ROUTINE_SCHEMA_VERSION
  readonly routineId: RoutineId
  readonly revision: number
  readonly trigger: RoutineTrigger
  readonly input: string
  readonly expectedResult: string
  readonly approvalBoundary: RoutineApprovalBoundary
  readonly failurePolicy: RoutineFailurePolicy
  readonly destination: RoutineDestination
  readonly createdAt: string
}

export interface RoutineOccurrence {
  readonly schemaVersion: typeof ROUTINE_SCHEMA_VERSION
  readonly occurrenceId: TriggerOccurrenceId
  readonly routineId: RoutineId
  readonly routineRevision: number
  readonly source: string
  readonly scheduledInstant?: string
  readonly externalEventId?: string
  readonly createdAt: string
  readonly claimedAt?: string
  readonly leaseUntil?: string
  /** Internal claim fields; never included in RoutineRunPublicDto. */
  readonly workerId?: string
  readonly claimToken?: string
}

export type RoutineRunState =
  | { readonly kind: 'queued'; readonly at: string }
  | { readonly kind: 'claimed'; readonly at: string; readonly workerId: string; readonly leaseUntil: string }
  | { readonly kind: 'running'; readonly at: string }
  | { readonly kind: 'awaiting-approval'; readonly at: string; readonly approvalId: string; readonly operationHash: string; readonly version: number }
  | { readonly kind: 'succeeded'; readonly at: string; readonly result: string }
  | { readonly kind: 'failed'; readonly at: string; readonly error: string }
  | { readonly kind: 'cancelled'; readonly at: string; readonly reason: string }
  | { readonly kind: 'uncertain'; readonly at: string; readonly reason: string }
  | { readonly kind: 'reconciled'; readonly at: string; readonly result: string }

export type RoutineRunOrigin =
  | { readonly kind: 'triggered'; readonly occurrenceId: TriggerOccurrenceId }
  | { readonly kind: 'replay'; readonly occurrenceId: TriggerOccurrenceId; readonly replayOfRunId: RoutineRunId }

export interface RoutineRun {
  readonly schemaVersion: typeof ROUTINE_SCHEMA_VERSION
  readonly runId: RoutineRunId
  readonly routineId: RoutineId
  readonly routineRevision: number
  readonly ownerBotId: string
  readonly origin: RoutineRunOrigin
  readonly destination: RoutineDestination
  readonly input: string
  readonly state: RoutineRunState
  readonly attempt: number
  readonly version: number
  readonly createdAt: string
  readonly updatedAt: string
}

/** Safe renderer/RPC projection. Claim leases, worker IDs, and tokens are excluded. */
export interface RoutinePublicDto {
  readonly routineId: RoutineId
  readonly workspaceId: string
  readonly ownerBotId: string
  readonly name: string
  readonly lifecycle: RoutineLifecycle
  readonly activeRevision: number
  readonly revision: RoutineRevision
  readonly nextRunAt?: string
  readonly createdAt: string
  readonly updatedAt: string
}

export type RoutinePublicRunState =
  | { readonly kind: 'queued'; readonly at: string }
  | { readonly kind: 'claimed'; readonly at: string }
  | { readonly kind: 'running'; readonly at: string }
  | { readonly kind: 'awaiting-approval'; readonly at: string; readonly approvalId: string }
  | { readonly kind: 'succeeded'; readonly at: string; readonly result: string }
  | { readonly kind: 'failed'; readonly at: string; readonly error: string }
  | { readonly kind: 'cancelled'; readonly at: string; readonly reason: string }
  | { readonly kind: 'uncertain'; readonly at: string; readonly reason: string }
  | { readonly kind: 'reconciled'; readonly at: string; readonly result: string }

export interface RoutineRunPublicDto {
  readonly runId: RoutineRunId
  readonly routineId: RoutineId
  readonly routineRevision: number
  readonly ownerBotId: string
  readonly origin: RoutineRunOrigin
  readonly destination: RoutineDestination
  readonly state: RoutinePublicRunState
  readonly attempt: number
  readonly version: number
  readonly createdAt: string
  readonly updatedAt: string
}
