import type {
  SpawnTask,
  SpawnTaskFailure,
  SpawnTaskFailureCode,
  SpawnTaskJsonValue,
} from '@kata-sh/core'
import type { SpawnSessionResult } from '@kata-sh/shared/agent'
import {
  createSpawnTaskAwaitingInput,
  createSpawnTaskFailure,
  isSpawnTaskTerminal,
  type CreateSpawnTaskAwaitingInputInput,
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

export interface SpawnTaskLateEvent {
  readonly taskId: string
  readonly childSessionId: string
  readonly currentState: SpawnTask['runtimeState']
  readonly eventKind: string
}

export type SpawnTaskUpdatedHandler = (change: SpawnTaskUpdated) => void | Promise<void>
export type SpawnTaskLateEventHandler = (event: SpawnTaskLateEvent) => void | Promise<void>

export interface SpawnTaskCancellationRuntime {
  readonly abort?: () => void | Promise<void>
  readonly cleanup?: () => void | Promise<void>
}

export interface SpawnTaskRecoveryReference {
  readonly taskId: string
  readonly parentSessionId: string
  readonly childSessionId: string
  readonly delegatedPrompt?: string
  readonly childConfig?: Readonly<Record<string, SpawnTaskJsonValue>>
  readonly messageId?: string
  readonly dispatchAttemptId?: string
}

export interface SpawnTaskRecoveryChild {
  readonly exists: boolean
  readonly matches: boolean
  readonly reference?: SpawnTaskRecoveryReference
}

export interface SpawnTaskRecoveryAdapter {
  readonly parentExists?: (parentSessionId: string) => boolean | Promise<boolean>
  readonly findChild: (task: SpawnTask) => SpawnTaskRecoveryChild | Promise<SpawnTaskRecoveryChild>
  readonly listChildren?: () => readonly SpawnTaskRecoveryReference[] | Promise<readonly SpawnTaskRecoveryReference[]>
}

export interface SpawnTaskCancellationResult {
  readonly status: 'cancelled' | 'already_terminal' | 'cancel_failed'
  readonly task: SpawnTask | null
}

export interface SpawnTaskCoordinatorOptions {
  readonly store: SpawnTaskStore
  readonly createChild: (input: SpawnTaskCreateChildInput) => Promise<void>
  readonly appendDelegatedPrompt: (input: SpawnTaskAppendPromptInput) => Promise<void>
  readonly dispatchProvider: (input: SpawnTaskDispatchInput) => void | Promise<void>
  readonly onTaskUpdated?: SpawnTaskUpdatedHandler
  readonly onLateEvent?: SpawnTaskLateEventHandler
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
 * A process-local claim registry lets two SessionManager instances sharing a
 * workspace recognize the manager that won a durable claim. A fresh process
 * starts empty, so persisted claimed/sent work still becomes
 * dispatch_interrupted rather than replaying after restart.
 */
const activeDispatchRegistry = new Set<string>()

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
  private readonly onLateEvent?: SpawnTaskLateEventHandler
  private readonly clock: () => string
  private readonly notifiedUpdates = new Set<string>()
  private readonly cancellationOperations = new Map<string, Promise<SpawnTaskCancellationResult>>()
  private readonly deletedParents = new Set<string>()
  private readonly activeDispatches = new Set<string>()
  private readonly startupNotification: Promise<void>
  private recoveryOperation?: Promise<void>

  constructor(options: SpawnTaskCoordinatorOptions) {
    this.store = options.store
    this.createChild = options.createChild
    this.appendDelegatedPrompt = options.appendDelegatedPrompt
    this.dispatchProvider = options.dispatchProvider
    this.onTaskUpdated = options.onTaskUpdated
    this.onLateEvent = options.onLateEvent
    this.clock = options.clock ?? (() => new Date().toISOString())
    try {
      for (const parentSessionId of this.store.listDeletedParents()) {
        this.deletedParents.add(parentSessionId)
      }
      for (const task of this.store.listAll()) {
        if (task.parentDeletedAt) this.deletedParents.add(task.parentSessionId)
      }
    } catch {
      // Startup reconciliation remains authoritative for stores that do not
      // expose an initialized in-memory index during factory failure tests.
    }
    this.startupNotification = this.notifyStartupReport(this.store.getLastStartupReport())
  }

  async finalizeResultForChildSession(
    childSessionId: string,
    content: string,
    sourceMessageId?: string,
  ): Promise<SpawnTask | null> {
    await this.startupNotification
    const current = this.store.getByChildSessionId(childSessionId)
    if (!current) return current
    if (isSpawnTaskTerminal(current.runtimeState)) {
      this.clearDispatchActive(current.taskId)
      this.auditLateEvent(current, 'result')
      return current
    }

    try {
      const finalized = this.store.commitResult(current.taskId, content, {
        committedAt: this.clock(),
        ...(sourceMessageId ? { sourceMessageId } : {}),
      })
      await this.notifyTaskUpdated(finalized)
      this.clearDispatchActive(finalized.taskId)
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

  async awaitInputForChildSession(
    childSessionId: string,
    input: CreateSpawnTaskAwaitingInputInput,
  ): Promise<SpawnTask | null> {
    await this.startupNotification
    const current = this.store.getByChildSessionId(childSessionId)
    if (!current) return current
    if (isSpawnTaskTerminal(current.runtimeState)) {
      this.auditLateEvent(current, `${input.kind}_request`)
      return current
    }
    if (current.cancellation || current.runtimeState !== 'processing') return current

    const awaitingInput = createSpawnTaskAwaitingInput(input)
    try {
      const awaiting = this.store.transition(current.taskId, {
        runtimeState: 'awaiting-input',
        at: awaitingInput.createdAt,
        awaitingInput,
      })
      await this.notifyTaskUpdated(awaiting)
      return awaiting
    } catch {
      await this.reconcileStore()
      return this.store.get(current.taskId)
    }
  }

  async resumeAwaitingInputForChildSession(
    childSessionId: string,
    requestId: string,
  ): Promise<SpawnTask | null> {
    await this.startupNotification
    const current = this.store.getByChildSessionId(childSessionId)
    if (!current) return current
    if (isSpawnTaskTerminal(current.runtimeState)) {
      this.auditLateEvent(current, 'input_response')
      return current
    }
    if (
      current.runtimeState !== 'awaiting-input'
      || current.cancellation
      || current.awaitingInput?.requestId !== requestId
    ) return current

    try {
      const resumed = this.store.transition(current.taskId, {
        runtimeState: 'processing',
        at: this.clock(),
      })
      await this.notifyTaskUpdated(resumed)
      return resumed
    } catch {
      await this.reconcileStore()
      return this.store.get(current.taskId)
    }
  }

  async interruptAwaitingInputForChildSession(
    childSessionId: string,
    error?: unknown,
  ): Promise<SpawnTask | null> {
    await this.startupNotification
    const current = this.store.getByChildSessionId(childSessionId)
    if (!current) return current
    if (isSpawnTaskTerminal(current.runtimeState)) {
      this.auditLateEvent(current, 'input_interrupted')
      return current
    }
    if (current.cancellation || current.runtimeState !== 'awaiting-input' || !current.awaitingInput) return current

    const failure = createSpawnTaskFailure({
      code: 'input_interrupted',
      message: error ?? `Pending ${current.awaitingInput.kind} input was interrupted.`,
      retryable: true,
      details: { kind: current.awaitingInput.kind },
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
    } catch {
      await this.reconcileStore()
      return this.store.get(current.taskId)
    }
  }

  async cancelChildSession(
    childSessionId: string,
    reason: string,
    runtime?: SpawnTaskCancellationRuntime,
  ): Promise<SpawnTaskCancellationResult> {
    await this.startupNotification
    const current = this.store.getByChildSessionId(childSessionId)
    if (!current) return { status: 'already_terminal', task: null }
    return this.cancelTask(current.taskId, reason, runtime)
  }

  getTask(taskId: string): SpawnTask | null {
    return this.store.get(taskId)
  }

  dispose(): void {
    for (const taskId of this.activeDispatches) this.clearDispatchActive(taskId)
  }

  recordLateEventForChildSession(childSessionId: string, eventKind: string): boolean {
    const current = this.store.getByChildSessionId(childSessionId)
    if (!current || !isSpawnTaskTerminal(current.runtimeState)) return false
    this.auditLateEvent(current, eventKind)
    return true
  }

  recordRejectedInputForChildSession(childSessionId: string, eventKind: string): boolean {
    const current = this.store.getByChildSessionId(childSessionId)
    if (!current) return false
    this.auditLateEvent(current, eventKind)
    return true
  }

  async cancelTask(
    taskId: string,
    reason: string,
    runtime?: SpawnTaskCancellationRuntime,
  ): Promise<SpawnTaskCancellationResult> {
    const existing = this.cancellationOperations.get(taskId)
    if (existing) return existing

    const operation = this.cancelTaskOnce(taskId, reason, runtime)
    this.cancellationOperations.set(taskId, operation)
    try {
      return await operation
    } finally {
      if (this.cancellationOperations.get(taskId) === operation) {
        this.cancellationOperations.delete(taskId)
      }
    }
  }

  private async cancelTaskOnce(
    taskId: string,
    reason: string,
    runtime?: SpawnTaskCancellationRuntime,
  ): Promise<SpawnTaskCancellationResult> {
    await this.startupNotification
    let current = this.store.get(taskId)
    if (!current || isSpawnTaskTerminal(current.runtimeState)) {
      if (current) this.clearDispatchActive(current.taskId)
      return { status: 'already_terminal', task: current }
    }

    let requested: SpawnTask
    try {
      requested = this.store.requestCancellation(taskId, this.clock(), reason)
      if (requested.version !== current.version) await this.notifyTaskUpdated(requested)
    } catch {
      await this.reconcileStore()
      current = this.store.get(taskId)
      return isSpawnTaskTerminal(current?.runtimeState ?? 'cancelled')
        ? { status: 'already_terminal', task: current }
        : { status: 'cancel_failed', task: current }
    }

    if (requested.runtimeState === 'queued' || !runtime?.abort) {
      return this.commitCancellation(requested)
    }

    try {
      await runtime.abort()
    } catch (error) {
      try {
        await runtime.cleanup?.()
      } catch {
        // Cleanup is best effort, but it is attempted before durable failure.
      }

      current = this.store.get(taskId)
      if (!current || isSpawnTaskTerminal(current.runtimeState)) {
        if (current) this.clearDispatchActive(current.taskId)
        return { status: 'already_terminal', task: current }
      }

      const failure = createSpawnTaskFailure({
        code: 'cancel_failed',
        message: error,
        retryable: false,
        details: { reason },
        committedAt: this.clock(),
      })
      try {
        const failed = this.store.transition(taskId, {
          runtimeState: 'failed',
          at: failure.committedAt,
          failure,
        })
        await this.notifyTaskUpdated(failed)
        this.clearDispatchActive(failed.taskId)
        return { status: 'cancel_failed', task: failed }
      } catch {
        await this.reconcileStore()
        current = this.store.get(taskId)
        return { status: 'cancel_failed', task: current }
      }
    }

    current = this.store.get(taskId)
    if (!current || isSpawnTaskTerminal(current.runtimeState)) {
      if (current) this.clearDispatchActive(current.taskId)
      return { status: 'already_terminal', task: current }
    }
    return this.commitCancellation(current)
  }

  async markParentDeleted(parentSessionId: string): Promise<readonly SpawnTask[]> {
    this.deletedParents.add(parentSessionId)
    await this.startupNotification
    this.store.markParentDeletedBoundary(parentSessionId, this.clock())
    const changed: SpawnTask[] = []
    for (const snapshot of this.store.listByParentSessionId(parentSessionId)) {
      let current = this.store.get(snapshot.taskId)
      if (!current) continue

      if (!current.parentDeletedAt) {
        try {
          current = this.store.markParentDeleted(current.taskId, this.clock())
          await this.notifyTaskUpdated(current)
        } catch {
          await this.reconcileStore()
          current = this.store.get(snapshot.taskId)
          if (!current) continue
        }
      }

      if (current.dispatch.state !== 'sent' && !isSpawnTaskTerminal(current.runtimeState)) {
        const cancellation = await this.cancelTask(current.taskId, 'parent_deleted')
        current = cancellation.task ?? current
      }
      changed.push(current)
    }
    return changed
  }

  async markChildDeleted(
    childSessionId: string,
    runtime?: SpawnTaskCancellationRuntime,
  ): Promise<SpawnTask | null> {
    await this.startupNotification
    let current = this.store.getByChildSessionId(childSessionId)
    if (!current) return current
    if (!isSpawnTaskTerminal(current.runtimeState)) {
      const cancellation = await this.cancelChildSession(childSessionId, 'child_deleted', runtime)
      current = cancellation.task ?? current
    }
    if (current && !current.childDeletedAt) {
      try {
        current = this.store.markChildDeleted(current.taskId, this.clock())
        await this.notifyTaskUpdated(current)
      } catch {
        await this.reconcileStore()
        current = this.store.get(current.taskId)
      }
    }
    return current
  }

  private async commitCancellation(task: SpawnTask): Promise<SpawnTaskCancellationResult> {
    if (isSpawnTaskTerminal(task.runtimeState)) {
      this.clearDispatchActive(task.taskId)
      return { status: 'already_terminal', task }
    }
    try {
      const cancelled = this.store.transition(task.taskId, {
        runtimeState: 'cancelled',
        at: this.clock(),
        cancellation: task.cancellation!,
      })
      await this.notifyTaskUpdated(cancelled)
      this.clearDispatchActive(cancelled.taskId)
      return { status: 'cancelled', task: cancelled }
    } catch {
      await this.reconcileStore()
      const current = this.store.get(task.taskId)
      return isSpawnTaskTerminal(current?.runtimeState ?? 'cancelled')
        ? { status: 'already_terminal', task: current }
        : { status: 'cancel_failed', task: current }
    }
  }

  private dispatchRegistryKey(taskId: string): string {
    return `${this.store.rootPath}\u0000${taskId}`
  }

  private markDispatchActive(taskId: string): void {
    this.activeDispatches.add(taskId)
    activeDispatchRegistry.add(this.dispatchRegistryKey(taskId))
  }

  private isDispatchActive(taskId: string): boolean {
    return this.activeDispatches.has(taskId) || activeDispatchRegistry.has(this.dispatchRegistryKey(taskId))
  }

  private clearDispatchActive(taskId: string): void {
    this.activeDispatches.delete(taskId)
    activeDispatchRegistry.delete(this.dispatchRegistryKey(taskId))
  }

  async reconcileStartup(recovery?: SpawnTaskRecoveryAdapter): Promise<void> {
    const existing = this.recoveryOperation
    if (existing) {
      await existing
      return
    }
    const operation = this.reconcileStartupOnce(recovery)
    this.recoveryOperation = operation
    try {
      await operation
    } finally {
      if (this.recoveryOperation === operation) this.recoveryOperation = undefined
    }
  }

  private async reconcileStartupOnce(recovery?: SpawnTaskRecoveryAdapter): Promise<void> {
    await this.startupNotification
    await this.reconcileStore()
    if (!recovery) return

    const children = recovery.listChildren ? await recovery.listChildren() : []
    for (const reference of children) {
      const existing = this.store.get(reference.taskId)
      if (existing) {
        if (!this.recoveryReferenceMatchesTask(reference, existing)) {
          this.auditLateEvent(existing, 'recovery_identity_mismatch')
        }
        continue
      }
      try {
        const reconstructed = this.store.reconstructMissingTask({
          taskId: reference.taskId,
          parentSessionId: reference.parentSessionId,
          childSessionId: reference.childSessionId,
          delegatedPrompt: reference.delegatedPrompt,
          childConfig: reference.childConfig,
          messageId: reference.messageId,
          dispatchAttemptId: reference.dispatchAttemptId,
          at: this.clock(),
        })
        await this.notifyTaskUpdated(reconstructed)
      } catch {
        await this.reconcileStore()
      }
    }

    for (const snapshot of this.store.listAll()) {
      try {
        let current = this.store.get(snapshot.taskId)
        if (!current || isSpawnTaskTerminal(current.runtimeState)) continue

        const parentExists = recovery.parentExists ? await recovery.parentExists(current.parentSessionId) : true
        const parentDeleted = !!current.parentDeletedAt || !parentExists
        if (parentDeleted) {
          try {
            this.store.markParentDeletedBoundary(current.parentSessionId, this.clock())
          } catch {
            await this.reconcileStore()
            continue
          }
        }
        if (parentDeleted && !current.parentDeletedAt) {
          try {
            current = this.store.markParentDeleted(current.taskId, this.clock())
            await this.notifyTaskUpdated(current)
          } catch {
            await this.reconcileStore()
            current = this.store.get(snapshot.taskId)
            if (!current) continue
          }
        }

        if (parentDeleted && current.dispatch.state !== 'sent') {
          const cancellation = await this.cancelTask(current.taskId, 'parent_deleted')
          current = cancellation.task ?? this.store.get(current.taskId) ?? current
          if (isSpawnTaskTerminal(current.runtimeState)) continue
        }

        if (current.dispatch.state === 'sent') {
          if (!this.isDispatchActive(current.taskId)) await this.interruptRecoveredDispatch(current)
          continue
        }
        if (current.dispatch.state === 'claimed') {
          if (parentDeleted || this.isDispatchActive(current.taskId)) continue
          await this.interruptRecoveredDispatch(current)
          continue
        }
        if (current.dispatch.state === 'reserved') {
          if (parentDeleted) continue
          let child = await recovery.findChild(current)
          if (child.exists && !child.matches) {
            await this.commitRecoveryFailure(current, 'child')
            continue
          }
          if (!child.exists) {
            try {
              await this.createChild({ task: current })
            } catch {
              await this.reconcileStore()
              current = this.store.get(snapshot.taskId)
              if (!current || isSpawnTaskTerminal(current.runtimeState)) continue
              if (recovery.parentExists && !(await recovery.parentExists(current.parentSessionId))) {
                const cancellation = await this.cancelTask(current.taskId, 'parent_deleted')
                if (cancellation.task?.runtimeState === 'cancelled') continue
              }
              child = await recovery.findChild(current)
              if (!child.exists || !child.matches) {
                await this.commitRecoveryFailure(current, 'child')
                continue
              }
              if (current.dispatch.state !== 'reserved') {
                if (current.dispatch.state === 'ready') await this.recoverReadyTask(current, recovery)
                continue
              }
            }
          }
          try {
            current = this.store.updateDispatch(current.taskId, 'ready', this.clock())
            await this.notifyTaskUpdated(current)
          } catch {
            await this.reconcileStore()
            continue
          }
        }

        if (current.dispatch.state === 'ready') {
          await this.recoverReadyTask(current, recovery)
        }
      } catch {
        await this.reconcileStore()
      }
    }
  }

  private async cancelRecoveryBeforeDispatch(
    taskId: string,
    recovery: SpawnTaskRecoveryAdapter,
  ): Promise<boolean> {
    let current = this.store.get(taskId)
    if (!current || isSpawnTaskTerminal(current.runtimeState)) return true
    const parentExists = recovery.parentExists ? await recovery.parentExists(current.parentSessionId) : true
    if (!current.parentDeletedAt && parentExists) return false

    try {
      this.store.markParentDeletedBoundary(current.parentSessionId, this.clock())
    } catch {
      await this.reconcileStore()
      return true
    }
    if (!current.parentDeletedAt) {
      try {
        current = this.store.markParentDeleted(current.taskId, this.clock())
        await this.notifyTaskUpdated(current)
      } catch {
        await this.reconcileStore()
        current = this.store.get(taskId)
        if (!current) return true
      }
    }
    if (current.dispatch.state !== 'sent' && !isSpawnTaskTerminal(current.runtimeState)) {
      const cancellation = await this.cancelTask(current.taskId, 'parent_deleted')
      current = cancellation.task ?? this.store.get(taskId) ?? current
    }
    if (current.dispatch.state !== 'sent') this.clearDispatchActive(current.taskId)
    return true
  }

  private recoveryReferenceMatchesTask(reference: SpawnTaskRecoveryReference, task: SpawnTask): boolean {
    return reference.parentSessionId === task.parentSessionId
      && reference.childSessionId === task.childSessionId
      && (reference.delegatedPrompt === undefined || reference.delegatedPrompt === task.delegatedPrompt)
      && (reference.childConfig === undefined || JSON.stringify(reference.childConfig) === JSON.stringify(task.childConfig))
      && (reference.messageId === undefined || reference.messageId === task.dispatch.messageId)
      && (reference.dispatchAttemptId === undefined || reference.dispatchAttemptId === task.dispatch.dispatchAttemptId)
  }

  private async recoverReadyTask(task: SpawnTask, recovery: SpawnTaskRecoveryAdapter): Promise<void> {
    let current = this.store.get(task.taskId)
    if (!current || isSpawnTaskTerminal(current.runtimeState)) return
    if (await this.cancelRecoveryBeforeDispatch(current.taskId, recovery)) return

    try {
      current = this.store.updateDispatch(current.taskId, 'claimed', this.clock())
      this.markDispatchActive(current.taskId)
      await this.notifyTaskUpdated(current)
    } catch {
      await this.reconcileStore()
      return
    }

    try {
      await this.appendDelegatedPrompt({
        task: current,
        prompt: current.delegatedPrompt,
      })
    } catch {
      await this.commitRecoveryFailure(current, 'message_append')
      return
    }

    try {
      current = this.store.updateDispatch(current.taskId, 'sent', this.clock())
      await this.notifyTaskUpdated(current)
      current = this.store.transition(current.taskId, {
        runtimeState: 'processing',
        at: this.clock(),
      })
      await this.notifyTaskUpdated(current)
    } catch {
      if (await this.cancelRecoveryBeforeDispatch(current.taskId, recovery)) return
      await this.commitRecoveryFailure(current, 'sent')
      return
    }

    try {
      const providerTurn = this.dispatchProvider({
        task: current,
        prompt: current.delegatedPrompt,
      })
      this.markDispatchActive(current.taskId)
      if (providerTurn) {
        void providerTurn.catch((error: unknown) => {
          void this.finalizeProviderFailureForChildSession(current!.childSessionId, error).catch(() => {})
        })
      }
    } catch (error) {
      await this.commitRecoveryFailure(current, 'provider', 'provider_error', error)
    }
  }

  private async interruptRecoveredDispatch(task: SpawnTask): Promise<void> {
    try {
      const failed = this.store.interruptDispatch(task.taskId, this.clock())
      await this.notifyTaskUpdated(failed)
      this.clearDispatchActive(failed.taskId)
    } catch {
      await this.reconcileStore()
    }
  }

  private async commitRecoveryFailure(
    task: SpawnTask,
    boundary: string,
    code: 'spawn_persist_failed' | 'provider_error' = 'spawn_persist_failed',
    error?: unknown,
  ): Promise<void> {
    const failure = this.failure(error ?? `Spawned-task recovery failed at ${boundary}.`, boundary, code)
    let current = this.store.get(task.taskId) ?? task
    if (isSpawnTaskTerminal(current.runtimeState)) return
    try {
      const failed = await this.commitFailure(current, failure)
      if (isSpawnTaskTerminal(failed.runtimeState)) this.clearDispatchActive(failed.taskId)
    } catch {
      await this.reconcileStore()
    }
  }

  private async preDispatchCancellation(task: SpawnTask): Promise<SpawnSessionResult | null> {
    let current = this.store.get(task.taskId)
    if (!current || current.dispatch.state === 'sent') return null

    const parentDeleted = this.deletedParents.has(current.parentSessionId)
      || this.store.isParentDeleted(current.parentSessionId)
    if (parentDeleted && !isSpawnTaskTerminal(current.runtimeState)) {
      this.deletedParents.add(current.parentSessionId)
      if (!current.parentDeletedAt) {
        current = this.store.markParentDeleted(current.taskId, this.clock())
        await this.notifyTaskUpdated(current)
      }
      const cancellation = await this.cancelTask(current.taskId, 'parent_deleted')
      current = cancellation.task ?? this.store.get(current.taskId) ?? current
    }

    if (current.cancellation?.reason === 'parent_deleted' || current.cancellation?.reason === 'child_deleted') {
      return {
        taskId: current.taskId,
        childSessionId: current.childSessionId,
        runtimeState: current.runtimeState,
        version: current.version,
      }
    }
    return null
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

    const reservedCancellation = await this.preDispatchCancellation(task)
    if (reservedCancellation) return reservedCancellation

    try {
      await this.createChild({ task })
    } catch (error) {
      throw await this.creationFailure(task, error, 'child')
    }

    const childCancellation = await this.preDispatchCancellation(task)
    if (childCancellation) return childCancellation

    try {
      task = this.store.updateDispatch(task.taskId, 'ready', this.clock())
    } catch (error) {
      const deletionCancellation = await this.preDispatchCancellation(task)
      if (deletionCancellation) return deletionCancellation
      throw await this.creationFailure(task, error, 'ready')
    }

    const readyCancellation = await this.preDispatchCancellation(task)
    if (readyCancellation) return readyCancellation

    try {
      task = this.store.updateDispatch(task.taskId, 'claimed', this.clock())
      this.markDispatchActive(task.taskId)
    } catch (error) {
      const deletionCancellation = await this.preDispatchCancellation(task)
      if (deletionCancellation) return deletionCancellation
      throw await this.creationFailure(task, error, 'claim')
    }

    const claimedCancellation = await this.preDispatchCancellation(task)
    if (claimedCancellation) return claimedCancellation

    try {
      await this.appendDelegatedPrompt({
        task,
        prompt: input.delegatedPrompt,
        attachments: input.attachments,
      })
    } catch (error) {
      throw await this.creationFailure(task, error, 'message_append')
    }

    const appendedCancellation = await this.preDispatchCancellation(task)
    if (appendedCancellation) return appendedCancellation

    try {
      task = this.store.updateDispatch(task.taskId, 'sent', this.clock())
    } catch (error) {
      const deletionCancellation = await this.preDispatchCancellation(task)
      if (deletionCancellation) return deletionCancellation
      throw await this.creationFailure(task, error, 'sent')
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
      throw await this.creationFailure(task, error, 'processing')
    }

    try {
      // The provider turn remains fire-and-forget for spawn(). C2 consumes its
      // eventual rejection through the same durable lifecycle finalizer.
      const providerTurn = this.dispatchProvider({
        task,
        prompt: input.delegatedPrompt,
        attachments: input.attachments,
      })
      this.markDispatchActive(task.taskId)
      if (providerTurn) {
        void providerTurn.catch((error: unknown) => {
          void this.finalizeProviderFailureForChildSession(task.childSessionId, error).catch(() => {})
        })
      }
    } catch (error) {
      // A truly synchronous callback throw is an invocation/provider failure,
      // not a spawn-persistence failure. Async turn rejection is handled by
      // the same durable lifecycle finalizer above.
      throw await this.creationFailure(task, error, 'provider', 'provider_error')
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
    if (!current) return current
    if (isSpawnTaskTerminal(current.runtimeState)) {
      this.clearDispatchActive(current.taskId)
      this.auditLateEvent(current, input.code)
      return current
    }
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
      this.clearDispatchActive(failed.taskId)
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
      this.clearDispatchActive(current.taskId)
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
      if (current && isSpawnTaskTerminal(current.runtimeState)) {
        if (current.version > previousVersion) await this.notifyTaskUpdated(current)
        this.clearDispatchActive(current.taskId)
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
      return { finalized: [], integrityMarked: [], inputInterrupted: [] }
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
    for (const change of report.inputInterrupted) {
      const task = this.store.get(change.taskId)
      if (task) await this.notifyTaskUpdated(task)
    }
  }

  private auditLateEvent(task: SpawnTask, eventKind: string): void {
    const event: SpawnTaskLateEvent = {
      taskId: task.taskId,
      childSessionId: task.childSessionId,
      currentState: task.runtimeState,
      eventKind,
    }
    try {
      Promise.resolve(this.onLateEvent?.(event)).catch(() => {})
    } catch {
      // Auditing is best effort and must never change terminal task state.
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

  private async creationFailure(
    task: SpawnTask,
    error: unknown,
    boundary: string,
    code: 'spawn_persist_failed' | 'provider_error' = 'spawn_persist_failed',
  ): Promise<SpawnTaskCreationError> {
    const current = this.store.get(task.taskId) ?? task
    const failure = this.failure(error, boundary, code)
    const failed = await this.commitFailure(current, failure)
    return new SpawnTaskCreationError(failure, failed)
  }

  private async commitFailure(task: SpawnTask, failure: SpawnTaskFailure): Promise<SpawnTask> {
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
      await this.notifyTaskUpdated(failed)
      return failed
    } catch {
      // Keep the last committed reservation/claim as recovery evidence. Never
      // compensate by deleting a task whose intent reached durable storage.
      return this.store.get(task.taskId) ?? current
    }
  }
}
