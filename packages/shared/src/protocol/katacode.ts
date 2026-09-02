import type {
  KatacodeInvalidatedEvent,
  KatacodeTaskCardView,
  KatacodeTaskRailView,
} from '@kata-sh/core'

export type { KatacodeInvalidatedEvent, KatacodeTaskCardView, KatacodeTaskRailView }

export interface GetKatacodeRailInput {
  readonly conversationId: string
  readonly taskId: string
}

export interface WaitForKatacodeInput {
  readonly waitId: string
  readonly conversationId: string
  readonly taskId: string
  readonly after?: KatacodeTaskRailView['freshness']
  readonly timeoutMs?: number
}

export interface CancelKatacodeWaitInput {
  readonly waitId: string
}

export interface CancelKatacodeInput {
  readonly conversationId: string
  readonly taskId: string
  readonly reason: string
}

export interface RetryKatacodeInput {
  readonly conversationId: string
  readonly taskId: string
}

export interface ReconcileKatacodeInput {
  readonly conversationId: string
  readonly taskId: string
}

export interface MarkKatacodeResultReadInput {
  readonly conversationId: string
  readonly taskId: string
  readonly expectedTaskVersion: number
}
