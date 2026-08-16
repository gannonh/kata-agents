import type { SpawnTask, SpawnTaskFailure, SpawnTaskJsonValue } from '@kata-sh/core'
import type { SpawnSessionResult } from '@kata-sh/shared/agent'
import {
  createSpawnTaskFailure,
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

export interface SpawnTaskCoordinatorOptions {
  readonly store: SpawnTaskStore
  readonly createChild: (input: SpawnTaskCreateChildInput) => Promise<void>
  readonly appendDelegatedPrompt: (input: SpawnTaskAppendPromptInput) => Promise<void>
  readonly dispatchProvider: (input: SpawnTaskDispatchInput) => void | Promise<void>
  readonly clock?: () => string
  readonly onAsyncDispatchFailure?: (error: unknown, task: SpawnTask) => void
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
 * Owns the reserved-child and at-most-once initial dispatch protocol. The
 * SessionManager supplies the child publication, transcript append, and
 * provider boundary; it does not own dispatch ordering or task persistence.
 */
export class SpawnTaskCoordinator {
  private readonly store: SpawnTaskStore
  private readonly createChild: SpawnTaskCoordinatorOptions['createChild']
  private readonly appendDelegatedPrompt: SpawnTaskCoordinatorOptions['appendDelegatedPrompt']
  private readonly dispatchProvider: SpawnTaskCoordinatorOptions['dispatchProvider']
  private readonly clock: () => string
  private readonly onAsyncDispatchFailure?: SpawnTaskCoordinatorOptions['onAsyncDispatchFailure']

  constructor(options: SpawnTaskCoordinatorOptions) {
    this.store = options.store
    this.createChild = options.createChild
    this.appendDelegatedPrompt = options.appendDelegatedPrompt
    this.dispatchProvider = options.dispatchProvider
    this.clock = options.clock ?? (() => new Date().toISOString())
    this.onAsyncDispatchFailure = options.onAsyncDispatchFailure
  }

  async spawn(input: SpawnTaskSpawnInput): Promise<SpawnSessionResult> {
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
      const dispatch = this.dispatchProvider({
        task,
        prompt: input.delegatedPrompt,
        attachments: input.attachments,
      })
      if (dispatch && typeof (dispatch as Promise<void>).then === 'function') {
        void dispatch.catch((error: unknown) => {
          const current = this.store.get(task.taskId) ?? task
          const failed = this.commitFailure(current, error, 'provider')
          this.onAsyncDispatchFailure?.(error, failed)
        })
      }
    } catch (error) {
      throw this.creationFailure(task, error, 'provider')
    }

    return {
      taskId: task.taskId,
      childSessionId: task.childSessionId,
      runtimeState: task.runtimeState,
      version: task.version,
    }
  }

  private failure(error: unknown, boundary: string): SpawnTaskFailure {
    return createSpawnTaskFailure({
      code: 'spawn_persist_failed',
      message: errorMessage(error),
      retryable: true,
      details: { boundary },
      committedAt: this.clock(),
    })
  }

  private creationFailure(task: SpawnTask, error: unknown, boundary: string): SpawnTaskCreationError {
    const current = this.store.get(task.taskId) ?? task
    const failure = this.failure(error, boundary)
    const failed = this.commitFailure(current, error, boundary, failure)
    return new SpawnTaskCreationError(failure, failed)
  }

  private commitFailure(
    task: SpawnTask,
    error: unknown,
    boundary: string,
    providedFailure?: SpawnTaskFailure,
  ): SpawnTask {
    const failure = providedFailure ?? this.failure(error, boundary)
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
      return this.store.transition(current.taskId, {
        runtimeState: 'failed',
        at: failure.committedAt,
        failure,
      })
    } catch {
      // Keep the last committed reservation/claim as recovery evidence. Never
      // compensate by deleting a task whose intent reached durable storage.
      return this.store.get(task.taskId) ?? current
    }
  }
}
