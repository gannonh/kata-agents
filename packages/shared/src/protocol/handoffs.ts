import type {
  HandoffDeliveryRecord,
  HandoffTaskView,
} from '@kata-sh/core'

export type HandoffDeliveryView = Pick<
  HandoffDeliveryRecord,
  | 'deliveryId'
  | 'handoffId'
  | 'workspaceId'
  | 'conversationId'
  | 'sourceBotId'
  | 'targetBotId'
  | 'request'
  | 'mailState'
  | 'spawnTaskId'
  | 'claim'
  | 'failure'
  | 'resultUnread'
  | 'resultReadTaskVersion'
  | 'createdAt'
  | 'updatedAt'
  | 'version'
>

export interface HandoffExchangeEntry {
  readonly seq: number
  readonly entryId: string
  readonly phase: 'requested' | 'terminal'
  readonly authorBotId?: string
  readonly createdAt: string
}

export type HandoffAction = 'cancel' | 'read'

export interface HandoffRailView {
  readonly handoffId: string
  readonly conversationId: string
  readonly sourceBotName: string
  readonly targetBotName: string
  readonly delivery: HandoffDeliveryView
  readonly exchange: readonly HandoffExchangeEntry[]
  readonly task: HandoffTaskView | null
  readonly unread: boolean
  readonly freshness: {
    readonly deliveryVersion: number
    readonly taskVersion: number
    readonly journalSequence: number
  }
  readonly actions: readonly HandoffAction[]
}

export interface HandoffInvalidatedEvent {
  readonly workspaceId: string
  readonly conversationId: string
  readonly handoffId: string
  readonly deliveryVersion: number
  readonly taskVersion: number
  readonly journalSequence: number
}

export interface GetHandoffRailInput {
  readonly handoffId: string
  readonly conversationId: string
}

export interface WaitForHandoffInput {
  readonly waitId: string
  readonly handoffId: string
  readonly conversationId: string
  readonly after?: {
    readonly deliveryVersion?: number
    readonly taskVersion?: number
    readonly journalSequence?: number
  }
  readonly timeoutMs?: number
}

export interface CancelHandoffWaitInput {
  readonly waitId: string
}

export interface ReadHandoffResultChunkInput {
  readonly handoffId: string
  readonly conversationId: string
  readonly offset: number
  readonly limit: number
}

export interface CancelHandoffInput {
  readonly handoffId: string
  readonly conversationId: string
  readonly reason: string
}

export interface MarkHandoffResultReadInput {
  readonly handoffId: string
  readonly conversationId: string
  readonly expectedTaskVersion: number
}
