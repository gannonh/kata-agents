import type {
  SpawnTask,
  SpawnTaskFailure,
  SpawnTaskFailureCode,
  SpawnTaskJsonValue,
} from '@kata-sh/core'
import type { SpawnSessionResult } from '@kata-sh/shared/agent'
import {
  createSpawnTaskFailure,
  isSpawnTaskTerminal,
  type SpawnTaskStartupReport,
  type SpawnTaskStore,
} from '@kata-sh/shared/spawn-tasks'
import type { FileAttachment } from '@kata-sh/shared/utils/files'

export interface SpawnTaskCreateChildInput {
  readonly task: SpawnTask
}

export interface SpawnTaskAppendPromptInput {
  readonly task: SpawnTask
  readonly prompt: string
  readonly attachments?: readonly FileAttachment[]
}

export interface SpawnTaskDispatchInput {
  readonly task: SpawnTask
  readonly prompt: string
  readonly attachments?: readonly FileAttachment[]
}

export interface SpawnTaskUpdated {
  readonly taskId: string
  readonly version: number
}

export type SpawnTaskUpdatedHandler = (change: SpawnTaskUpdated) => void | Promise<void>

export interface SpawnTaskCoordinatorOptions {
  readonly store: SpawnTaskStore
  readonly createChild: (input: SpawnTaskCreateChildInput) => Promise<void>
  readonly appendDelegatedPrompt: (input: SpawnTaskAppendPromptInput) => Promise<void>
  readonly dispatchProvider: (input: SpawnTaskDispatchInput) => void | Promise<void>
  readonly onTaskUpdated?: SpawnTaskUpdatedHandler
  readonly clock?: () => string
}

export interface SpawnTaskSpawnInput {
  readonly parentSessionId: string
  readonly delegatedPrompt: string
  readonly childConfig: Readonly<Record<string, SpawnTaskJsonValue>>
  readonly attachments?: readonly FileAttachment[]
}

/**
 * The public spawn callback reports failures as the same bounded task failure
 * shape used by the durable task store. A task snapshot is attached when an
 * intent was committed, so callers can retain recovery evidence even when a
 * later boundary failed.
 */
export class SpawnTaskCreationError extends Error {
  readonly failure: SpawnTaskFailure
  readonly task: SpawnTask | null

  constructor(failure: SpawnTaskFailure, task: SpawnTask | null) {
    super(failure.message)
    this.name = 'SpawnTaskCreationError'
    this.failure = failure
    this.task = task
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Owns reserved-child creation/dispatch and task-owned lifecycle finalization.
 * The SessionManager supplies child publication, transcript/event facts, and
 * the provider boundary; it does not own task persistence or terminal policy.
 */
export class SpawnTaskCoordinator {
  private readonly store: SpawnTaskStore
  private readonly createChild: SpawnTaskCoordinatorOptions['createChild']
  private readonly appendDelegatedPrompt: SpawnTaskCoordinatorOptions['appendDelegatedPrompt']
  private readonly dispatchProvider: SpawnTaskCoordinatorOptions['dispatchProvider']
  private readonly onTaskUpdated?: SpawnTaskUpdatedHandler
  private readonly clock: () => string
  private readonly notifiedUpdates = new Set<string>()
  private readonly startupNotification: Promise<void>

  constructor(options: SpawnTaskCoordinatorOptions) {
    this.store = options.store
    this.createChild = options.createChild
    this.appendDelegatedPrompt = options.appendDelegatedPrompt
    this.dispatchProvider = options.dispatchProvider
    this.onTaskUpdated = options.onTaskUpdated
    this.clock = options.clock ?? (() => new Date().toISOString())
    this.startupNotification = this.notifyStartupReport(this.store.getLastStartupReport())
  }

  async finalizeResultForChildSession(
    childSessionId: string,
    content: string,
    sourceMessageId?: string,
  ): Promise<SpawnTask | null> {
    await this.startupNotification
    const current = this.store.getByChildSessionId(childSessionId)
    if (!current || isSpawnTaskTerminal(current.runtimeState)) return current

    try {
      const finalized = this.store.commitResult(current.taskId, content, {
        committedAt: this.clock(),
        ...(sourceMessageId ? { sourceMessageId } : {}),
      })
      await this.notifyTaskUpdated(finalized)
      return finalized
    } catch (error) {
      return this.reconcileFinalizationFailure(current.taskId, current.version, error, 'result')
    }
  }

  async finalizeProviderFailureForChildSession(
    childSessionId: string,
    error: unknown,
  ): Promise<SpawnTask | null> {
    return this.finalizeFailureForChildSession(childSessionId, {
      code: 'provider_error',
      message: error,
      retryable: true,
    })
  }

  async finalizeToolFailureForChildSession(
    childSessionId: string,
    error: unknown,
    details?: unknown,
  ): Promise<SpawnTask | null> {
    return this.finalizeFailureForChildSession(childSessionId, {
      code: 'tool_error',
      message: error,
      retryable: false,
      details,
    })
  }

  async repairResultForChildSession(
    childSessionId: string,
    content: string,
  ): Promise<SpawnTask | null> {
    await this.startupNotification
    const current = this.store.getByChildSessionId(childSessionId)
    if (!current || current.runtimeState !== 'completed' || !current.integrityError) return current

    try {
      const repaired = this.store.repairResult(current.taskId, content, this.clock())
      await this.notifyTaskUpdated(repaired)
      return repaired
    } catch {
      await this.reconcileStore()
      return this.store.get(current.taskId)
    }
  }

  async waitForStartupNotification(): Promise<void> {
    await this.startupNotification
  }

  async reconcileStartup(): Promise<void> {
    await this.startupNotification
    await this.reconcileStore()
  }

  async spawn(input: SpawnTaskSpawnInput): Promise<SpawnSessionResult> {
    await this.startupNotification
    let task: SpawnTask
    try {
      task = this.store.reserve({
        parentSessionId: input.parentSessionId,
        delegatedPrompt: input.delegatedPrompt,
        childConfig: input.childConfig,
      })
    } catch (error) {
      throw new SpawnTaskCreationError(
        this.failure(error, 'intent'),
        null,
      )
    }

    try {
      await this.createChild({ task })
    } catch (error) {
      throw this.creationFailure(task, error, 'child')
    }

    try {
      task = this.store.updateDispatch(task.taskId, 'ready', this.clock())
    } catch (error) {
      throw this.creationFailure(task, error, 'ready')
    }

    try {
      task = this.store.updateDispatch(task.taskId, 'claimed', this.clock())
    } catch (error) {
      throw this.creationFailure(task, error, 'claim')
    }

    try {
      await this.appendDelegatedPrompt({
        task,
        prompt: input.delegatedPrompt,
        attachments: input.attachments,
      })
    } catch (error) {
      throw this.creationFailure(task, error, 'message_append')
    }

    try {
      task = this.store.updateDispatch(task.taskId, 'sent', this.clock())
    } catch (error) {
      throw this.creationFailure(task, error, 'sent')
    }

    try {
      // Persist processing before crossing the provider boundary. A provider
      // call can be in flight as soon as dispatchProvider returns, so the
      // returned version must describe that durable state.
      task = this.store.transition(task.taskId, {
        runtimeState: 'processing',
        at: this.clock(),
      })
    } catch (error) {
      throw this.creationFailure(task, error, 'processing')
    }

    try {
      // The provider turn remains fire-and-forget for spawn(). C2 consumes its
      // eventual rejection through the same durable lifecycle finalizer.
      const providerTurn = this.dispatchProvider({
        task,
        prompt: input.delegatedPrompt,
        attachments: input.attachments,
      })
      if (providerTurn) {
        void providerTurn.catch((error: unknown) => {
          void this.finalizeProviderFailureForChildSession(task.childSessionId, error).catch(() => {})
        })
      }
    } catch (error) {
      // A truly synchronous callback throw is an invocation/provider failure,
      // not a spawn-persistence failure. Async turn rejection is handled by
      // the same durable lifecycle finalizer above.
      throw this.creationFailure(task, error, 'provider', 'provider_error')
    }

    return {
      taskId: task.taskId,
      childSessionId: task.childSessionId,
      runtimeState: task.runtimeState,
      version: task.version,
    }
  }

  private async finalizeFailureForChildSession(
    childSessionId: string,
    input: {
      readonly code: 'provider_error' | 'tool_error'
      readonly message: unknown
      readonly retryable: boolean
      readonly details?: unknown
    },
  ): Promise<SpawnTask | null> {
    await this.startupNotification
    const current = this.store.getByChildSessionId(childSessionId)
    if (!current || isSpawnTaskTerminal(current.runtimeState)) return current
    if (current.runtimeState !== 'processing') return current

    const failure = createSpawnTaskFailure({
      code: input.code,
      message: input.message,
      retryable: input.retryable,
      ...(input.details === undefined ? {} : { details: input.details }),
      committedAt: this.clock(),
    })

    try {
      const failed = this.store.transition(current.taskId, {
        runtimeState: 'failed',
        at: failure.committedAt,
        failure,
      })
      await this.notifyTaskUpdated(failed)
      return failed
    } catch (error) {
      return this.reconcileFinalizationFailure(current.taskId, current.version, error, 'failure', failure.code)
    }
  }

  private async reconcileFinalizationFailure(
    taskId: string,
    previousVersion: number,
    error: unknown,
    boundary: 'result' | 'failure',
    originalCode?: SpawnTaskFailureCode,
  ): Promise<SpawnTask | null> {
    await this.reconcileStore()
    let current = this.store.get(taskId)
    if (!current) return null

    // A verified artifact may have been published even when the terminal record
    // commit threw. Reload/reconciliation wins over a synthetic persistence
    // failure so task-owned output is never overwritten.
    if (isSpawnTaskTerminal(current.runtimeState)) {
      if (current.version > previousVersion) await this.notifyTaskUpdated(current)
      return current
    }
    if (current.runtimeState !== 'processing') return current

    const persistFailure = createSpawnTaskFailure({
      code: 'result_persist_failed',
      message: `${boundary} finalization failed: ${errorMessage(error)}`,
      retryable: true,
      details: {
        boundary,
        ...(originalCode ? { originalCode } : {}),
      },
      committedAt: this.clock(),
    })

    try {
      current = this.store.transition(current.taskId, {
        runtimeState: 'failed',
        at: persistFailure.committedAt,
        failure: persistFailure,
      })
      await this.notifyTaskUpdated(current)
      return current
    } catch {
      // A second durability fault leaves the last durable state as the only
      // defensible answer. Reconcile once more before returning it.
      await this.reconcileStore()
      current = this.store.get(taskId)
      if (current && isSpawnTaskTerminal(current.runtimeState) && current.version > previousVersion) {
        await this.notifyTaskUpdated(current)
      }
      return current
    }
  }

  private async reconcileStore(): Promise<SpawnTaskStartupReport> {
    try {
      const report = this.store.reload()
      await this.notifyStartupReport(report)
      return report
    } catch {
      return { finalized: [], integrityMarked: [] }
    }
  }

  private async notifyStartupReport(report: SpawnTaskStartupReport): Promise<void> {
    for (const change of report.finalized) {
      const task = this.store.get(change.taskId)
      if (task) await this.notifyTaskUpdated(task)
    }
    for (const change of report.integrityMarked) {
      const task = this.store.get(change.taskId)
      if (task) await this.notifyTaskUpdated(task)
    }
  }

  private async notifyTaskUpdated(task: SpawnTask): Promise<void> {
    const key = `${task.taskId}:${task.version}`
    if (this.notifiedUpdates.has(key)) return
    this.notifiedUpdates.add(key)
    try {
      await this.onTaskUpdated?.({ taskId: task.taskId, version: task.version })
    } catch {
      // Task durability is authoritative; invalidation hooks are best effort
      // and must never create an unhandled rejection or rewrite task state.
    }
  }

  private failure(
    error: unknown,
    boundary: string,
    code: 'spawn_persist_failed' | 'provider_error' = 'spawn_persist_failed',
  ): SpawnTaskFailure {
    return createSpawnTaskFailure({
      code,
      message: errorMessage(error),
      retryable: true,
      details: { boundary },
      committedAt: this.clock(),
    })
  }

  private creationFailure(
    task: SpawnTask,
    error: unknown,
    boundary: string,
    code: 'spawn_persist_failed' | 'provider_error' = 'spawn_persist_failed',
  ): SpawnTaskCreationError {
    const current = this.store.get(task.taskId) ?? task
    const failure = this.failure(error, boundary, code)
    const failed = this.commitFailure(current, failure)
    return new SpawnTaskCreationError(failure, failed)
  }

  private commitFailure(task: SpawnTask, failure: SpawnTaskFailure): SpawnTask {
    let current = this.store.get(task.taskId) ?? task
    if (current.runtimeState === 'queued') {
      try {
        current = this.store.transition(current.taskId, {
          runtimeState: 'processing',
          at: this.clock(),
        })
      } catch {
        return this.store.get(task.taskId) ?? current
      }
    }
    if (current.runtimeState !== 'processing') return current
    try {
      const failed = this.store.transition(current.taskId, {
        runtimeState: 'failed',
        at: failure.committedAt,
        failure,
      })
      void this.notifyTaskUpdated(failed)
      return failed
    } catch {
      // Keep the last committed reservation/claim as recovery evidence. Never
      // compensate by deleting a task whose intent reached durable storage.
      return this.store.get(task.taskId) ?? current
    }
  }
}
