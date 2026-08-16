import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_DIR } from '@kata-sh/shared/config'
import { loadSession } from '@kata-sh/shared/sessions'
import type { SpawnTask } from '@kata-sh/core'
import { SessionManager, createManagedSession } from './SessionManager.ts'
import type { SpawnTaskCoordinator } from './spawn-task-coordinator.ts'

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
