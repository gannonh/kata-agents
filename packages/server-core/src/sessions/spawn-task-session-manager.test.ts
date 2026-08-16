import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_DIR } from '@kata-sh/shared/config'
import { getSessionPath, loadSession, saveSession, type SessionBundle } from '@kata-sh/shared/sessions'
import { SpawnTaskStore } from '@kata-sh/shared/spawn-tasks'
import type { SpawnTask } from '@kata-sh/core'
import type { SessionEvent } from '@kata-sh/shared/protocol'
import {
  SessionManager,
  createManagedSession,
} from './SessionManager.ts'
import type { SpawnTaskCoordinator } from './spawn-task-coordinator.ts'
import { createGitServices } from '../git/index.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('SessionManager spawned-task transcript append', () => {
  it('does not expose the durable child back-reference in the public session view', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-session-manager-'))
    roots.push(workspaceRoot)
    const workspace = {
      id: 'workspace_spawn_test',
      name: 'Spawn test workspace',
      rootPath: workspaceRoot,
      createdAt: Date.now(),
    }
    const manager = new SessionManager()
    manager.setEventSink(() => {})
    const child = createManagedSession(
      {
        id: 'session_child',
        spawnTaskRef: {
          taskId: 'task_spawn_test',
          parentSessionId: 'session_parent',
        },
      },
      workspace as never,
      { messagesLoaded: true },
    )
    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(child.id, child)

    const publicSession = await manager.getSession(child.id)

    expect(publicSession).not.toBeNull()
    expect('spawnTaskRef' in (publicSession as object)).toBe(false)
  })

  it('persists the reserved child ID and private task reference through real SessionManager storage', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-session-manager-'))
    roots.push(workspaceRoot)
    const workspace = {
      id: 'workspace_spawn_integration',
      name: 'Spawn integration workspace',
      rootPath: workspaceRoot,
      createdAt: Date.now(),
    }
    const configFile = join(CONFIG_DIR, 'config.json')
    const originalConfig = existsSync(configFile) ? readFileSync(configFile, 'utf8') : null
    const config = originalConfig
      ? JSON.parse(originalConfig) as { workspaces: Array<Record<string, unknown>>; activeWorkspaceId?: string | null; activeSessionId?: string | null }
      : { workspaces: [], activeWorkspaceId: null, activeSessionId: null }
    config.workspaces = (config.workspaces ?? []).filter((entry) => entry.id !== workspace.id)
    config.workspaces.push(workspace)
    writeFileSync(configFile, JSON.stringify(config, null, 2))

    try {
      let dispatchedTask: SpawnTask | undefined
      const manager = new SessionManager({
        spawnTaskDispatchProvider: ({ task }) => {
          dispatchedTask = task
        },
      })
      manager.setEventSink(() => {})
      const parent = createManagedSession(
        { id: 'session_spawn_integration_parent', name: 'parent' },
        workspace as never,
        { messagesLoaded: true },
      )
      const sessions = (manager as unknown as { sessions: Map<string, unknown> }).sessions
      sessions.set(parent.id, parent)

      const coordinator = (manager as unknown as {
        getSpawnTaskCoordinator: (session: unknown) => SpawnTaskCoordinator
      }).getSpawnTaskCoordinator(parent)
      const result = await coordinator.spawn({
        parentSessionId: parent.id,
        delegatedPrompt: 'persist the real child relationship',
        childConfig: { name: 'child' },
      })

      const persistedChild = loadSession(workspaceRoot, result.childSessionId)
      expect(dispatchedTask?.childSessionId).toBe(result.childSessionId)
      expect(persistedChild).toMatchObject({
        id: result.childSessionId,
        spawnTaskRef: {
          taskId: result.taskId,
          parentSessionId: parent.id,
        },
      })
      expect(persistedChild?.id).toBe(dispatchedTask?.childSessionId)
    } finally {
      if (originalConfig === null) rmSync(configFile, { force: true })
      else writeFileSync(configFile, originalConfig)
    }
  })

  it('does not import private spawn ownership from a session bundle', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-session-manager-'))
    roots.push(workspaceRoot)
    const workspace = {
      id: 'workspace_spawn_import',
      name: 'Spawn import workspace',
      rootPath: workspaceRoot,
      createdAt: Date.now(),
    }
    const configFile = join(CONFIG_DIR, 'config.json')
    const originalConfig = existsSync(configFile) ? readFileSync(configFile, 'utf8') : null
    const config = originalConfig
      ? JSON.parse(originalConfig) as { workspaces: Array<Record<string, unknown>>; activeWorkspaceId?: string | null; activeSessionId?: string | null }
      : { workspaces: [], activeWorkspaceId: null, activeSessionId: null }
    config.workspaces = (config.workspaces ?? []).filter((entry) => entry.id !== workspace.id)
    config.workspaces.push(workspace)
    writeFileSync(configFile, JSON.stringify(config, null, 2))

    try {
      const manager = new SessionManager()
      manager.setEventSink(() => {})
      const bundle: SessionBundle = {
        version: 1,
        session: {
          header: {
            id: 'session_import_private',
            workspaceRootPath: '/source/workspace',
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
            messageCount: 0,
            tokenUsage: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              contextTokens: 0,
              costUsd: 0,
            },
            spawnTaskRef: {
              taskId: 'task_source_private',
              parentSessionId: 'session_source_parent',
            },
          },
          messages: [],
        },
        files: [],
      }

      const imported = await manager.importSession(workspace.id, bundle, 'move')
      const stored = loadSession(workspaceRoot, imported.sessionId)

      expect(stored?.spawnTaskRef).toBeUndefined()
    } finally {
      if (originalConfig === null) rmSync(configFile, { force: true })
      else writeFileSync(configFile, originalConfig)
    }
  })

  it('titles unnamed spawned children through the real stable-message dispatch path', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-session-manager-'))
    roots.push(workspaceRoot)
    const workspace = {
      id: 'workspace_spawn_title_integration',
      name: 'Spawn title integration workspace',
      rootPath: workspaceRoot,
      createdAt: Date.now(),
    }
    const configFile = join(CONFIG_DIR, 'config.json')
    const originalConfig = existsSync(configFile) ? readFileSync(configFile, 'utf8') : null
    const config = originalConfig
      ? JSON.parse(originalConfig) as { workspaces: Array<Record<string, unknown>>; activeWorkspaceId?: string | null; activeSessionId?: string | null }
      : { workspaces: [], activeWorkspaceId: null, activeSessionId: null }
    config.workspaces = (config.workspaces ?? []).filter((entry) => entry.id !== workspace.id)
    config.workspaces.push(workspace)
    writeFileSync(configFile, JSON.stringify(config, null, 2))

    try {
      const titleCalls: string[] = []
      const titleEvents: SessionEvent[] = []
      let manager!: SessionManager
      let sessions!: Map<string, any>
      manager = new SessionManager({
        spawnTaskDispatchProvider: ({ task, prompt, attachments }) => {
          const child = sessions.get(task.childSessionId)
          child.agent = {
            generateTitle: async (message: string) => {
              titleCalls.push(message)
              return 'Enhanced delegated title'
            },
            setAllSources: () => {},
            getModel: () => 'test-model',
            getSessionId: () => undefined,
            async *chat() {
              yield { type: 'complete' as const }
            },
          }
          void manager.sendMessage(
            task.childSessionId,
            prompt,
            attachments ? [...attachments] : undefined,
            undefined,
            undefined,
            task.dispatch.messageId,
          ).catch(() => {})
        },
      })
      manager.setEventSink((_channel, _target, event) => titleEvents.push(event))
      const services = createGitServices({
        worktreeRoot: join(workspaceRoot, 'worktrees'),
        registryPath: join(workspaceRoot, 'worktrees', 'registry.json'),
      })
      manager.setGitServices(services)
      services.lifecycle.markReady()

      const parent = createManagedSession(
        { id: 'session_spawn_title_parent', name: 'parent' },
        workspace as never,
        { messagesLoaded: true },
      )
      sessions = (manager as unknown as { sessions: Map<string, any> }).sessions
      sessions.set(parent.id, parent)
      ;(manager as any).getOrCreateAgent = async (managed: any) => managed.agent

      const coordinator = (manager as any).getSpawnTaskCoordinator(parent)
      const unnamedResult = await coordinator.spawn({
        parentSessionId: parent.id,
        delegatedPrompt: 'Delegate unnamed child',
        childConfig: {},
      })

      let unnamedStored = loadSession(workspaceRoot, unnamedResult.childSessionId)
      for (let attempt = 0; attempt < 20 && (titleCalls.length === 0 || unnamedStored?.name !== 'Enhanced delegated title'); attempt++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
        unnamedStored = loadSession(workspaceRoot, unnamedResult.childSessionId)
      }

      expect(titleCalls).toEqual(['Delegate unnamed child'])
      expect(titleEvents).toContainEqual(expect.objectContaining({
        type: 'title_generated',
        sessionId: unnamedResult.childSessionId,
        title: 'Delegate unnamed child',
      }))
      expect(unnamedStored?.name).toBe('Enhanced delegated title')
      expect(unnamedStored?.messages.filter((message) => message.type === 'user')).toHaveLength(1)

      const namedResult = await coordinator.spawn({
        parentSessionId: parent.id,
        delegatedPrompt: 'Delegate named child',
        childConfig: { name: 'Explicit child name' },
      })
      await new Promise<void>((resolve) => setTimeout(resolve, 20))

      const namedStored = loadSession(workspaceRoot, namedResult.childSessionId)
      expect(titleCalls).toEqual(['Delegate unnamed child'])
      expect(namedStored?.name).toBe('Explicit child name')
      expect(titleEvents.filter((event) => (
        event.type === 'title_generated' && event.sessionId === namedResult.childSessionId
      ))).toHaveLength(0)
    } finally {
      if (originalConfig === null) rmSync(configFile, { force: true })
      else writeFileSync(configFile, originalConfig)
    }
  })

  it('finalizes normalized child completion through the real SessionManager lifecycle boundary', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-session-manager-'))
    roots.push(workspaceRoot)
    const workspace = {
      id: 'workspace_spawn_finalize_integration',
      name: 'Spawn finalize integration workspace',
      rootPath: workspaceRoot,
      createdAt: Date.now(),
    }
    const store = new SpawnTaskStore({
      workspaceRoot,
      workspaceId: workspace.id,
      randomId: (() => {
        let sequence = 0
        return () => `id-${++sequence}`
      })(),
    })
    const updates: Array<{ taskId: string; version: number }> = []
    const terminalLifecycleOrder: string[] = []
    let terminalChildSessionId: string | undefined
    let manager!: SessionManager
    let sessions!: Map<string, any>
    manager = new SessionManager({
      spawnTaskStoreFactory: () => store,
      spawnTaskUpdated: (change) => {
        const reloaded = new SpawnTaskStore({
          workspaceRoot,
          workspaceId: workspace.id,
        })
        const task = reloaded.get(change.taskId)
        const hasApiError = task?.delegatedPrompt.includes('api-error')
        const hasTerminalToolError = task?.delegatedPrompt.includes('terminal-tool')
        expect(task).toMatchObject({
          runtimeState: hasApiError || hasTerminalToolError ? 'failed' : 'completed',
          version: change.version,
        })
        if (hasApiError) {
          expect(task?.failure?.code).toBe('provider_error')
        } else if (hasTerminalToolError) {
          expect(task?.failure?.code).toBe('tool_error')
          expect(task?.failure?.message).toBe('Tool Bash reported an error')
          expect(task?.failure?.details).toEqual({
            toolName: 'Bash',
            toolUseId: 'terminal-tool-use',
          })
          terminalLifecycleOrder.push('task-updated')
        } else {
          expect(task?.result?.byteLength).toBe(
            task?.delegatedPrompt.includes('empty')
              ? 0
              : Buffer.byteLength('normalized child result', 'utf8'),
          )
        }
        updates.push(change)
      },
      spawnTaskDispatchProvider: ({ task, prompt, attachments }) => {
        const child = sessions.get(task.childSessionId)
        const output = prompt.includes('empty') || prompt.includes('api-error') || prompt.includes('terminal-tool')
          ? ''
          : 'normalized child result'
        const hasApiError = prompt.includes('api-error')
        const hasNon400ApiError = prompt.includes('api-error-429')
        const hasRecoverableToolError = prompt.includes('recoverable-tool')
        const hasTerminalToolError = prompt.includes('terminal-tool')
        child.agent = {
          generateTitle: async () => 'Child result title',
          setAllSources: () => {},
          getModel: () => 'test-model',
          getSessionId: () => undefined,
          async *chat() {
            if (hasApiError) {
              writeFileSync(join(getSessionPath(workspaceRoot, task.childSessionId), 'api-error.json'), JSON.stringify({
                status: hasNon400ApiError ? 429 : 400,
                statusText: hasNon400ApiError ? 'Too Many Requests' : 'Bad Request',
                message: hasNon400ApiError
                  ? 'provider rate-limited the child turn'
                  : 'provider rejected the child turn',
                timestamp: Date.now(),
              }))
            }
            if (hasRecoverableToolError || hasTerminalToolError) {
              yield {
                type: 'tool_result' as const,
                toolName: 'Bash',
                toolUseId: hasRecoverableToolError ? 'recoverable-tool-use' : 'terminal-tool-use',
                result: hasRecoverableToolError
                  ? 'Error: transient command failed; the agent can recover'
                  : 'Error: terminal command failure; no recovery followed',
                isError: true,
              }
            }
            if (output) {
              yield { type: 'text_complete' as const, text: output, isIntermediate: false }
            }
            yield { type: 'complete' as const }
          },
        }
        return manager.sendMessage(
          task.childSessionId,
          prompt,
          attachments ? [...attachments] : undefined,
          undefined,
          undefined,
          task.dispatch.messageId,
        )
      },
    })
    manager.setEventSink((_channel, _target, event) => {
      if (event.type === 'complete' && event.sessionId === terminalChildSessionId) {
        terminalLifecycleOrder.push('session-complete')
      }
    })
    const services = createGitServices({
      worktreeRoot: join(workspaceRoot, 'worktrees'),
      registryPath: join(workspaceRoot, 'worktrees', 'registry.json'),
    })
    manager.setGitServices(services)
    services.lifecycle.markReady()

    const parent = createManagedSession(
      { id: 'session_spawn_finalize_parent', name: 'parent' },
      workspace as never,
      { messagesLoaded: true },
    )
    sessions = (manager as unknown as { sessions: Map<string, any> }).sessions
    sessions.set(parent.id, parent)
    ;(manager as any).createSession = async (_workspaceId: string, options: any) => {
      const child = createManagedSession(
        {
          id: options.reservedSessionId,
          name: options.name ?? 'child',
          spawnTaskRef: options.spawnTaskRef,
        },
        workspace as never,
        { messagesLoaded: true },
      )
      sessions.set(child.id, child)
      return { id: child.id, name: child.name }
    }
    ;(manager as any).getOrCreateAgent = async (managed: any) => managed.agent

    const coordinator = (manager as any).getSpawnTaskCoordinator(parent)
    const result = await coordinator.spawn({
      parentSessionId: parent.id,
      delegatedPrompt: 'normalize this child result',
      childConfig: {},
    })
    const recoverableToolResult = await coordinator.spawn({
      parentSessionId: parent.id,
      delegatedPrompt: 'normalize recoverable-tool child result',
      childConfig: {},
    })
    const emptyResult = await coordinator.spawn({
      parentSessionId: parent.id,
      delegatedPrompt: 'normalize empty child result',
      childConfig: {},
    })
    const terminalToolResult = await coordinator.spawn({
      parentSessionId: parent.id,
      delegatedPrompt: 'normalize terminal-tool child result',
      childConfig: {},
    })
    terminalChildSessionId = terminalToolResult.childSessionId
    const apiErrorResult = await coordinator.spawn({
      parentSessionId: parent.id,
      delegatedPrompt: 'normalize api-error child result',
      childConfig: {},
    })
    const non400ApiErrorResult = await coordinator.spawn({
      parentSessionId: parent.id,
      delegatedPrompt: 'normalize api-error-429 child result',
      childConfig: {},
    })

    let task = store.get(result.taskId)
    let recoverableToolTask = store.get(recoverableToolResult.taskId)
    let emptyTask = store.get(emptyResult.taskId)
    let terminalToolTask = store.get(terminalToolResult.taskId)
    let apiErrorTask = store.get(apiErrorResult.taskId)
    let non400ApiErrorTask = store.get(non400ApiErrorResult.taskId)
    for (let attempt = 0; attempt < 40 && (
      task?.runtimeState !== 'completed'
      || recoverableToolTask?.runtimeState !== 'completed'
      || emptyTask?.runtimeState !== 'completed'
      || terminalToolTask?.runtimeState !== 'failed'
      || apiErrorTask?.runtimeState !== 'failed'
      || non400ApiErrorTask?.runtimeState !== 'failed'
    ); attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
      task = store.get(result.taskId)
      recoverableToolTask = store.get(recoverableToolResult.taskId)
      emptyTask = store.get(emptyResult.taskId)
      terminalToolTask = store.get(terminalToolResult.taskId)
      apiErrorTask = store.get(apiErrorResult.taskId)
      non400ApiErrorTask = store.get(non400ApiErrorResult.taskId)
    }

    expect(task).toMatchObject({
      childSessionId: result.childSessionId,
      runtimeState: 'completed',
      result: {
        byteLength: Buffer.byteLength('normalized child result', 'utf8'),
      },
    })
    const childHistory = sessions.get(result.childSessionId).messages as Array<{ role: string; id: string }>
    const finalAssistant = childHistory.findLast((message) => message.role === 'assistant')
    expect(task?.result?.sourceMessageId).toBe(finalAssistant?.id)
    expect(recoverableToolTask).toMatchObject({
      childSessionId: recoverableToolResult.childSessionId,
      runtimeState: 'completed',
      result: {
        byteLength: Buffer.byteLength('normalized child result', 'utf8'),
      },
    })
    expect(emptyTask).toMatchObject({
      childSessionId: emptyResult.childSessionId,
      runtimeState: 'completed',
      result: { byteLength: 0, preview: '' },
    })
    expect(terminalToolTask).toMatchObject({
      childSessionId: terminalToolResult.childSessionId,
      runtimeState: 'failed',
      failure: { code: 'tool_error' },
    })
    expect(terminalLifecycleOrder).toEqual(['task-updated', 'session-complete'])
    expect(apiErrorTask).toMatchObject({
      childSessionId: apiErrorResult.childSessionId,
      runtimeState: 'failed',
      failure: { code: 'provider_error' },
    })
    expect(sessions.get(apiErrorResult.childSessionId).messages).toContainEqual(expect.objectContaining({
      role: 'error',
      errorCode: 'invalid_request',
      content: expect.stringContaining('Request Error'),
    }))
    expect(non400ApiErrorTask).toMatchObject({
      childSessionId: non400ApiErrorResult.childSessionId,
      runtimeState: 'failed',
      failure: { code: 'provider_error' },
    })
    expect(updates.map((change) => change.taskId).sort()).toEqual([
      result.taskId,
      recoverableToolResult.taskId,
      emptyResult.taskId,
      terminalToolResult.taskId,
      apiErrorResult.taskId,
      non400ApiErrorResult.taskId,
    ].sort())
    expect(sessions.get(result.childSessionId).sessionStatus).toBeUndefined()
    expect(sessions.get(recoverableToolResult.childSessionId).sessionStatus).toBeUndefined()
    expect(sessions.get(emptyResult.childSessionId).sessionStatus).toBeUndefined()
    expect(sessions.get(terminalToolResult.childSessionId).sessionStatus).toBeUndefined()
    expect(sessions.get(apiErrorResult.childSessionId).sessionStatus).toBeUndefined()
    expect(sessions.get(non400ApiErrorResult.childSessionId).sessionStatus).toBeUndefined()
  })

  it('continues ordinary session loading and retries startup reconciliation after a coordinator failure', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-session-manager-'))
    roots.push(workspaceRoot)
    const workspace = {
      id: 'workspace_spawn_startup_retry',
      name: 'Spawn startup retry workspace',
      rootPath: workspaceRoot,
      createdAt: Date.now(),
    }
    const configFile = join(CONFIG_DIR, 'config.json')
    const originalConfig = existsSync(configFile) ? readFileSync(configFile, 'utf8') : null
    const config = originalConfig
      ? JSON.parse(originalConfig) as { workspaces: Array<Record<string, unknown>>; activeWorkspaceId?: string | null; activeSessionId?: string | null }
      : { workspaces: [], activeWorkspaceId: null, activeSessionId: null }
    config.workspaces = (config.workspaces ?? []).filter((entry) => entry.id !== workspace.id)
    config.workspaces.push(workspace)
    writeFileSync(configFile, JSON.stringify(config, null, 2))

    try {
      await saveSession({
        id: 'session_survives_spawn_startup_failure',
        workspaceRootPath: workspaceRoot,
        name: 'Ordinary session survives startup failure',
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        messages: [],
        tokenUsage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          contextTokens: 0,
          costUsd: 0,
        },
      } as never)

      const initial = new SpawnTaskStore({ workspaceRoot, workspaceId: workspace.id })
      const reserved = initial.reserve({
        parentSessionId: 'session_startup_retry_parent',
        delegatedPrompt: 'Recover after a retryable startup failure.',
        childConfig: {},
      })
      const processing = initial.transition(reserved.taskId, {
        runtimeState: 'processing',
        at: '2026-08-16T16:00:00.000Z',
      })
      const interrupted = new SpawnTaskStore({
        workspaceRoot,
        workspaceId: workspace.id,
        faults: (point, task) => {
          if (point === 'before-current-publish' && task.runtimeState === 'completed') {
            throw new Error('startup retry publication interrupted')
          }
        },
      })
      expect(() => interrupted.commitResult(processing.taskId, 'reconcile on retry', {
        committedAt: '2026-08-16T16:00:01.000Z',
      })).toThrow('startup retry publication interrupted')

      let targetFactoryCalls = 0
      const updates: Array<{ taskId: string; version: number }> = []
      const failedStore = Object.create(SpawnTaskStore.prototype) as SpawnTaskStore
      ;(failedStore as any).getLastStartupReport = () => {
        throw new Error('injected startup reconciliation reload failure')
      }
      const manager = new SessionManager({
        spawnTaskStoreFactory: (options) => {
          if (options.workspaceRoot !== workspaceRoot) return new SpawnTaskStore(options)
          targetFactoryCalls += 1
          if (targetFactoryCalls === 1) return failedStore
          return new SpawnTaskStore(options)
        },
        spawnTaskUpdated: (change) => {
          updates.push(change)
        },
      })

      await expect((manager as any).loadSessionsFromDisk()).resolves.toBeUndefined()
      const loadedSessions = await manager.getSessions(workspace.id)
      expect(loadedSessions.map((session) => session.id)).toContain('session_survives_spawn_startup_failure')
      expect(targetFactoryCalls).toBe(1)

      const coordinator = (manager as any).getOrCreateSpawnTaskCoordinator(workspaceRoot, workspace.id)
      await coordinator.waitForStartupNotification()

      expect(targetFactoryCalls).toBe(2)
      const recovered = new SpawnTaskStore({ workspaceRoot, workspaceId: workspace.id }).get(processing.taskId)
      expect(recovered).toMatchObject({
        runtimeState: 'completed',
        result: {
          byteLength: Buffer.byteLength('reconcile on retry', 'utf8'),
        },
      })
      expect(updates).toEqual([{ taskId: processing.taskId, version: recovered!.version }])
    } finally {
      if (originalConfig === null) rmSync(configFile, { force: true })
      else writeFileSync(configFile, originalConfig)
    }
  })

  it('does not carry recoverable tool-failure evidence into a later turn', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-session-manager-'))
    roots.push(workspaceRoot)
    const workspace = {
      id: 'workspace_spawn_tool_evidence_reset',
      name: 'Spawn tool evidence reset workspace',
      rootPath: workspaceRoot,
      createdAt: Date.now(),
    }
    const store = new SpawnTaskStore({ workspaceRoot, workspaceId: workspace.id })
    const reserved = store.reserve({
      parentSessionId: 'session_tool_evidence_parent',
      delegatedPrompt: 'tool evidence reset',
      childConfig: {},
    })
    const processing = store.transition(reserved.taskId, {
      runtimeState: 'processing',
      at: '2026-08-16T16:00:00.000Z',
    })
    const manager = new SessionManager({ spawnTaskStoreFactory: () => store })
    manager.setEventSink(() => {})
    const services = createGitServices({
      worktreeRoot: join(workspaceRoot, 'worktrees'),
      registryPath: join(workspaceRoot, 'worktrees', 'registry.json'),
    })
    manager.setGitServices(services)
    services.lifecycle.markReady()

    let chatCalls = 0
    const child = createManagedSession(
      {
        id: processing.childSessionId,
        name: 'child',
        spawnTaskRef: {
          taskId: processing.taskId,
          parentSessionId: processing.parentSessionId,
        },
      },
      workspace as never,
      { messagesLoaded: true },
    )
    child.agent = {
      generateTitle: async () => 'Child title',
      setAllSources: () => {},
      getModel: () => 'test-model',
      getSessionId: () => undefined,
      async *chat() {
        chatCalls += 1
        if (chatCalls === 1) {
          yield {
            type: 'tool_result' as const,
            toolName: 'Bash',
            toolUseId: 'reset-tool-use',
            result: 'Error: recoverable first-turn failure',
            isError: true,
          }
          return
        }
        yield { type: 'complete' as const }
      },
    } as any
    const sessions = (manager as unknown as { sessions: Map<string, any> }).sessions
    sessions.set(child.id, child)
    ;(manager as any).getOrCreateAgent = async (managed: any) => managed.agent

    await manager.sendMessage(child.id, 'first turn')
    expect(store.get(processing.taskId)?.runtimeState).toBe('processing')
    expect(child.isProcessing).toBe(false)

    await manager.sendMessage(child.id, 'later turn')
    let completed = store.get(processing.taskId)
    for (let attempt = 0; attempt < 20 && completed?.runtimeState !== 'completed'; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
      completed = store.get(processing.taskId)
    }

    expect(chatCalls).toBe(2)
    expect(completed).toMatchObject({
      runtimeState: 'completed',
      result: { byteLength: 0, preview: '' },
    })
    expect(completed?.failure).toBeUndefined()
  })

  it('finalizes provider failures and defers recoverable tool failures', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-session-manager-'))
    roots.push(workspaceRoot)
    const workspace = {
      id: 'workspace_spawn_failure_integration',
      name: 'Spawn failure integration workspace',
      rootPath: workspaceRoot,
      createdAt: Date.now(),
    }
    const store = new SpawnTaskStore({ workspaceRoot, workspaceId: workspace.id })
    const reserveTask = (prompt: string) => {
      const reserved = store.reserve({ parentSessionId: 'session_parent', delegatedPrompt: prompt, childConfig: {} })
      return store.transition(reserved.taskId, {
        runtimeState: 'processing',
        at: '2026-08-16T16:00:00.000Z',
      })
    }
    const providerTask = reserveTask('provider failure')
    const toolTask = reserveTask('tool failure')
    const order: string[] = []
    const manager = new SessionManager({
      spawnTaskStoreFactory: () => store,
      spawnTaskUpdated: (change) => {
        const reloaded = new SpawnTaskStore({ workspaceRoot, workspaceId: workspace.id })
        expect(reloaded.get(change.taskId)?.runtimeState).toBe('failed')
        order.push(`task:${change.taskId}`)
      },
    })
    manager.setEventSink((_channel, _target, event) => order.push(`event:${(event as SessionEvent).type}`))
    const providerChild = createManagedSession(
      {
        id: providerTask.childSessionId,
        sessionStatus: 'review',
        spawnTaskRef: { taskId: providerTask.taskId, parentSessionId: providerTask.parentSessionId },
      },
      workspace as never,
      { messagesLoaded: true },
    )
    const toolChild = createManagedSession(
      {
        id: toolTask.childSessionId,
        sessionStatus: 'review',
        spawnTaskRef: { taskId: toolTask.taskId, parentSessionId: toolTask.parentSessionId },
      },
      workspace as never,
      { messagesLoaded: true },
    )
    providerChild.agent = {} as any
    toolChild.agent = {} as any
    providerChild.isProcessing = true
    toolChild.isProcessing = true
    const sessions = (manager as unknown as { sessions: Map<string, any> }).sessions
    sessions.set(providerChild.id, providerChild)
    sessions.set(toolChild.id, toolChild)

    await (manager as any).processEvent(providerChild, {
      type: 'error',
      message: 'provider failed permanently',
    })
    await (manager as any).processEvent(toolChild, {
      type: 'tool_result',
      toolUseId: 'tool_failure',
      toolName: 'Bash',
      result: 'Error: terminal tool failure',
      isError: true,
    })

    expect(store.get(providerTask.taskId)).toMatchObject({
      runtimeState: 'failed',
      failure: { code: 'provider_error' },
    })
    expect(store.get(toolTask.taskId)).toMatchObject({
      runtimeState: 'processing',
    })
    expect(order).toEqual([
      `task:${providerTask.taskId}`,
      'event:error',
      'event:tool_result',
    ])
    expect(providerChild.sessionStatus).toBe('review')
    expect(toolChild.sessionStatus).toBe('review')
    expect(providerChild.agent).not.toBeNull()
    expect(toolChild.agent).not.toBeNull()
  })

  it('surfaces startup task repair through the commit-before-invalidation seam', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-session-manager-'))
    roots.push(workspaceRoot)
    const workspace = {
      id: 'workspace_spawn_startup',
      name: 'Spawn startup workspace',
      rootPath: workspaceRoot,
      createdAt: Date.now(),
    }
    const initial = new SpawnTaskStore({ workspaceRoot, workspaceId: workspace.id })
    const reserved = initial.reserve({
      parentSessionId: 'session_startup_parent',
      delegatedPrompt: 'Recover startup result.',
      childConfig: {},
    })
    const processing = initial.transition(reserved.taskId, {
      runtimeState: 'processing',
      at: '2026-08-16T16:00:00.000Z',
    })
    const interrupted = new SpawnTaskStore({
      workspaceRoot,
      workspaceId: workspace.id,
      faults: (point, task) => {
        if (point === 'before-current-publish' && task.runtimeState === 'completed') {
          throw new Error('startup terminal publication interrupted')
        }
      },
    })
    expect(() => interrupted.commitResult(processing.taskId, 'startup result', {
      committedAt: '2026-08-16T16:00:01.000Z',
    })).toThrow('startup terminal publication interrupted')

    const updates: Array<{ taskId: string; version: number }> = []
    const manager = new SessionManager({
      spawnTaskUpdated: (change) => {
        const reloaded = new SpawnTaskStore({ workspaceRoot, workspaceId: workspace.id })
        expect(reloaded.get(change.taskId)).toMatchObject({
          runtimeState: 'completed',
          version: change.version,
          result: { byteLength: Buffer.byteLength('startup result', 'utf8') },
        })
        updates.push(change)
      },
    })

    const coordinator = (manager as any).getOrCreateSpawnTaskCoordinator(workspaceRoot, workspace.id)
    await coordinator.waitForStartupNotification()
    const completed = new SpawnTaskStore({ workspaceRoot, workspaceId: workspace.id }).get(processing.taskId)!

    expect(completed.runtimeState).toBe('completed')
    expect(updates).toEqual([{ taskId: processing.taskId, version: completed.version }])
  })

  it('keeps a spawned delegated message ID across automatic auth retry', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-session-manager-'))
    roots.push(workspaceRoot)
    const workspace = {
      id: 'workspace_spawn_auth_retry',
      name: 'Spawn auth retry workspace',
      rootPath: workspaceRoot,
      createdAt: Date.now(),
    }
    const manager = new SessionManager()
    const child = createManagedSession(
      {
        id: 'session_auth_retry_child',
        spawnTaskRef: {
          taskId: 'task_auth_retry',
          parentSessionId: 'session_auth_retry_parent',
        },
      },
      workspace as never,
      { messagesLoaded: true },
    )
    child.messages = [{
      id: 'message_stable_delegated',
      role: 'user',
      content: 'delegated work',
      timestamp: 1,
    }]
    child.lastSentMessage = 'delegated work'
    child.lastSentMessageId = 'message_stable_delegated'
    child.lastSentAttachments = []
    child.lastSentStoredAttachments = []
    child.agent = {} as any
    const sessions = (manager as unknown as { sessions: Map<string, any> }).sessions
    sessions.set(child.id, child)
    let retryMessageId: string | undefined
    ;(manager as any).sendMessage = async (...args: unknown[]) => {
      retryMessageId = args[5] as string | undefined
    }

    expect((manager as any).attemptAuthRetry(
      child.id,
      child,
      workspace.id,
      'invalid_api_key',
    )).toBe(true)
    await new Promise<void>((resolve) => setImmediate(resolve))
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(retryMessageId).toBe('message_stable_delegated')
    expect(child.messages).toHaveLength(1)
    expect(child.messages[0]?.id).toBe('message_stable_delegated')
    expect(child.messages[0]?.content).toBe('delegated work')
  })

  it('consumes async provider rejection with task and child context', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-session-manager-'))
    roots.push(workspaceRoot)
    const workspace = {
      id: 'workspace_spawn_test',
      name: 'Spawn test workspace',
      rootPath: workspaceRoot,
      createdAt: Date.now(),
    }
    const updated: Array<{ taskId: string; version: number }> = []
    const manager = new SessionManager({
      spawnTaskUpdated: (change) => {
        const reloaded = new SpawnTaskStore({
          workspaceRoot,
          workspaceId: workspace.id,
        })
        expect(reloaded.get(change.taskId)).toMatchObject({
          runtimeState: 'failed',
          version: change.version,
          failure: { code: 'provider_error' },
        })
        updated.push(change)
      },
    })
    manager.setEventSink(() => {})
    const parent = createManagedSession(
      { id: 'session_parent_rejection', name: 'parent' },
      workspace as never,
      { messagesLoaded: true },
    )
    const sessions = (manager as unknown as { sessions: Map<string, any> }).sessions
    sessions.set(parent.id, parent)
    const providerError = new Error('provider turn rejected')
    const unhandled: unknown[] = []
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandledRejection)

    try {
      ;(manager as any).createSession = async (_workspaceId: string, options: any) => {
        const child = createManagedSession(
          {
            id: options.reservedSessionId,
            name: options.name,
            spawnTaskRef: options.spawnTaskRef,
          },
          workspace as never,
          { messagesLoaded: true },
        )
        sessions.set(child.id, child)
        return { id: child.id, name: child.name }
      }
      ;(manager as any).sendMessage = () => Promise.reject(providerError)

      const coordinator = (manager as any).getSpawnTaskCoordinator(parent)
      const result = await coordinator.spawn({
        parentSessionId: parent.id,
        delegatedPrompt: 'provider rejection context',
        childConfig: {},
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
      await new Promise<void>((resolve) => setImmediate(resolve))

      const task = new SpawnTaskStore({
        workspaceRoot,
        workspaceId: workspace.id,
      }).get(result.taskId)
      expect(task).toMatchObject({
        childSessionId: result.childSessionId,
        runtimeState: 'failed',
        failure: {
          code: 'provider_error',
          message: providerError.message,
        },
      })
      expect(updated).toEqual([{ taskId: result.taskId, version: task!.version }])
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }
  })

  it('orchestrates the real child append and send boundary without changing session status', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-session-manager-'))
    roots.push(workspaceRoot)
    const workspace = {
      id: 'workspace_spawn_test',
      name: 'Spawn test workspace',
      rootPath: workspaceRoot,
      createdAt: Date.now(),
    }
    const manager = new SessionManager()
    manager.setEventSink(() => {})
    const parent = createManagedSession(
      { id: 'session_parent', name: 'parent' },
      workspace as never,
      { messagesLoaded: true },
    )
    const sessions = (manager as unknown as { sessions: Map<string, any> }).sessions
    sessions.set(parent.id, parent)
    const providerCalls: Array<[string, string, string | undefined]> = []

    ;(manager as any).createSession = async (_workspaceId: string, options: any) => {
      const child = createManagedSession(
        {
          id: options.reservedSessionId,
          name: options.name,
          sessionStatus: 'todo',
          spawnTaskRef: options.spawnTaskRef,
        },
        workspace as never,
        { messagesLoaded: true },
      )
      sessions.set(child.id, child)
      return { id: child.id, name: child.name, sessionStatus: child.sessionStatus }
    }
    ;(manager as any).sendMessage = async (
      childSessionId: string,
      prompt: string,
      _attachments: unknown,
      _storedAttachments: unknown,
      _options: unknown,
      existingMessageId: string,
    ) => {
      const persisted = loadSession(workspaceRoot, childSessionId)
      expect(persisted?.messages.some((message) => message.id === existingMessageId)).toBe(true)
      providerCalls.push([childSessionId, prompt, existingMessageId])
    }

    const coordinator = (manager as any).getSpawnTaskCoordinator(parent)
    const result = await coordinator.spawn({
      parentSessionId: parent.id,
      delegatedPrompt: 'orchestrated prompt',
      childConfig: { name: 'child' },
    })

    expect(Object.keys(result).sort()).toEqual([
      'childSessionId',
      'runtimeState',
      'taskId',
      'version',
    ])
    expect(providerCalls).toEqual([[
      result.childSessionId,
      'orchestrated prompt',
      expect.any(String),
    ]])
    const child = sessions.get(result.childSessionId)
    expect(child.sessionStatus).toBe('todo')
    expect(child.spawnTaskRef).toEqual({
      taskId: result.taskId,
      parentSessionId: parent.id,
    })
    expect(child.messages).toHaveLength(1)
    expect(child.messages[0]).toMatchObject({
      id: providerCalls[0]![2],
      role: 'user',
      content: 'orchestrated prompt',
    })
  })

  it('appends the stable delegated message ID at most once', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-session-manager-'))
    roots.push(workspaceRoot)
    const workspace = {
      id: 'workspace_spawn_test',
      name: 'Spawn test workspace',
      rootPath: workspaceRoot,
      createdAt: Date.now(),
    }
    const manager = new SessionManager()
    manager.setEventSink(() => {})
    const child = createManagedSession(
      { id: 'session_child' },
      workspace as never,
      { messagesLoaded: true },
    )
    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(child.id, child)

    const task = {
      taskId: 'task_spawn_test',
      childSessionId: child.id,
      dispatch: { messageId: 'message_spawn_test' },
    } as unknown as SpawnTask
    const append = (manager as unknown as {
      appendSpawnPrompt: (childSessionId: string, messageId: string, prompt: string, workspaceId: string) => Promise<void>
    }).appendSpawnPrompt.bind(manager)

    await append(child.id, task.dispatch.messageId, 'stable delegated prompt', workspace.id)
    await append(child.id, task.dispatch.messageId, 'stable delegated prompt', workspace.id)

    const stored = loadSession(workspaceRoot, child.id)
    expect(stored?.messages.filter((message) => message.id === task.dispatch.messageId)).toHaveLength(1)
    expect(stored?.messages[0]).toMatchObject({
      id: task.dispatch.messageId,
      type: 'user',
      content: 'stable delegated prompt',
    })
  })
})
