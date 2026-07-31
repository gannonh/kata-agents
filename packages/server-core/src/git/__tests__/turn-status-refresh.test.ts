import { describe, test, expect, afterEach } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { SessionManager, createManagedSession } from '../../sessions/SessionManager'
import { makeTmpDir, cleanup } from './test-helpers'

const cleanups: string[] = []
function tmp(): string {
  const d = makeTmpDir()
  cleanups.push(d)
  return d
}
afterEach(() => {
  while (cleanups.length) cleanup(cleanups.pop()!)
})

function injectSession(sm: SessionManager, id: string, workspaceRootPath: string) {
  const workspace = { id: 'ws_test', name: 'WS', rootPath: workspaceRootPath, createdAt: Date.now() }
  mkdirSync(join(workspaceRootPath, 'sessions', id), { recursive: true })
  const managed = createManagedSession(
    { id, sdkCwd: join(workspaceRootPath, 'sessions', id) },
    workspace as any,
    { messagesLoaded: true, createdAt: Date.now() },
  )
  ;(sm as any).sessions.set(id, managed)
  return managed
}

describe('SessionManager agent-turn Git status refresh', () => {
  test('requests a status refresh for the session when a turn completes', async () => {
    const sm = new SessionManager()
    const wsRoot = tmp()
    injectSession(sm, 'sess1', wsRoot)

    const refreshed: string[] = []
    sm.setGitStatusRefresher((sessionId) => refreshed.push(sessionId))

    // Simulate the agent loop stopping at the end of a turn.
    await (sm as any).onProcessingStopped('sess1', 'complete')

    expect(refreshed).toContain('sess1')
  })

  test('does not throw when no refresher is installed', async () => {
    const sm = new SessionManager()
    const wsRoot = tmp()
    injectSession(sm, 'sess2', wsRoot)

    // No setGitStatusRefresher call — turn completion must still succeed.
    await (sm as any).onProcessingStopped('sess2', 'complete')
    expect(true).toBe(true)
  })
})
