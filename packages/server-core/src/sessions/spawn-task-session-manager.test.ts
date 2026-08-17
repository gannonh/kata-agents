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
      const appendSpawnPrompt = (manager as any).appendSpawnPrompt.bind(manager)
      ;(manager as any).appendSpawnPrompt = async (...args: unknown[]) => {
        const childSessionId = args[0] as string
        const persistedBeforeAppend = loadSession(workspaceRoot, childSessionId)
        expect(persistedBeforeAppend).toMatchObject({
          llmConnection: 'conn_spawn_child',
          model: 'spawn-model',
          thinkingLevel: 'off',
          enabledSourceSlugs: ['src_spawn'],
          permissionMode: 'safe',
          labels: ['delegated'],
          workingDirectory: workspaceRoot,
        })
        return appendSpawnPrompt(...args)
      }
      const result = await coordinator.spawn({
        parentSessionId: parent.id,
        delegatedPrompt: 'persist the real child relationship',
        childConfig: {
          name: 'child',
          llmConnection: 'conn_spawn_child',
          model: 'spawn-model',
          thinkingLevel: 'off',
          enabledSourceSlugs: ['src_spawn'],
          permissionMode: 'safe',
          labels: ['delegated'],
          workingDirectory: workspaceRoot,
        },
      })

      const persistedChild = loadSession(workspaceRoot, result.childSessionId)
      expect(dispatchedTask?.childSessionId).toBe(result.childSessionId)
      expect(persistedChild).toMatchObject({
        id: result.childSessionId,
        name: 'child',
        llmConnection: 'conn_spawn_child',
        thinkingLevel: 'off',
        enabledSourceSlugs: ['src_spawn'],
        permissionMode: 'safe',
        labels: ['delegated'],
        workingDirectory: workspaceRoot,
        spawnTaskRef: {
          taskId: result.taskId,
          parentSessionId: parent.id,
        },
      })
      expect(persistedChild?.model).toBeTruthy()
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

  it('recovers a reserved child during startup without changing workflow status', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-session-manager-'))
    roots.push(workspaceRoot)
    const workspace = {
      id: 'workspace_spawn_recovery_integration',
      name: 'Spawn recovery integration workspace',
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
        id: 'session_recovery_parent',
        workspaceRootPath: workspaceRoot,
        name: 'Recovery parent',
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        sessionStatus: 'todo',
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
        parentSessionId: 'session_recovery_parent',
        delegatedPrompt: 'recover this child from startup',
        childConfig: { name: 'recovered child' },
      })
      const updates: Array<{ taskId: string; version: number }> = []
      const dispatched: string[] = []
      const manager = new SessionManager({
        spawnTaskUpdated: (change) => {
          updates.push(change)
        },
        spawnTaskDispatchProvider: ({ task }) => {
          dispatched.push(task.taskId)
        },
      })
      manager.setEventSink(() => {})

      await (manager as any).loadSessionsFromDisk()

      const recovered = new SpawnTaskStore({ workspaceRoot, workspaceId: workspace.id }).get(reserved.taskId)!
      const child = loadSession(workspaceRoot, reserved.childSessionId)
      expect(recovered).toMatchObject({
        runtimeState: 'processing',
        dispatch: { state: 'sent', messageId: reserved.dispatch.messageId },
      })
      expect(child).toMatchObject({
        id: reserved.childSessionId,
        spawnTaskRef: {
          taskId: reserved.taskId,
          parentSessionId: reserved.parentSessionId,
          delegatedPrompt: reserved.delegatedPrompt,
          childConfig: { name: 'recovered child' },
          messageId: reserved.dispatch.messageId,
          dispatchAttemptId: reserved.dispatch.dispatchAttemptId,
        },
      })
      expect(dispatched).toEqual([reserved.taskId])
      expect(updates.every((change) => Object.keys(change).sort().join(',') === 'taskId,version')).toBe(true)
      expect((await manager.getSession('session_recovery_parent'))?.sessionStatus).toBe('todo')
      const updatesAfterFirstRecovery = updates.length

      await (manager as any).loadSessionsFromDisk()
      expect(new SpawnTaskStore({ workspaceRoot, workspaceId: workspace.id }).get(reserved.taskId)?.failure).toBeUndefined()
      expect(dispatched).toEqual([reserved.taskId])
      expect(updates).toHaveLength(updatesAfterFirstRecovery)
    } finally {
      if (originalConfig === null) rmSync(configFile, { force: true })
      else writeFileSync(configFile, originalConfig)
    }
  })

  it('recovers ready-task attachments from durable child config', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-session-manager-'))
    roots.push(workspaceRoot)
    const workspace = {
      id: 'workspace_spawn_attachment_recovery',
      name: 'Spawn attachment recovery workspace',
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
      const notePath = join(workspaceRoot, 'note.txt')
      writeFileSync(notePath, 'note')
      await saveSession({
        id: 'session_attachment_parent',
        workspaceRootPath: workspaceRoot,
        name: 'Attachment parent',
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        sessionStatus: 'todo',
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
        parentSessionId: 'session_attachment_parent',
        delegatedPrompt: 'summarize the note',
        childConfig: {
          attachments: [{ path: notePath, name: 'note.txt' }],
        },
      })
      initial.updateDispatch(reserved.taskId, 'ready', '2026-08-16T16:00:01.000Z')
      await saveSession({
        id: reserved.childSessionId,
        workspaceRootPath: workspaceRoot,
        name: 'Attachment child',
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        sessionStatus: 'todo',
        spawnTaskRef: {
          taskId: reserved.taskId,
          parentSessionId: reserved.parentSessionId,
          delegatedPrompt: reserved.delegatedPrompt,
          childConfig: reserved.childConfig,
          messageId: reserved.dispatch.messageId,
          dispatchAttemptId: reserved.dispatch.dispatchAttemptId,
        },
        messages: [],
        tokenUsage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          contextTokens: 0,
          costUsd: 0,
        },
      } as never)
      let dispatchedAttachments: Array<{ path?: string; name?: string }> | undefined
      const manager = new SessionManager({
        spawnTaskDispatchProvider: ({ attachments }) => {
          dispatchedAttachments = attachments ? [...attachments] : undefined
        },
      })
      manager.setEventSink(() => {})

      await (manager as any).loadSessionsFromDisk()

      expect(dispatchedAttachments).toEqual([
        expect.objectContaining({ path: notePath, name: 'note.txt' }),
      ])
      expect(new SpawnTaskStore({ workspaceRoot, workspaceId: workspace.id }).get(reserved.taskId)).toMatchObject({
        runtimeState: 'processing',
        dispatch: { state: 'sent' },
      })
    } finally {
      if (originalConfig === null) rmSync(configFile, { force: true })
      else writeFileSync(configFile, originalConfig)
    }
  })

  it('recovers a reserved task with a partial on-disk child reference', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-session-manager-'))
    roots.push(workspaceRoot)
    const workspace = {
      id: 'workspace_spawn_partial_reference_recovery',
      name: 'Spawn partial reference recovery workspace',
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
      const parentSessionId = 'session_partial_reference_parent'
      await saveSession({
        id: parentSessionId,
        workspaceRootPath: workspaceRoot,
        name: 'Partial reference parent',
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        sessionStatus: 'todo',
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
        parentSessionId,
        delegatedPrompt: 'recover the partially persisted child',
        childConfig: { name: 'partial child' },
      })
      const childStatus = 'todo'
      await saveSession({
        id: reserved.childSessionId,
        workspaceRootPath: workspaceRoot,
        name: 'Partial child',
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        sessionStatus: childStatus,
        spawnTaskRef: {
          taskId: reserved.taskId,
          parentSessionId,
        },
        messages: [],
        tokenUsage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          contextTokens: 0,
          costUsd: 0,
        },
      } as never)

      const dispatched: Array<{ taskId: string; dispatchState: string; runtimeState: string }> = []
      const manager = new SessionManager({
        spawnTaskDispatchProvider: ({ task }) => {
          dispatched.push({
            taskId: task.taskId,
            dispatchState: task.dispatch.state,
            runtimeState: task.runtimeState,
          })
        },
      })
      manager.setEventSink(() => {})

      await (manager as any).loadSessionsFromDisk()

      const recovered = new SpawnTaskStore({ workspaceRoot, workspaceId: workspace.id }).get(reserved.taskId)!
      expect(recovered).toMatchObject({
        runtimeState: 'processing',
        dispatch: { state: 'sent' },
      })
      expect(recovered.failure).toBeUndefined()
      expect(dispatched).toEqual([{
        taskId: reserved.taskId,
        dispatchState: 'sent',
        runtimeState: 'processing',
      }])
      expect((await manager.getSessions(workspace.id)).filter((session) => session.id === reserved.childSessionId)).toHaveLength(1)
      expect((await manager.getSession(reserved.childSessionId))?.sessionStatus).toBe(childStatus)
      expect((await manager.getSession(parentSessionId))?.sessionStatus).toBe('todo')
    } finally {
      if (originalConfig === null) rmSync(configFile, { force: true })
      else writeFileSync(configFile, originalConfig)
    }
  })

  it('rejects contradictory optional child reference metadata during startup recovery', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-session-manager-'))
    roots.push(workspaceRoot)
    const workspace = {
      id: 'workspace_spawn_contradictory_reference_recovery',
      name: 'Spawn contradictory reference recovery workspace',
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
      const parentSessionId = 'session_contradictory_reference_parent'
      await saveSession({
        id: parentSessionId,
        workspaceRootPath: workspaceRoot,
        name: 'Contradictory reference parent',
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        sessionStatus: 'todo',
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
        parentSessionId,
        delegatedPrompt: 'reject contradictory recovery metadata',
        childConfig: { name: 'contradictory child' },
      })
      await saveSession({
        id: reserved.childSessionId,
        workspaceRootPath: workspaceRoot,
        name: 'Contradictory child',
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        sessionStatus: 'todo',
        spawnTaskRef: {
          taskId: reserved.taskId,
          parentSessionId,
          messageId: 'message_contradictory_reference',
        },
        messages: [],
        tokenUsage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          contextTokens: 0,
          costUsd: 0,
        },
      } as never)

      const dispatched: string[] = []
      const manager = new SessionManager({
        spawnTaskDispatchProvider: ({ task }) => {
          dispatched.push(task.taskId)
        },
      })
      manager.setEventSink(() => {})

      await (manager as any).loadSessionsFromDisk()

      const recovered = new SpawnTaskStore({ workspaceRoot, workspaceId: workspace.id }).get(reserved.taskId)!
      expect(recovered).toMatchObject({
        runtimeState: 'failed',
        failure: {
          code: 'spawn_persist_failed',
          details: { boundary: 'child' },
        },
      })
      expect(dispatched).toEqual([])
      expect((await manager.getSessions(workspace.id)).filter((session) => session.id === reserved.childSessionId)).toHaveLength(1)
      expect((await manager.getSession(reserved.childSessionId))?.sessionStatus).toBe('todo')
    } finally {
      if (originalConfig === null) rmSync(configFile, { force: true })
      else writeFileSync(configFile, originalConfig)
    }
  })

  it('reconstructs a failed task for a child back-reference whose task record is missing', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-session-manager-'))
    roots.push(workspaceRoot)
    const workspace = {
      id: 'workspace_spawn_missing_task_recovery',
      name: 'Spawn missing task recovery workspace',
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
      const reference = {
        taskId: 'task_missing_startup_record',
        parentSessionId: 'session_missing_task_parent',
        delegatedPrompt: 'do not lose this child history',
        childConfig: { model: 'fixture' },
        messageId: 'message_missing_startup_record',
        dispatchAttemptId: 'attempt_missing_startup_record',
      }
      const history: any[] = [{
        id: reference.messageId,
        role: 'user',
        content: reference.delegatedPrompt,
        timestamp: 1,
      }]
      await saveSession({
        id: 'session_missing_task_child',
        workspaceRootPath: workspaceRoot,
        name: 'Orphan child history',
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        sessionStatus: 'todo',
        spawnTaskRef: {
          ...reference,
          childSessionId: 'session_missing_task_child',
        },
        messages: history,
        tokenUsage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          contextTokens: 0,
          costUsd: 0,
        },
      } as never)
      const updates: Array<{ taskId: string; version: number }> = []
      const dispatched: string[] = []
      const manager = new SessionManager({
        spawnTaskUpdated: (change) => {
          updates.push(change)
        },
        spawnTaskDispatchProvider: ({ task }) => {
          dispatched.push(task.taskId)
        },
      })
      manager.setEventSink(() => {})

      await (manager as any).loadSessionsFromDisk()

      const recovered = new SpawnTaskStore({ workspaceRoot, workspaceId: workspace.id }).get(reference.taskId)
      expect(recovered).toMatchObject({
        runtimeState: 'failed',
        childSessionId: 'session_missing_task_child',
        delegatedPrompt: reference.delegatedPrompt,
        failure: {
          code: 'spawn_persist_failed',
          details: { boundary: 'recovery' },
        },
      })
      expect(dispatched).toEqual([])
      expect(updates).toEqual([{ taskId: reference.taskId, version: 1 }])
      expect(loadSession(workspaceRoot, 'session_missing_task_child')?.messages).toEqual(history)
      expect((await manager.getSession('session_missing_task_child'))?.sessionStatus).toBe('todo')
    } finally {
      if (originalConfig === null) rmSync(configFile, { force: true })
      else writeFileSync(configFile, originalConfig)
    }
  })

  it('exposes internal child cancellation without changing session status', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-session-manager-'))
    roots.push(workspaceRoot)
    const workspace = {
      id: 'workspace_spawn_cancel_api',
      name: 'Spawn cancel API workspace',
      rootPath: workspaceRoot,
      createdAt: Date.now(),
    }
    const store = new SpawnTaskStore({ workspaceRoot, workspaceId: workspace.id })
    const reserved = store.reserve({ parentSessionId: 'session_parent', delegatedPrompt: 'cancel API child', childConfig: {} })
    const processing = store.transition(reserved.taskId, { runtimeState: 'processing', at: '2026-08-16T16:00:00.000Z' })
    const manager = new SessionManager({ spawnTaskStoreFactory: () => store })
    const child = createManagedSession({
      id: processing.childSessionId,
      sessionStatus: 'review',
      spawnTaskRef: { taskId: processing.taskId, parentSessionId: processing.parentSessionId },
    }, workspace as never, { messagesLoaded: true })
    let abortCalls = 0
    child.agent = {
      forceAbort: () => {
        abortCalls += 1
      },
      dispose: () => {},
    } as any
    const sessions = (manager as unknown as { sessions: Map<string, any> }).sessions
    sessions.set(child.id, child)
    ;(manager as any).getSpawnTaskCoordinator(child)

    const result = await manager.cancelSpawnTask(processing.taskId, 'user_requested')

    expect(result).toMatchObject({
      status: 'cancelled',
      task: { runtimeState: 'cancelled', cancellation: { reason: 'user_requested' } },
    })
    expect(abortCalls).toBe(1)
    expect(child.agent).not.toBeNull()
    expect(child.sessionStatus).toBe('review')
  })

  it('resumes permission input without changing session status or agent activity', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-session-manager-'))
    roots.push(workspaceRoot)
    const workspace = {
      id: 'workspace_spawn_permission_resume',
      name: 'Spawn permission resume workspace',
      rootPath: workspaceRoot,
      createdAt: Date.now(),
    }
    const store = new SpawnTaskStore({ workspaceRoot, workspaceId: workspace.id })
    const reserved = store.reserve({
      parentSessionId: 'session_permission_parent',
      delegatedPrompt: 'permission child',
      childConfig: {},
    })
    const processing = store.transition(reserved.taskId, {
      runtimeState: 'processing',
      at: '2026-08-16T16:00:00.000Z',
    })
    let responded = 0
    const manager = new SessionManager({ spawnTaskStoreFactory: () => store })
    const child = createManagedSession(
      {
        id: processing.childSessionId,
        sessionStatus: 'review',
        spawnTaskRef: {
          taskId: processing.taskId,
          parentSessionId: processing.parentSessionId,
        },
      },
      workspace as never,
      { messagesLoaded: true },
    )
    child.agent = {
      respondToPermission: () => {
        responded += 1
      },
    } as any
    const sessions = (manager as unknown as { sessions: Map<string, any> }).sessions
    sessions.set(child.id, child)
    const pending = (manager as any).pendingPermissionRequests as Map<string, unknown>
    pending.set('permission_request', { sessionId: child.id, type: 'bash' })

    const entered = await (manager as any).enterSpawnTaskAwaitingInput(child, {
      kind: 'permission',
      requestId: 'permission_request',
      promptSummary: 'Allow Bash?',
    })
    expect(entered).toBe(true)
    expect(store.get(processing.taskId)?.runtimeState).toBe('awaiting-input')

    expect(manager.respondToPermission(child.id, 'permission_request', true, false)).toBe(true)
    for (let attempt = 0; attempt < 20 && store.get(processing.taskId)?.runtimeState !== 'processing'; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
    }

    expect(responded).toBe(1)
    expect(store.get(processing.taskId)?.runtimeState).toBe('processing')
    expect(child.sessionStatus).toBe('review')
    expect(child.agent).not.toBeNull()
  })

  it('resumes authentication input without changing session status', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-session-manager-'))
    roots.push(workspaceRoot)
    const workspace = {
      id: 'workspace_spawn_auth_resume',
      name: 'Spawn auth resume workspace',
      rootPath: workspaceRoot,
      createdAt: Date.now(),
    }
    const store = new SpawnTaskStore({ workspaceRoot, workspaceId: workspace.id })
    const reserved = store.reserve({
      parentSessionId: 'session_auth_parent',
      delegatedPrompt: 'authentication child',
      childConfig: {},
    })
    const processing = store.transition(reserved.taskId, {
      runtimeState: 'processing',
      at: '2026-08-16T16:00:00.000Z',
    })
    const manager = new SessionManager({ spawnTaskStoreFactory: () => store })
    const child = createManagedSession({
      id: processing.childSessionId,
      sessionStatus: 'todo',
      spawnTaskRef: {
        taskId: processing.taskId,
        parentSessionId: processing.parentSessionId,
      },
    }, workspace as never, { messagesLoaded: true })
    const sessions = (manager as unknown as { sessions: Map<string, any> }).sessions
    sessions.set(child.id, child)

    expect(await (manager as any).enterSpawnTaskAwaitingInput(child, {
      kind: 'authentication',
      requestId: 'auth_request_1',
      promptSummary: 'Sign in to the source.',
    })).toBe(true)
    expect(store.get(processing.taskId)).toMatchObject({
      runtimeState: 'awaiting-input',
      awaitingInput: { kind: 'authentication', requestId: 'auth_request_1' },
    })
    expect(await (manager as any).resumeSpawnTaskInput(child, 'auth_request_1')).toBe(true)
    expect(store.get(processing.taskId)?.runtimeState).toBe('processing')
    expect(child.sessionStatus).toBe('todo')
  })

  it('delivers the current authentication response exactly once', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-session-manager-'))
    roots.push(workspaceRoot)
    const workspace = {
      id: 'workspace_spawn_auth_success',
      name: 'Spawn auth success workspace',
      rootPath: workspaceRoot,
      createdAt: Date.now(),
    }
    const store = new SpawnTaskStore({ workspaceRoot, workspaceId: workspace.id })
    const reserved = store.reserve({ parentSessionId: 'session_parent', delegatedPrompt: 'auth success', childConfig: {} })
    const processing = store.transition(reserved.taskId, { runtimeState: 'processing', at: '2026-08-16T16:00:00.000Z' })
    const manager = new SessionManager({ spawnTaskStoreFactory: () => store })
    const child = createManagedSession({
      id: processing.childSessionId,
      spawnTaskRef: { taskId: processing.taskId, parentSessionId: processing.parentSessionId },
    }, workspace as never, { messagesLoaded: true })
    child.agent = {} as any
    child.messages.push({
      id: 'auth_message',
      role: 'auth-request',
      content: 'Sign in',
      timestamp: '2026-08-16T16:00:00.000Z',
      authRequestId: 'auth_current',
      authStatus: 'pending',
    } as any)
    const sessions = (manager as unknown as { sessions: Map<string, any> }).sessions
    sessions.set(child.id, child)
    const sentMessages: string[] = []
    ;(manager as any).sendMessage = async (_sessionId: string, content: string) => {
      sentMessages.push(content)
    }

    expect(await (manager as any).enterSpawnTaskAwaitingInput(child, {
      kind: 'authentication',
      requestId: 'auth_current',
      promptSummary: 'Sign in to the source.',
    })).toBe(true)
    await manager.completeAuthRequest(child.id, {
      requestId: 'auth_current',
      sourceSlug: '',
      success: true,
    } as any)

    expect(sentMessages).toHaveLength(1)
    expect(store.get(processing.taskId)?.runtimeState).toBe('processing')
    expect(child.messages.find((message: any) => message.authRequestId === 'auth_current')?.authStatus).toBe('completed')
  })

  it('fails awaiting permission when the provider rejects the response', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-session-manager-'))
    roots.push(workspaceRoot)
    const workspace = {
      id: 'workspace_spawn_permission_failure',
      name: 'Spawn permission failure workspace',
      rootPath: workspaceRoot,
      createdAt: Date.now(),
    }
    const store = new SpawnTaskStore({ workspaceRoot, workspaceId: workspace.id })
    const reserved = store.reserve({ parentSessionId: 'session_parent', delegatedPrompt: 'permission failure', childConfig: {} })
    const processing = store.transition(reserved.taskId, { runtimeState: 'processing', at: '2026-08-16T16:00:00.000Z' })
    const manager = new SessionManager({ spawnTaskStoreFactory: () => store })
    const child = createManagedSession({
      id: processing.childSessionId,
      spawnTaskRef: { taskId: processing.taskId, parentSessionId: processing.parentSessionId },
    }, workspace as never, { messagesLoaded: true })
    child.agent = {
      respondToPermission: () => {
        throw new Error('permission response channel closed')
      },
      forceAbort: () => {},
      dispose: () => {},
    } as any
    const sessions = (manager as unknown as { sessions: Map<string, any> }).sessions
    sessions.set(child.id, child)
    const pending = (manager as any).pendingPermissionRequests as Map<string, unknown>
    pending.set('permission_failure_request', { sessionId: child.id, type: 'bash' })

    expect(await (manager as any).enterSpawnTaskAwaitingInput(child, {
      kind: 'permission',
      requestId: 'permission_failure_request',
      promptSummary: 'Allow the tool?',
    })).toBe(true)
    expect(manager.respondToPermission(child.id, 'permission_failure_request', true, false)).toBe(false)
    for (let attempt = 0; attempt < 20 && store.get(processing.taskId)?.runtimeState !== 'failed'; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
    }

    expect(store.get(processing.taskId)).toMatchObject({
      runtimeState: 'failed',
      failure: { code: 'input_interrupted', retryable: true, details: { kind: 'permission' } },
    })
  })

  it('interrupts and unwinds a paused child for a stale permission response', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-session-manager-'))
    roots.push(workspaceRoot)
    const workspace = {
      id: 'workspace_spawn_permission_stale',
      name: 'Spawn stale permission workspace',
      rootPath: workspaceRoot,
      createdAt: Date.now(),
    }
    const store = new SpawnTaskStore({ workspaceRoot, workspaceId: workspace.id })
    const reserved = store.reserve({ parentSessionId: 'session_parent', delegatedPrompt: 'stale permission', childConfig: {} })
    const processing = store.transition(reserved.taskId, { runtimeState: 'processing', at: '2026-08-16T16:00:00.000Z' })
    const audits: string[] = []
    const manager = new SessionManager({
      spawnTaskStoreFactory: () => store,
      spawnTaskLateEvent: ({ currentState, eventKind }) => {
        audits.push(`${currentState}:${eventKind}`)
      },
    })
    const child = createManagedSession({
      id: processing.childSessionId,
      spawnTaskRef: { taskId: processing.taskId, parentSessionId: processing.parentSessionId },
    }, workspace as never, { messagesLoaded: true })
    let responseCalls: string[] = []
    let abortCalls = 0
    let disposeCalls = 0
    child.agent = {
      respondToPermission: (requestId: string) => {
        responseCalls.push(requestId)
      },
      forceAbort: () => {
        abortCalls += 1
      },
      dispose: () => {
        disposeCalls += 1
      },
    } as any
    child.isProcessing = true
    const sessions = (manager as unknown as { sessions: Map<string, any> }).sessions
    sessions.set(child.id, child)
    const pending = (manager as any).pendingPermissionRequests as Map<string, unknown>
    pending.set('permission_old', { sessionId: child.id, type: 'bash' })
    pending.set('permission_new', { sessionId: child.id, type: 'bash' })

    expect(await (manager as any).enterSpawnTaskAwaitingInput(child, {
      kind: 'permission',
      requestId: 'permission_old',
      promptSummary: 'Allow the first tool?',
    })).toBe(true)
    expect(await (manager as any).resumeSpawnTaskInput(child, 'permission_old')).toBe(true)
    expect(await (manager as any).enterSpawnTaskAwaitingInput(child, {
      kind: 'permission',
      requestId: 'permission_new',
      promptSummary: 'Allow the newer tool?',
    })).toBe(true)

    expect(manager.respondToPermission(child.id, 'permission_old', true, false)).toBe(false)
    for (let attempt = 0; attempt < 20 && store.get(processing.taskId)?.runtimeState !== 'failed'; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
    }

    expect(responseCalls).toEqual([])
    expect(abortCalls).toBe(1)
    expect(disposeCalls).toBe(1)
    expect(child.agent).toBeNull()
    expect(child.isProcessing).toBe(false)
    expect(store.get(processing.taskId)).toMatchObject({
      runtimeState: 'failed',
      failure: { code: 'input_interrupted', details: { kind: 'permission' } },
    })
    expect(audits).toContain('awaiting-input:permission_response')

    await (manager as any).processEvent(child, { type: 'error', message: 'late provider event' })
    expect(audits).toContain('failed:error')
    expect(manager.respondToPermission(child.id, 'permission_new', true, false)).toBe(false)
    expect(responseCalls).toEqual([])
  })

  it('interrupts and unwinds a paused child for a stale authentication response', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-session-manager-'))
    roots.push(workspaceRoot)
    const workspace = {
      id: 'workspace_spawn_auth_stale',
      name: 'Spawn stale auth workspace',
      rootPath: workspaceRoot,
      createdAt: Date.now(),
    }
    const store = new SpawnTaskStore({ workspaceRoot, workspaceId: workspace.id })
    const reserved = store.reserve({ parentSessionId: 'session_parent', delegatedPrompt: 'stale authentication', childConfig: {} })
    const processing = store.transition(reserved.taskId, { runtimeState: 'processing', at: '2026-08-16T16:00:00.000Z' })
    const audits: string[] = []
    const events: string[] = []
    const manager = new SessionManager({
      spawnTaskStoreFactory: () => store,
      spawnTaskLateEvent: ({ currentState, eventKind }) => {
        audits.push(`${currentState}:${eventKind}`)
      },
    })
    manager.setEventSink((channel) => {
      events.push(channel)
    })
    const child = createManagedSession({
      id: processing.childSessionId,
      spawnTaskRef: { taskId: processing.taskId, parentSessionId: processing.parentSessionId },
    }, workspace as never, { messagesLoaded: true })
    let abortCalls = 0
    let disposeCalls = 0
    child.agent = {
      forceAbort: () => {
        abortCalls += 1
      },
      dispose: () => {
        disposeCalls += 1
      },
    } as any
    child.isProcessing = true
    const sessions = (manager as unknown as { sessions: Map<string, any> }).sessions
    sessions.set(child.id, child)

    expect(await (manager as any).enterSpawnTaskAwaitingInput(child, {
      kind: 'authentication',
      requestId: 'auth_old',
      promptSummary: 'Sign in to the first source.',
    })).toBe(true)
    expect(await (manager as any).resumeSpawnTaskInput(child, 'auth_old')).toBe(true)
    expect(await (manager as any).enterSpawnTaskAwaitingInput(child, {
      kind: 'authentication',
      requestId: 'auth_new',
      promptSummary: 'Sign in to the newer source.',
    })).toBe(true)
    const messagesBefore = structuredClone(child.messages)

    await manager.completeAuthRequest(child.id, {
      requestId: 'auth_old',
      sourceSlug: 'source-old',
      success: true,
    } as any)

    expect(abortCalls).toBe(1)
    expect(disposeCalls).toBe(1)
    expect(child.agent).toBeNull()
    expect(child.isProcessing).toBe(false)
    expect(child.messages).toEqual(messagesBefore)
    expect(events).toEqual([])
    expect(store.get(processing.taskId)).toMatchObject({
      runtimeState: 'failed',
      failure: { code: 'input_interrupted', details: { kind: 'authentication' } },
    })
    expect(audits).toContain('awaiting-input:authentication_response')

    await manager.completeAuthRequest(child.id, {
      requestId: 'auth_new',
      sourceSlug: 'source-new',
      success: true,
    } as any)
    expect(events).toEqual([])
  })

  it('keeps input_interrupted durable when stale-response abort and cleanup fail', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-session-manager-'))
    roots.push(workspaceRoot)
    const workspace = {
      id: 'workspace_spawn_input_cleanup_failure',
      name: 'Spawn input cleanup failure workspace',
      rootPath: workspaceRoot,
      createdAt: Date.now(),
    }
    const store = new SpawnTaskStore({ workspaceRoot, workspaceId: workspace.id })
    const reserved = store.reserve({ parentSessionId: 'session_parent', delegatedPrompt: 'cleanup failure', childConfig: {} })
    const processing = store.transition(reserved.taskId, { runtimeState: 'processing', at: '2026-08-16T16:00:00.000Z' })
    const manager = new SessionManager({ spawnTaskStoreFactory: () => store })
    const child = createManagedSession({
      id: processing.childSessionId,
      spawnTaskRef: { taskId: processing.taskId, parentSessionId: processing.parentSessionId },
    }, workspace as never, { messagesLoaded: true })
    child.agent = {
      respondToPermission: () => {},
      forceAbort: () => {
        throw new Error('input abort failed')
      },
      dispose: () => {
        throw new Error('input cleanup failed')
      },
    } as any
    child.isProcessing = true
    const sessions = (manager as unknown as { sessions: Map<string, any> }).sessions
    sessions.set(child.id, child)
    const pending = (manager as any).pendingPermissionRequests as Map<string, unknown>
    pending.set('permission_old', { sessionId: child.id, type: 'bash' })
    pending.set('permission_new', { sessionId: child.id, type: 'bash' })

    expect(await (manager as any).enterSpawnTaskAwaitingInput(child, {
      kind: 'permission',
      requestId: 'permission_old',
      promptSummary: 'Allow the first tool?',
    })).toBe(true)
    expect(await (manager as any).resumeSpawnTaskInput(child, 'permission_old')).toBe(true)
    expect(await (manager as any).enterSpawnTaskAwaitingInput(child, {
      kind: 'permission',
      requestId: 'permission_new',
      promptSummary: 'Allow the newer tool?',
    })).toBe(true)

    expect(() => manager.respondToPermission(child.id, 'permission_old', true, false)).not.toThrow()
    for (let attempt = 0; attempt < 20 && store.get(processing.taskId)?.runtimeState !== 'failed'; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
    }

    expect(store.get(processing.taskId)).toMatchObject({
      runtimeState: 'failed',
      failure: { code: 'input_interrupted', details: { kind: 'permission' } },
    })
    expect(child.agent).toBeNull()
    expect(child.isProcessing).toBe(false)
  })

  it('makes terminal permission responses a no-op and audits them', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-session-manager-'))
    roots.push(workspaceRoot)
    const workspace = {
      id: 'workspace_spawn_permission_late',
      name: 'Spawn late permission workspace',
      rootPath: workspaceRoot,
      createdAt: Date.now(),
    }
    const store = new SpawnTaskStore({ workspaceRoot, workspaceId: workspace.id })
    const reserved = store.reserve({ parentSessionId: 'session_parent', delegatedPrompt: 'late permission', childConfig: {} })
    const processing = store.transition(reserved.taskId, { runtimeState: 'processing', at: '2026-08-16T16:00:00.000Z' })
    const audits: string[] = []
    const manager = new SessionManager({
      spawnTaskStoreFactory: () => store,
      spawnTaskLateEvent: ({ eventKind }) => {
        audits.push(eventKind)
      },
    })
    const child = createManagedSession({
      id: processing.childSessionId,
      spawnTaskRef: { taskId: processing.taskId, parentSessionId: processing.parentSessionId },
    }, workspace as never, { messagesLoaded: true })
    let responseCalls = 0
    child.agent = { respondToPermission: () => { responseCalls += 1 } } as any
    const sessions = (manager as unknown as { sessions: Map<string, any> }).sessions
    sessions.set(child.id, child)
    const pending = (manager as any).pendingPermissionRequests as Map<string, unknown>
    pending.set('late_permission_request', { sessionId: child.id, type: 'bash' })
    const coordinator = (manager as any).getSpawnTaskCoordinator(child)
    await coordinator.cancelChildSession(child.id, 'late_permission')

    expect(manager.respondToPermission(child.id, 'late_permission_request', true, false)).toBe(false)
    expect(responseCalls).toBe(0)
    expect(audits).toEqual(['permission_response'])
  })

  it('makes terminal authentication responses a no-op before auth side effects', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-session-manager-'))
    roots.push(workspaceRoot)
    const workspace = {
      id: 'workspace_spawn_auth_late',
      name: 'Spawn late auth workspace',
      rootPath: workspaceRoot,
      createdAt: Date.now(),
    }
    const store = new SpawnTaskStore({ workspaceRoot, workspaceId: workspace.id })
    const reserved = store.reserve({ parentSessionId: 'session_parent', delegatedPrompt: 'late auth', childConfig: {} })
    const processing = store.transition(reserved.taskId, { runtimeState: 'processing', at: '2026-08-16T16:00:00.000Z' })
    const events: string[] = []
    const manager = new SessionManager({ spawnTaskStoreFactory: () => store })
    manager.setEventSink((channel) => events.push(channel))
    const child = createManagedSession({
      id: processing.childSessionId,
      spawnTaskRef: { taskId: processing.taskId, parentSessionId: processing.parentSessionId },
    }, workspace as never, { messagesLoaded: true })
    child.pendingAuthRequest = { requestId: 'late_auth_request', sourceSlug: 'source', type: 'credential' } as any
    const sessions = (manager as unknown as { sessions: Map<string, any> }).sessions
    sessions.set(child.id, child)
    const coordinator = (manager as any).getSpawnTaskCoordinator(child)
    await coordinator.cancelChildSession(child.id, 'late_auth')
    const messagesBefore = structuredClone(child.messages)

    await manager.completeAuthRequest(child.id, {
      requestId: 'late_auth_request',
      sourceSlug: 'source',
      success: true,
    } as any)

    expect(child.messages).toEqual(messagesBefore)
    expect(events).toEqual([])
    expect(store.get(processing.taskId)?.runtimeState).toBe('cancelled')
  })

  it('ignores and audits late child events after terminal cancellation', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-session-manager-'))
    roots.push(workspaceRoot)
    const workspace = {
      id: 'workspace_spawn_late_events',
      name: 'Spawn late event workspace',
      rootPath: workspaceRoot,
      createdAt: Date.now(),
    }
    const store = new SpawnTaskStore({ workspaceRoot, workspaceId: workspace.id })
    const reserved = store.reserve({
      parentSessionId: 'session_late_parent',
      delegatedPrompt: 'late event child',
      childConfig: {},
    })
    const processing = store.transition(reserved.taskId, {
      runtimeState: 'processing',
      at: '2026-08-16T16:00:00.000Z',
    })
    const audits: string[] = []
    const updates: Array<{ taskId: string; version: number }> = []
    const manager = new SessionManager({
      spawnTaskStoreFactory: () => store,
      spawnTaskUpdated: (change) => {
        updates.push(change)
      },
      spawnTaskLateEvent: (event) => {
        audits.push(`${event.currentState}:${event.eventKind}`)
      },
    })
    manager.setEventSink(() => {})
    const child = createManagedSession(
      {
        id: processing.childSessionId,
        sessionStatus: 'review',
        spawnTaskRef: {
          taskId: processing.taskId,
          parentSessionId: processing.parentSessionId,
        },
      },
      workspace as never,
      { messagesLoaded: true },
    )
    child.agent = {} as any
    child.isProcessing = true
    const sessions = (manager as unknown as { sessions: Map<string, any> }).sessions
    sessions.set(child.id, child)
    const coordinator = (manager as any).getSpawnTaskCoordinator(child)
    const cancellation = await coordinator.cancelChildSession(child.id, 'late-event-test')
    const messageCount = child.messages.length

    await (manager as any).processEvent(child, { type: 'text_delta', text: 'late secret payload' })
    await (manager as any).processEvent(child, {
      type: 'tool_result',
      toolName: 'Bash',
      toolUseId: 'late-tool',
      result: 'late sensitive tool result',
      isError: true,
    })
    await (manager as any).processEvent(child, { type: 'error', message: 'late provider payload' })
    await (manager as any).processEvent(child, { type: 'complete' })

    expect(cancellation.status).toBe('cancelled')
    expect(store.get(processing.taskId)?.runtimeState).toBe('cancelled')
    expect(child.messages).toHaveLength(messageCount)
    expect(updates).toHaveLength(2)
    expect(audits).toEqual(['cancelled:text_delta', 'cancelled:tool_result', 'cancelled:error', 'cancelled:complete'])
    expect(child.sessionStatus).toBe('review')
  })

  it('persists parent deletion before session removal and preserves orphaned child work', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-session-manager-'))
    roots.push(workspaceRoot)
    const workspace = {
      id: 'workspace_spawn_parent_delete',
      name: 'Spawn parent delete workspace',
      rootPath: workspaceRoot,
      createdAt: Date.now(),
    }
    const store = new SpawnTaskStore({ workspaceRoot, workspaceId: workspace.id })
    const parentSessionId = 'session_parent_deleted'
    const reserved = store.reserve({ parentSessionId, delegatedPrompt: 'reserved child', childConfig: {} })
    const sentBase = store.reserve({ parentSessionId, delegatedPrompt: 'sent child', childConfig: {} })
    const sentReady = store.updateDispatch(sentBase.taskId, 'ready', '2026-08-16T16:00:01.000Z')
    const sentClaimed = store.updateDispatch(sentReady.taskId, 'claimed', '2026-08-16T16:00:02.000Z')
    const sent = store.updateDispatch(sentClaimed.taskId, 'sent', '2026-08-16T16:00:03.000Z')
    const processing = store.transition(sent.taskId, { runtimeState: 'processing', at: '2026-08-16T16:00:04.000Z' })
    const terminalBase = store.reserve({ parentSessionId, delegatedPrompt: 'terminal child', childConfig: {} })
    const terminalProcessing = store.transition(terminalBase.taskId, { runtimeState: 'processing', at: '2026-08-16T16:00:03.000Z' })
    const terminal = store.commitResult(terminalProcessing.taskId, 'terminal result', { committedAt: '2026-08-16T16:00:04.000Z' })
    const order: string[] = []
    const manager = new SessionManager({
      spawnTaskStoreFactory: () => store,
      spawnTaskUpdated: ({ taskId }) => {
        order.push(`task:${taskId}`)
      },
    })
    manager.setEventSink((_channel, _target, event) => {
      if (event.type === 'session_deleted') order.push(`session:${event.sessionId}`)
    })
    const services = createGitServices({
      worktreeRoot: join(workspaceRoot, 'worktrees'),
      registryPath: join(workspaceRoot, 'worktrees', 'registry.json'),
    })
    manager.setGitServices(services)
    services.lifecycle.markReady()
    const parent = createManagedSession({ id: parentSessionId, name: 'parent' }, workspace as never, { messagesLoaded: true })
    const orphanChild = createManagedSession({
      id: reserved.childSessionId,
      name: 'orphan child',
      spawnTaskRef: { taskId: reserved.taskId, parentSessionId },
    }, workspace as never, { messagesLoaded: true })
    const sessions = (manager as unknown as { sessions: Map<string, any> }).sessions
    sessions.set(parent.id, parent)
    sessions.set(orphanChild.id, orphanChild)
    const result = await manager.deleteSession(parent.id)

    expect(result.deleted).toBe(true)
    expect(sessions.has(parent.id)).toBe(false)
    expect(sessions.has(orphanChild.id)).toBe(true)
    expect(store.get(reserved.taskId)).toMatchObject({
      runtimeState: 'cancelled',
      cancellation: { reason: 'parent_deleted' },
      parentDeletedAt: expect.any(String),
    })
    expect(store.get(processing.taskId)).toMatchObject({
      runtimeState: 'processing',
      parentDeletedAt: expect.any(String),
    })
    expect(store.get(terminal.taskId)).toMatchObject({
      runtimeState: 'completed',
      parentDeletedAt: expect.any(String),
      result: { byteLength: Buffer.byteLength('terminal result', 'utf8') },
    })
    expect(order.at(-1)).toBe(`session:${parent.id}`)
  })

  it('does not tombstone spawned tasks when managed-worktree deletion is refused', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-session-manager-'))
    roots.push(workspaceRoot)
    const workspace = {
      id: 'workspace_spawn_delete_refused',
      name: 'Spawn delete refused workspace',
      rootPath: workspaceRoot,
      createdAt: Date.now(),
    }
    const store = new SpawnTaskStore({ workspaceRoot, workspaceId: workspace.id })
    const reserved = store.reserve({
      parentSessionId: 'session_parent_refused',
      delegatedPrompt: 'must remain queued',
      childConfig: {},
    })
    const manager = new SessionManager({ spawnTaskStoreFactory: () => store })
    manager.setEventSink(() => {})
    const services = createGitServices({
      worktreeRoot: join(workspaceRoot, 'worktrees'),
      registryPath: join(workspaceRoot, 'worktrees', 'registry.json'),
    })
    manager.setGitServices(services)
    services.lifecycle.markReady()
    const parent = createManagedSession(
      { id: 'session_parent_refused', name: 'parent' },
      workspace as never,
      { messagesLoaded: true },
    )
    parent.isProcessing = true
    parent.agent = {
      quiesceForTeardown: async () => {
        throw new Error('exit unconfirmed')
      },
      dispose: () => {},
    } as never
    const sessions = (manager as unknown as { sessions: Map<string, unknown> }).sessions
    sessions.set(parent.id, parent)

    const result = await manager.deleteSession(parent.id, { removeManagedWorktree: true })

    expect(result).toMatchObject({
      deleted: false,
      worktreeRemoval: {
        blocked: true,
        blockedReasonCode: 'agent_not_quiesced',
      },
    })
    expect(sessions.has(parent.id)).toBe(true)
    expect(store.isParentDeleted(parent.id)).toBe(false)
    expect(store.get(reserved.taskId)).toMatchObject({
      runtimeState: 'queued',
      dispatch: { state: 'reserved' },
    })
    expect(store.get(reserved.taskId)?.parentDeletedAt).toBeUndefined()
  })

  it('cancels active child before deletion and retains terminal child results', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'spawn-session-manager-'))
    roots.push(workspaceRoot)
    const workspace = {
      id: 'workspace_spawn_child_delete',
      name: 'Spawn child delete workspace',
      rootPath: workspaceRoot,
      createdAt: Date.now(),
    }
    const store = new SpawnTaskStore({ workspaceRoot, workspaceId: workspace.id })
    const activeReserved = store.reserve({ parentSessionId: 'session_parent', delegatedPrompt: 'active child', childConfig: {} })
    const active = store.transition(activeReserved.taskId, { runtimeState: 'processing', at: '2026-08-16T16:00:00.000Z' })
    const terminalReserved = store.reserve({ parentSessionId: 'session_parent', delegatedPrompt: 'terminal child', childConfig: {} })
    const terminalProcessing = store.transition(terminalReserved.taskId, { runtimeState: 'processing', at: '2026-08-16T16:00:00.000Z' })
    const terminal = store.commitResult(terminalProcessing.taskId, 'child result', { committedAt: '2026-08-16T16:00:01.000Z' })
    const manager = new SessionManager({ spawnTaskStoreFactory: () => store })
    manager.setEventSink(() => {})
    const services = createGitServices({
      worktreeRoot: join(workspaceRoot, 'worktrees'),
      registryPath: join(workspaceRoot, 'worktrees', 'registry.json'),
    })
    manager.setGitServices(services)
    services.lifecycle.markReady()
    let abortCalls = 0
    let disposeCalls = 0
    const activeChild = createManagedSession({
      id: active.childSessionId,
      spawnTaskRef: { taskId: active.taskId, parentSessionId: active.parentSessionId },
    }, workspace as never, { messagesLoaded: true })
    activeChild.agent = {
      forceAbort: () => {
        abortCalls += 1
        throw new Error('abort failed during child deletion')
      },
      dispose: () => {
        disposeCalls += 1
      },
    } as any
    const terminalChild = createManagedSession({
      id: terminal.childSessionId,
      spawnTaskRef: { taskId: terminal.taskId, parentSessionId: terminal.parentSessionId },
    }, workspace as never, { messagesLoaded: true })
    const sessions = (manager as unknown as { sessions: Map<string, any> }).sessions
    sessions.set(activeChild.id, activeChild)
    sessions.set(terminalChild.id, terminalChild)
    expect((await manager.deleteSession(activeChild.id)).deleted).toBe(true)
    expect((await manager.deleteSession(terminalChild.id)).deleted).toBe(true)

    expect(abortCalls).toBe(1)
    expect(disposeCalls).toBe(1)
    expect(store.get(active.taskId)).toMatchObject({
      runtimeState: 'failed',
      failure: { code: 'cancel_failed', retryable: false },
      childDeletedAt: expect.any(String),
    })
    expect(store.get(terminal.taskId)).toMatchObject({
      runtimeState: 'completed',
      childDeletedAt: expect.any(String),
      result: { byteLength: Buffer.byteLength('child result', 'utf8') },
    })
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
    expect(child.spawnTaskRef).toMatchObject({
      taskId: result.taskId,
      parentSessionId: parent.id,
      delegatedPrompt: 'orchestrated prompt',
      childConfig: { name: 'child' },
      messageId: providerCalls[0]![2],
      dispatchAttemptId: expect.any(String),
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
