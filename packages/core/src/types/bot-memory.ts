export const BOT_MEMORY_SCHEMA_VERSION = 1 as const

export const BOT_MEMORY_STATES = ['active', 'edited', 'forgotten'] as const
export type BotMemoryState = (typeof BOT_MEMORY_STATES)[number]

export const BOT_MEMORY_MUTATION_KINDS = ['edit', 'forget', 'restore'] as const
export type BotMemoryMutationKind = (typeof BOT_MEMORY_MUTATION_KINDS)[number]

export const BOT_MEMORY_LIMITS = Object.freeze({
  itemBytes: 2_048,
  activeItems: 64,
  provenanceEntries: 8,
  recentEntries: 12,
  contextBytes: 16_384,
  checkpointSummaryBytes: 4_096,
  journalSourceBytes: 4_096,
})

export interface BotMemoryProvenance {
  readonly conversationId: string
  readonly entryId: string
  readonly seq: number
  readonly sourceHash: string
  readonly extractedAt: string
  readonly operationId: string
}

export interface BotMemoryRecord {
  readonly memoryId: string
  readonly workspaceId: string
  readonly botId: string
  readonly content: string
  readonly state: BotMemoryState
  readonly createdAt: string
  readonly updatedAt: string
  readonly revision: number
  readonly provenance: readonly BotMemoryProvenance[]
}

export interface BotMemoryExclusion {
  readonly candidateId: string
  readonly sourceEntryId: string
  readonly workspaceId: string
  readonly botId: string
  readonly forgottenAt: string
  readonly revision: number
}

export interface BotMemoryHead {
  readonly schemaVersion: typeof BOT_MEMORY_SCHEMA_VERSION
  readonly workspaceId: string
  readonly botId: string
  readonly revision: number
  readonly memories: readonly BotMemoryRecord[]
  readonly exclusions: readonly BotMemoryExclusion[]
  readonly operationIds: Readonly<Record<string, number>>
}

export type BotMemoryMutation =
  | {
      readonly kind: 'edit'
      readonly memoryId: string
      readonly content: string
      readonly expectedRevision: number
      readonly idempotencyKey: string
    }
  | {
      readonly kind: 'forget' | 'restore'
      readonly memoryId: string
      readonly expectedRevision: number
      readonly idempotencyKey: string
    }

export interface BotMemoryCandidate {
  readonly candidateId: string
  readonly workspaceId: string
  readonly botId: string
  readonly content: string
  readonly provenance: BotMemoryProvenance
}

export interface BotCompactionCheckpoint {
  readonly schemaVersion: typeof BOT_MEMORY_SCHEMA_VERSION
  readonly workspaceId: string
  readonly botId: string
  readonly conversationId: string
  readonly coveredFromSeq: number
  readonly coveredThroughSeq: number
  readonly journalHeadSequence: number
  readonly sourceDigest: string
  readonly memoryRevision: number
  readonly checkpointRevision: number
  readonly operationId: string
  readonly summary: string
  readonly createdAt: string
}

export interface BotContextCursor {
  readonly workspaceId: string
  readonly botId: string
  readonly conversationId: string
  readonly lastProcessedSeq: number
  readonly updatedAt: string
}

export interface BotContextRun {
  readonly runId: string
  readonly operationId: string
  readonly workspaceId: string
  readonly botId: string
  readonly conversationId: string
  readonly journalCursor: number
  readonly conversationCursor: number
  readonly memoryRevision: number
  readonly checkpointRevision: number
  readonly createdAt: string
}

export interface BotTurnContext {
  readonly runId: string
  readonly operationId: string
  readonly workspaceId: string
  readonly botId: string
  readonly conversationId: string
  readonly journalCursor: number
  readonly conversationCursor: number
  readonly memoryRevision: number
  readonly checkpointRevision: number
  readonly text: string
  readonly memoryIds: readonly string[]
}

export interface BotContextSnapshot {
  readonly head: BotMemoryHead
  readonly checkpoint: BotCompactionCheckpoint | null
  readonly context: BotTurnContext
}
