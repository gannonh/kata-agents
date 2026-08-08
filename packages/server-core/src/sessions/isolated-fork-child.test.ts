import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Import the config module FIRST so the bound CONFIG_DIR is whatever this
// worker process actually uses (bun test may share a process across files).
// The test temporarily registers its workspace in that config file and
// restores the original bytes (or absence) afterwards — never leaving a trace.
const { SessionManager, createManagedSession } = await import('./SessionManager')
const { CONFIG_DIR } = await import('@kata-sh/shared/config')
const { createGitServices } = await import('../git')
const { initRepo, makeTmpDir, cleanup } = await import('../git/__tests__/test-helpers')
const { createDeterministicStrictForkAdapter } = await import('@kata-sh/shared/agent/backend')
const {
  saveSession: saveStoredSession,
  loadSession: loadStoredSession,
  getSessionFilePath,
} = await import('@kata-sh/shared/sessions/storage')
const { CodedError, WORKTREE_FORK_PENDING_CODE } = await import('@kata-sh/shared/protocol')

/**
 * SessionManager-level coverage for Phase 4 Task 3c: the wired fork hooks
 * create a durable pending isolated-fork child through the real createSession
 * branch path — messages copied through the fork point, TARGET checkout bound,
 * pendingFork intent persisted, no agent created, source untouched — plus the
 * Send fence on published-but-unestablished pending children.
 */
describe('SessionManager isolated fork child creation', () => {
  let root: string
  let repo: string
  let sm: InstanceType<typeof SessionManager>
  let services: ReturnType<typeof createGitServices>
  /** Original config-file bytes (or null when absent) restored in afterEach. */
  let originalConfig: string | null

  const configFile = join(CONFIG_DIR, 'config.json')
  const previousV1 = process.env.KATA_FEATURE_GIT_WORKSPACE_V1
  const previousV2 = process.env.KATA_FEATURE_WORKTREE_V2

  beforeEach(async () => {
    process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = '1'
    process.env.KATA_FEATURE_WORKTREE_V2 = '1'
    root = makeTmpDir('kata-fork-child-')
    repo = join(root, 'repo')
    await initRepo(repo)
    // Register the test workspace in the config file this process actually
    // reads, preserving everything else byte-for-byte for the afterEach.
    originalConfig = existsSync(configFile) ? readFileSync(configFile, 'utf8') : null
    const config = originalConfig
      ? (JSON.parse(originalConfig) as { workspaces: unknown[] })
      : { workspaces: [], activeWorkspaceId: null, activeSessionId: null }
    config.workspaces = (config.workspaces ?? []).filter(
      (w) => (w as { id?: string }).id !== 'ws_test',
    )
    config.workspaces.push({
      id: 'ws_test',
      name: 'WS',
      slug: 'ws-test',
      rootPath: root,
      createdAt: Date.now(),
    })
    writeFileSync(configFile, JSON.stringify(config, null, 2))
    sm = new SessionManager()
    services = createGitServices({
      worktreeRoot: join(root, 'worktrees'),
      registryPath: join(root, 'worktrees', 'registry.json'),
    })
    sm.setGitServices(services)
    services.lifecycle.markReady()
  })

  afterEach(() => {
    if (previousV1 === undefined) delete process.env.KATA_FEATURE_GIT_WORKSPACE_V1
    else process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = previousV1
    if (previousV2 === undefined) delete process.env.KATA_FEATURE_WORKTREE_V2
    else process.env.KATA_FEATURE_WORKTREE_V2 = previousV2
    // Restore the config file exactly (or remove it when it did not exist).
    try {
      if (originalConfig === null) rmSync(configFile, { force: true })
      else writeFileSync(configFile, originalConfig)
    } catch {
      // Best-effort: the test workspace entry is additive and harmless.
    }
    cleanup(root)
  })

  function injectSession(id: string): void {
    const workspace = { id: 'ws_test', name: 'WS', rootPath: root, createdAt: Date.now() }
    const managed = createManagedSession(
      {
        id,
        name: `Session ${id}`,
        sdkCwd: join(root, 'sessions', id),
        sdkSessionId: 'sdk-parent-1',
        workingDirectory: repo,
      } as never,
      workspace as never,
      { messagesLoaded: true },
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
  }

  /** Persist a source session with a user + assistant message (head = msg-2). */
  async function persistSourceWithMessages(id: string): Promise<void> {
    const stored = {
      id,
      workspaceRootPath: root,
      name: 'source',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      sdkCwd: join(root, 'sessions', id),
      sdkSessionId: 'sdk-parent-1',
      workingDirectory: repo,
      messages: [
        { id: 'msg-1', type: 'user' as const, content: 'first', timestamp: Date.now() - 1000 },
        { id: 'msg-2', type: 'assistant' as const, content: 'second', timestamp: Date.now() },
      ],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    } as never
    await saveStoredSession(stored)
    // Mirror the same messages on the runtime session: createSession flushes
    // the managed session to disk before branch validation, so the in-memory
    // list is the authoritative source.
    const managed = (sm as unknown as { sessions: Map<string, unknown> }).sessions.get(id) as {
      messages?: unknown[]
    }
    managed.messages = [
      { id: 'msg-1', role: 'user', content: 'first', timestamp: Date.now() - 1000 },
      { id: 'msg-2', role: 'assistant', content: 'second', timestamp: Date.now() },
    ]
  }

  /** Advertise a strict fork capability for a session (deterministic adapter). */
  function armStrictAdapter(sessionId: string): void {
    const managed = (sm as unknown as { sessions: Map<string, unknown> }).sessions.get(sessionId) as {
      agent?: unknown
    }
    managed.agent = { conversationFork: createDeterministicStrictForkAdapter({ adapterId: 'pi-test' }) }
  }

  it('confirm through the wired hooks creates a durable pending child: target-bound, pendingFork persisted, no agent', async () => {
    injectSession('source-1')
    await persistSourceWithMessages('source-1')
    armStrictAdapter('source-1')
    services.pathLeases.lease('source-1', realpathSync(repo))

    const preview = await services.fork.preview({
      sessionId: 'source-1',
      strategy: 'isolated-worktree',
      worktreeNameSuffix: 'fork-demo',
    })
    expect(preview.blocked).toBeUndefined()
    if (preview.blocked) return

    const result = await services.fork.confirm({
      sessionId: 'source-1',
      strategy: 'isolated-worktree',
      transactionId: preview.transactionId,
      previewFingerprint: preview.previewFingerprint,
      worktreeNameSuffix: 'fork-demo',
    })
    expect(result.outcome).toBe('committed')
    if (result.outcome !== 'committed') return

    // The child is a real runtime session with the TARGET checkout bound.
    const sessions = sm.getSessions()
    const child = sessions.find((s) => s.id === result.summary.sessionId)
    expect(child).toBeDefined()
    expect(child?.checkout).toMatchObject({
      mode: 'managed-worktree',
      expectedBranch: 'kata-agent/fork-demo',
    })
    expect(child?.workingDirectory).toBe(child?.checkout?.checkoutPath)
    const childManaged = (sm as unknown as { sessions: Map<string, unknown> }).sessions.get(
      result.summary.sessionId,
    ) as { sdkCwd?: string }
    expect(childManaged?.sdkCwd).toBe(child?.checkout?.checkoutPath)
    // No agent until first Send (Task 4).
    const managed = (sm as unknown as { sessions: Map<string, unknown> }).sessions.get(
      result.summary.sessionId,
    ) as {
      agent?: unknown
      pendingFork?: unknown
      checkoutStrategy?: string
    }
    // No agent until first Send (Task 4): the field is null-initialized.
    expect(managed.agent == null).toBe(true)
    expect(managed.checkoutStrategy).toBe('isolated')

    // The durable record carries the pending provider-fork intent with strict
    // parent identity and NO child provider ID, plus checkout provenance.
    const stored = loadStoredSession(root, result.summary.sessionId)
    expect(stored).toBeDefined()
    expect(stored?.pendingFork).toMatchObject({
      transactionId: preview.transactionId,
      parentSessionId: 'source-1',
      transcriptCwd: join(root, 'sessions', 'source-1'),
      executionCwd: child?.checkout?.checkoutPath,
      idempotencyKey: expect.any(String),
    })
    expect('childSdkSessionId' in (stored?.pendingFork ?? {})).toBe(false)
    expect(stored?.checkoutStrategy).toBe('isolated')
    expect(stored?.messages.map((m) => m.id)).toEqual(['msg-1', 'msg-2'])

    // The source session is untouched: same message ids, no checkout/pendingFork.
    const source = loadStoredSession(root, 'source-1')
    expect(source?.messages.map((m) => m.id)).toEqual(['msg-1', 'msg-2'])
    // The injected source carries checkout: null; pendingFork is child-only.
    expect(source?.checkout == null).toBe(true)
    expect(source?.pendingFork).toBeUndefined()
  })

  it('fences Send on a published-but-unestablished pending child with the typed pending code', async () => {
    injectSession('source-2')
    await persistSourceWithMessages('source-2')
    armStrictAdapter('source-2')
    services.pathLeases.lease('source-2', realpathSync(repo))

    const preview = await services.fork.preview({
      sessionId: 'source-2',
      strategy: 'isolated-worktree',
      worktreeNameSuffix: 'fenced-child',
    })
    expect(preview.blocked).toBeUndefined()
    if (preview.blocked) return
    const result = await services.fork.confirm({
      sessionId: 'source-2',
      strategy: 'isolated-worktree',
      transactionId: preview.transactionId,
      previewFingerprint: preview.previewFingerprint,
      worktreeNameSuffix: 'fenced-child',
    })
    expect(result.outcome).toBe('committed')
    if (result.outcome !== 'committed') return

    await expect(
      sm.sendMessage(result.summary.sessionId, 'hello from the pending child'),
    ).rejects.toMatchObject({ code: WORKTREE_FORK_PENDING_CODE })

    // No user message was persisted by the fenced Send.
    const file = getSessionFilePath(root, result.summary.sessionId)
    if (existsSync(file)) {
      const lines = readFileSync(file, 'utf-8').trim().split('\n').slice(1)
      expect(lines.filter((line) => line.includes('hello from the pending child'))).toHaveLength(0)
    }
  })

  it('deleteSession cancels a pending preview and blocks an in-progress confirm (recovery-required stays deletable by the state guard)', async () => {
    injectSession('source-3')
    await persistSourceWithMessages('source-3')
    armStrictAdapter('source-3')
    services.pathLeases.lease('source-3', realpathSync(repo))

    // Pending preview: deletion cancels it and the session goes away.
    const preview = await services.fork.preview({
      sessionId: 'source-3',
      strategy: 'isolated-worktree',
      worktreeNameSuffix: 'deletable-preview',
    })
    expect(preview.blocked).toBeUndefined()
    if (preview.blocked) return
    const deleted = await sm.deleteSession('source-3')
    expect(deleted.deleted).toBe(true)
    expect(
      services.journal
        .entries()
        .find((e) => e.recordId === preview.transactionId)?.commitMarker,
    ).toBe('preview-cancelled')
    // Release the deleted session's path lease so the next source preview is
    // not blocked as a foreign lease holder.
    services.pathLeases.releaseSession('source-3')

    // In-progress confirm: deletion is blocked with the typed pending code.
    injectSession('source-4')
    await persistSourceWithMessages('source-4')
    armStrictAdapter('source-4')
    services.pathLeases.lease('source-4', realpathSync(repo))
    const preview4 = await services.fork.preview({
      sessionId: 'source-4',
      strategy: 'isolated-worktree',
      worktreeNameSuffix: 'inprogress-delete',
    })
    expect(preview4.blocked).toBeUndefined()
    if (preview4.blocked) return
    // Drive the durable entry into a genuinely in-flight state: the metadata
    // still reads pending, but the durable steps make cancel refuse and the
    // deletion must block rather than delete the source mid-confirm.
    const entry = services.journal
      .entries()
      .find((e) => e.recordId === preview4.transactionId)!
    services.journal.step(entry.journalId, 'locks-acquired')
    await expect(sm.deleteSession('source-4')).rejects.toMatchObject({
      code: WORKTREE_FORK_PENDING_CODE,
    })
    // The source survives.
    expect(sm.getSessions().some((s) => s.id === 'source-4')).toBe(true)
  })
})
