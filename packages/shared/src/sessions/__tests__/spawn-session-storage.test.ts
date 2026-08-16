import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSession, loadSession, sessionPersistenceQueue } from '../storage.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('spawn child session persistence', () => {
  it('publishes the reserved child ID and private task back-reference durably', async () => {
    const root = mkdtempSync(join(tmpdir(), 'spawn-session-storage-'))
    roots.push(root)

    const created = await createSession(root, {
      reservedSessionId: 'session_reserved_child',
      spawnTaskRef: {
        taskId: 'task_reserved',
        parentSessionId: 'session_parent',
      },
    })

    expect(created.id).toBe('session_reserved_child')
    expect(created.spawnTaskRef).toEqual({
      taskId: 'task_reserved',
      parentSessionId: 'session_parent',
    })
    expect(loadSession(root, created.id)?.spawnTaskRef).toEqual(created.spawnTaskRef)
  })

  it('requires a private task back-reference for reserved child creation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'spawn-session-storage-'))
    roots.push(root)

    await expect(createSession(root, {
      reservedSessionId: 'session_without_reference',
    })).rejects.toThrow('back-reference')
  })

  it('rejects reserved child creation when the persistence queue does not publish it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'spawn-session-storage-'))
    roots.push(root)
    const queue = sessionPersistenceQueue as any
    const originalWrite = queue.write
    queue.write = async () => {}

    try {
      await expect(createSession(root, {
        reservedSessionId: 'session_unpublished_child',
        spawnTaskRef: {
          taskId: 'task_unpublished',
          parentSessionId: 'session_parent',
        },
      })).rejects.toThrow('did not persist')
    } finally {
      queue.write = originalWrite
    }

    expect(loadSession(root, 'session_unpublished_child')).toBeNull()
  })
})
