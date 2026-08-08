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
const { initRepo, makeTmpDir, cleanup, git } = await import('../git/__tests__/test-helpers')
const { createDeterministicStrictForkAdapter } = await import('@kata-sh/shared/agent/testing')
import type { ConversationForkEstablishInput, StrictConversationForkCapability } from '@kata-sh/shared/agent/backend'
const {
  saveSession: saveStoredSession,
  loadSession: loadStoredSession,
  getSessionFilePath,
} = await import('@kata-sh/shared/sessions/storage')
const { WORKTREE_FORK_PENDING_CODE, WORKTREE_FORK_ERROR_CODE } = await import('@kata-sh/shared/protocol')

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

  function injectSession(id: string): ReturnType<typeof createManagedSession> {
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
    return managed
  }

  /** Inject a session that still satisfies the empty-session checkout gate. */
  function injectEmptySession(id: string): ReturnType<typeof createManagedSession> {
    const managed = injectSession(id)
    delete (managed as unknown as { sdkSessionId?: string }).sdkSessionId
    return managed
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
        { id: 'msg-1', type: 'user' as const, content: 'first', timestamp: Date.now() - 1000, turnId: 'turn-1' },
        { id: 'msg-2', type: 'assistant' as const, content: 'second', timestamp: Date.now(), turnId: 'turn-2' },
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
      { id: 'msg-1', role: 'user', content: 'first', timestamp: Date.now() - 1000, turnId: 'turn-1' },
      { id: 'msg-2', role: 'assistant', content: 'second', timestamp: Date.now(), turnId: 'turn-2' },
    ]
  }

  /** Advertise a strict fork capability for a session (deterministic adapter). */
  function armStrictAdapter(sessionId: string): void {
    const managed = (sm as unknown as { sessions: Map<string, unknown> }).sessions.get(sessionId) as {
      agent?: unknown
    }
    managed.agent = { conversationFork: createDeterministicStrictForkAdapter({ adapterId: 'pi-test' }) }
  }

  /**
   * Arm a pending child's agent with the deterministic strict fork adapter
   * plus a minimal chat() that records dispatched messages. Mirrors the real
   * flow where the establish path creates the agent through getOrCreateAgent
   * (the harness cannot build a live backend without a configured platform).
   */
  function armChildAgent(
    sessionId: string,
    adapter: StrictConversationForkCapability,
    chatCalls: string[],
  ): void {
    const managed = (sm as unknown as { sessions: Map<string, unknown> }).sessions.get(sessionId) as {
      agent?: unknown
    }
    managed.agent = {
      conversationFork: adapter,
      chat: async function* (message: string) {
        chatCalls.push(message)
      },
      setAllSources: () => undefined,
      getModel: () => 'test-model',
      generateTitle: async () => undefined,
      isProcessing: () => false,
    } as never
  }

  /** Persisted user messages whose content contains the given text. */
  function persistedMessageCount(sessionId: string, content: string): number {
    const file = getSessionFilePath(root, sessionId)
    if (!existsSync(file)) return 0
    const lines = readFileSync(file, 'utf-8').trim().split('\n').slice(1)
    return lines.filter((line) => line.includes(content)).length
  }

  /**
   * Record EVERY establishNativeFork call (including throwing ones) so tests
   * can assert call counts and the persisted idempotency key on both attempts.
   */
  function countingAdapter(
    adapter: StrictConversationForkCapability,
    callLog: Array<{ input: ConversationForkEstablishInput }>,
  ): StrictConversationForkCapability {
    const establishNativeFork = adapter.establishNativeFork.bind(adapter)
    return {
      ...adapter,
      establishNativeFork: async (input: ConversationForkEstablishInput) => {
        callLog.push({ input })
        return establishNativeFork(input)
      },
    }
  }

  /** Confirm an isolated fork for the last injected source and return the child id. */
  async function confirmChild(sourceId: string, suffix: string): Promise<string> {
    services.pathLeases.lease(sourceId, realpathSync(repo))
    const preview = await services.fork.preview({
      sessionId: sourceId,
      strategy: 'isolated-worktree',
      worktreeNameSuffix: suffix,
    })
    expect(preview.blocked).toBeUndefined()
    if (preview.blocked) return ''
    const result = await services.fork.confirm({
      sessionId: sourceId,
      strategy: 'isolated-worktree',
      transactionId: preview.transactionId,
      previewFingerprint: preview.previewFingerprint,
      worktreeNameSuffix: suffix,
    })
    expect(result.outcome).toBe('committed')
    if (result.outcome !== 'committed') return ''
    return result.summary.sessionId
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

  it('rejects Send on a published-but-unestablished pending child with no establishable adapter: typed fork error, no fallback, message persisted once', async () => {
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

    // A child whose created agent carries NO strict fork adapter: the
    // establish flow is a typed failure with no fallback to shared/
    // full-history/fresh behavior. The user message stays persisted exactly
    // once and the pendingFork intent survives for a visible retry.
    const chatCalls: string[] = []
    armChildAgent(result.summary.sessionId, {} as StrictConversationForkCapability, chatCalls)

    await expect(
      sm.sendMessage(result.summary.sessionId, 'hello from the pending child'),
    ).rejects.toMatchObject({ code: WORKTREE_FORK_ERROR_CODE })

    // The user message was persisted exactly once; no chat was dispatched.
    expect(persistedMessageCount(result.summary.sessionId, 'hello from the pending child')).toBe(1)
    expect(chatCalls).toHaveLength(0)
    const stored = loadStoredSession(root, result.summary.sessionId)
    expect(stored?.pendingFork).toBeDefined()
    expect(stored?.sdkSessionId).toBeUndefined()
    // No provider call happened, so no orphan is recorded.
    expect(services.forkOrphans.entries()).toHaveLength(0)
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

  it('first Send of a pending child establishes the native fork with the persisted idempotency key, persists the child provider ID, and retires pendingFork', async () => {
    injectSession('source-5')
    await persistSourceWithMessages('source-5')
    armStrictAdapter('source-5')
    const childId = await confirmChild('source-5', 'established-child')
    if (!childId) return

    // The child is published pending with a durable anchor and NO child provider ID.
    const pendingBefore = loadStoredSession(root, childId)!.pendingFork!
    expect(pendingBefore.parentSdkSessionId).toBe('sdk-parent-1')
    expect(pendingBefore.parentSdkTurnId).toBe('turn-2')
    expect(pendingBefore.idempotencyKey).toBeTruthy()

    const establishLog: Array<{ input: ConversationForkEstablishInput; childSdkSessionId: string }> = []
    const chatCalls: string[] = []
    armChildAgent(
      childId,
      createDeterministicStrictForkAdapter({
        adapterId: 'pi-test',
        childSdkSessionId: 'sdk-child-1',
        establishLog,
      }),
      chatCalls,
    )

    await sm.sendMessage(childId, 'hello from the child')

    // Establish called exactly once with the PERSISTED key + parent identity + cwds.
    expect(establishLog).toHaveLength(1)
    expect(establishLog[0]!.input).toMatchObject({
      parentSdkSessionId: 'sdk-parent-1',
      parentSdkTurnId: 'turn-2',
      idempotencyKey: pendingBefore.idempotencyKey,
      executionCwd: pendingBefore.executionCwd,
      transcriptCwd: pendingBefore.transcriptCwd,
    })

    // Child provider ID persisted on stored + managed; pendingFork retired; strategy stays 'isolated'.
    const storedAfter = loadStoredSession(root, childId)!
    expect(storedAfter.sdkSessionId).toBe('sdk-child-1')
    expect(storedAfter.pendingFork).toBeUndefined()
    expect(storedAfter.checkoutStrategy).toBe('isolated')
    const managedAfter = (sm as unknown as { sessions: Map<string, unknown> }).sessions.get(childId) as {
      sdkSessionId?: string
      pendingFork?: unknown
    }
    expect(managedAfter.sdkSessionId).toBe('sdk-child-1')
    expect(managedAfter.pendingFork).toBeUndefined()

    // The user message was dispatched to the agent chat and persisted exactly once.
    expect(chatCalls).toEqual(['hello from the child'])
    expect(persistedMessageCount(childId, 'hello from the child')).toBe(1)

    // The fork journal records the establishment (metadata-only on the committed entry).
    const entry = services.journal
      .entries()
      .find((e) => e.op === 'fork' && e.recordId === pendingBefore.transactionId)
    expect(entry?.status).toBe('committed')
    expect(entry?.metadata?.state).toBe('established')
    expect(entry?.metadata?.childSdkSessionId).toBe('sdk-child-1')
  })

  it('retry idempotency: failed establish persists the message once + records an orphan; a same-key retry never duplicates', async () => {
    injectSession('source-6')
    await persistSourceWithMessages('source-6')
    armStrictAdapter('source-6')
    const childId = await confirmChild('source-6', 'retry-child')
    if (!childId) return

    const pendingBefore = loadStoredSession(root, childId)!.pendingFork!
    const establishCalls: Array<{ input: ConversationForkEstablishInput }> = []
    const chatCalls: string[] = []
    armChildAgent(
      childId,
      countingAdapter(
        createDeterministicStrictForkAdapter({
          adapterId: 'pi-test',
          failEstablish: true,
        }),
        establishCalls,
      ),
      chatCalls,
    )

    // First Send: establish throws → typed retryable error, message persisted
    // once, child stays pending, orphan ledger records the attempt.
    await expect(sm.sendMessage(childId, 'retry me')).rejects.toMatchObject({
      code: WORKTREE_FORK_ERROR_CODE,
    })
    const afterFail = loadStoredSession(root, childId)!
    expect(afterFail.pendingFork).toBeDefined()
    expect(afterFail.sdkSessionId).toBeUndefined()
    expect(persistedMessageCount(childId, 'retry me')).toBe(1)
    const orphans = services.forkOrphans.entries()
    expect(orphans).toHaveLength(1)
    expect(orphans[0]!.result).toBe('failed')
    expect(orphans[0]!.transactionId).toBe(pendingBefore.transactionId)
    expect(orphans[0]!.idempotencyKey).toBe(pendingBefore.idempotencyKey)
    expect(orphans[0]!.executionCwd).toBe(pendingBefore.executionCwd)

    // Retry with the SAME persisted idempotency key, reusing the persisted
    // message id (the ack contract gives the caller the message id).
    const managed = (sm as unknown as { sessions: Map<string, unknown> }).sessions.get(childId) as {
      agent?: { conversationFork?: StrictConversationForkCapability }
      messages?: Array<{ id: string; content: string }>
    }
    managed.agent!.conversationFork = countingAdapter(
      createDeterministicStrictForkAdapter({
        adapterId: 'pi-test',
        childSdkSessionId: 'sdk-child-2',
      }),
      establishCalls,
    )
    const retryMessageId = managed.messages!.find((m) => m.content === 'retry me')!.id

    // The retry reuses the persisted message id; the ack contract must fire
    // exactly like the fresh path so the RPC resolves { accepted, messageId }
    // at persistence time (the renderer retry depends on it).
    let retryAck: string | null = null
    await sm.sendMessage(
      childId,
      'retry me',
      undefined,
      undefined,
      undefined,
      retryMessageId,
      undefined,
      (messageId) => {
        retryAck = messageId
      },
    )
    expect(retryAck === retryMessageId).toBe(true)

    // Establish called twice total, SAME persisted key both times; the
    // provider child ID is persisted exactly once and pendingFork retires.
    expect(establishCalls).toHaveLength(2)
    expect(establishCalls[0]!.input.idempotencyKey).toBe(pendingBefore.idempotencyKey)
    expect(establishCalls[1]!.input.idempotencyKey).toBe(pendingBefore.idempotencyKey)
    expect(establishCalls[0]!.input.parentSdkSessionId).toBe('sdk-parent-1')
    expect(establishCalls[0]!.input.executionCwd).toBe(pendingBefore.executionCwd)
    const afterRetry = loadStoredSession(root, childId)!
    expect(afterRetry.sdkSessionId).toBe('sdk-child-2')
    expect(afterRetry.pendingFork).toBeUndefined()
    // The user message is STILL on disk exactly once (no duplicate on retry).
    expect(persistedMessageCount(childId, 'retry me')).toBe(1)
    // The retry's establish succeeded and the message was dispatched once.
    expect(chatCalls).toEqual(['retry me'])
    // The orphan ledger keeps the failed attempt (append-only).
    expect(services.forkOrphans.entries()).toHaveLength(1)
  })

  it('a pending child with a missing/malformed provider anchor rejects with a typed error, no establish call, no fallback', async () => {
    injectSession('source-7')
    await persistSourceWithMessages('source-7')
    armStrictAdapter('source-7')
    const childId = await confirmChild('source-7', 'anchor-child')
    if (!childId) return

    // Corrupt the persisted + managed pendingFork anchor (empty parent SDK
    // session id — e.g. a corrupted record).
    const stored = loadStoredSession(root, childId)!
    stored.pendingFork = { ...stored.pendingFork!, parentSdkSessionId: '' }
    await saveStoredSession(stored)
    const managed = (sm as unknown as { sessions: Map<string, unknown> }).sessions.get(childId) as {
      pendingFork?: { parentSdkSessionId: string }
    }
    managed.pendingFork = { ...managed.pendingFork!, parentSdkSessionId: '' }

    const establishCalls: Array<{ input: ConversationForkEstablishInput }> = []
    const chatCalls: string[] = []
    armChildAgent(
      childId,
      countingAdapter(
        createDeterministicStrictForkAdapter({ adapterId: 'pi-test' }),
        establishCalls,
      ),
      chatCalls,
    )

    await expect(sm.sendMessage(childId, 'anchor test')).rejects.toMatchObject({
      code: WORKTREE_FORK_ERROR_CODE,
    })

    // No provider call, no fallback, no orphan (nothing was attempted), and
    // the child stays pending with its persisted message exactly once.
    expect(establishCalls).toHaveLength(0)
    expect(chatCalls).toHaveLength(0)
    expect(services.forkOrphans.entries()).toHaveLength(0)
    const after = loadStoredSession(root, childId)!
    expect(after.pendingFork).toBeDefined()
    expect(after.sdkSessionId).toBeUndefined()
    expect(persistedMessageCount(childId, 'anchor test')).toBe(1)
  })

  it('a malformed establish result (missing child provider id) is a typed error recorded as an unverified orphan, no attach, no fallback', async () => {
    injectSession('source-8')
    await persistSourceWithMessages('source-8')
    armStrictAdapter('source-8')
    const childId = await confirmChild('source-8', 'malformed-child')
    if (!childId) return

    const pendingBefore = loadStoredSession(root, childId)!.pendingFork!
    const chatCalls: string[] = []
    const malformedAdapter: StrictConversationForkCapability = {
      adapterId: 'pi-test',
      forkCapability: () => ({ adapterId: 'pi-test', strictCrossCwdNativeFork: true }),
      // Returns no childSdkSessionId: an unverifiable provider artifact.
      establishNativeFork: async () => ({}) as never,
    }
    armChildAgent(childId, malformedAdapter, chatCalls)

    await expect(sm.sendMessage(childId, 'malformed result')).rejects.toMatchObject({
      code: WORKTREE_FORK_ERROR_CODE,
    })

    // The provider was called but its result could not be verified: the
    // attempt is journaled as 'unverified' and never silently attached.
    const orphans = services.forkOrphans.entries()
    expect(orphans).toHaveLength(1)
    expect(orphans[0]!.result).toBe('unverified')
    expect(orphans[0]!.transactionId).toBe(pendingBefore.transactionId)
    expect(orphans[0]!.idempotencyKey).toBe(pendingBefore.idempotencyKey)
    const after = loadStoredSession(root, childId)!
    expect(after.pendingFork).toBeDefined()
    expect(after.sdkSessionId).toBeUndefined()
    expect(persistedMessageCount(childId, 'malformed result')).toBe(1)
    expect(chatCalls).toHaveLength(0)
  })

  it('ordinary session sends are unaffected by the pending-fork establish flow', async () => {
    injectSession('plain-1')
    const chatCalls: string[] = []
    armChildAgent(
      'plain-1',
      createDeterministicStrictForkAdapter({ adapterId: 'pi-test' }),
      chatCalls,
    )

    await sm.sendMessage('plain-1', 'plain hello')

    // No establishment happened (no pendingFork) and the message dispatched.
    expect(chatCalls).toEqual(['plain hello'])
    expect(services.forkOrphans.entries()).toHaveLength(0)
    const stored = loadStoredSession(root, 'plain-1')
    expect(stored?.pendingFork).toBeUndefined()
  })

  it('serializes concurrent first-sends: a second send during establishment is refused with the pending code', async () => {
    injectSession('source-concurrent')
    await persistSourceWithMessages('source-concurrent')
    armStrictAdapter('source-concurrent')
    services.pathLeases.lease('source-concurrent', realpathSync(repo))

    const preview = await services.fork.preview({
      sessionId: 'source-concurrent',
      strategy: 'isolated-worktree',
      worktreeNameSuffix: 'concurrent-child',
    })
    expect(preview.blocked).toBeUndefined()
    if (preview.blocked) return
    const result = await services.fork.confirm({
      sessionId: 'source-concurrent',
      strategy: 'isolated-worktree',
      transactionId: preview.transactionId,
      previewFingerprint: preview.previewFingerprint,
      worktreeNameSuffix: 'concurrent-child',
    })
    expect(result.outcome).toBe('committed')
    if (result.outcome !== 'committed') return

    // Block the establish call so the second send lands while establishment
    // is in flight.
    let releaseEstablish!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseEstablish = resolve
    })
    const establishLog: Array<{ input: unknown }> = []
    const gatedAdapter = createDeterministicStrictForkAdapter({ adapterId: 'pi-test' })
    const blockingAdapter: StrictConversationForkCapability = {
      ...gatedAdapter,
      establishNativeFork: async (input) => {
        establishLog.push({ input })
        await gate
        return gatedAdapter.establishNativeFork(input)
      },
    }
    const childId = result.summary.sessionId
    const chatCalls: string[] = []
    armChildAgent(childId, blockingAdapter, chatCalls)

    const firstSend = sm.sendMessage(childId, 'first concurrent send')
    // Wait until the establish call is in flight, then fire the second send.
    while (establishLog.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await expect(sm.sendMessage(childId, 'second concurrent send')).rejects.toMatchObject({
      code: WORKTREE_FORK_PENDING_CODE,
    })
    releaseEstablish()
    await firstSend

    // Exactly one establishment, one dispatch; the refused second message is
    // never dispatched.
    expect(establishLog).toHaveLength(1)
    expect(chatCalls).toEqual(['first concurrent send'])
    const managed = (sm as unknown as { sessions: Map<string, unknown> }).sessions.get(childId) as {
      pendingFork?: unknown
      sdkSessionId?: string
    }
    expect(managed.pendingFork).toBeUndefined()
    expect(managed.sdkSessionId).toBeTruthy()
  })

  it('exposes the durable fork-child session state for startup reconciliation and backfills the lost established marker', async () => {
    injectSession('source-hook')
    await persistSourceWithMessages('source-hook')
    armStrictAdapter('source-hook')
    const childId = await confirmChild('source-hook', 'hook-child')
    if (!childId) return
    const pendingBefore = loadStoredSession(root, childId)!.pendingFork!

    const smAny = sm as unknown as {
      resolveSessionForkState?: (sessionId: string) => {
        sdkSessionId?: string
        pendingFork?: { transactionId: string } | null
        checkoutStrategy?: string
      } | null
    }

    // Published-but-unestablished child: no provider id, pending intent with
    // the fork transaction id, 'isolated' checkout provenance.
    const pending = smAny.resolveSessionForkState!(childId)
    expect(pending).toMatchObject({
      sdkSessionId: undefined,
      checkoutStrategy: 'isolated',
    })
    expect(pending?.pendingFork?.transactionId).toBe(pendingBefore.transactionId)

    // First Send establishes the child: the hook now reports the provider id
    // and no pending intent.
    const chatCalls: string[] = []
    armChildAgent(
      childId,
      createDeterministicStrictForkAdapter({ adapterId: 'pi-test', childSdkSessionId: 'sdk-hook-child' }),
      chatCalls,
    )
    await sm.sendMessage(childId, 'hello hook')
    const established = smAny.resolveSessionForkState!(childId)
    expect(established?.sdkSessionId).toBe('sdk-hook-child')
    expect(established?.pendingFork).toBeNull()
    expect(established?.checkoutStrategy).toBe('isolated')

    // Simulate the establish-window crash: the session flushed and retired
    // pendingFork, but markEstablished never ran on the committed journal
    // entry. Startup reconciliation through the wired hook must backfill it.
    const entry = services.journal
      .entries()
      .find((e) => e.op === 'fork' && e.recordId === pendingBefore.transactionId)!
    expect(entry?.metadata?.state).toBe('established')
    services.journal.updateMetadata(entry.journalId, { state: 'binding-committed' })

    const report = await services.fork.reconcileForkJournal()

    expect(report).toEqual({ resumed: 1, flagged: 0, recoveryRequired: 0 })
    const after = services.journal
      .entries()
      .find((e) => e.op === 'fork' && e.recordId === pendingBefore.transactionId)!
    expect(after.metadata?.state).toBe('established')
    expect(after.metadata?.childSdkSessionId).toBe('sdk-hook-child')
  })

  /**
   * Phase 4 Task 7: provenance-aware cleanup. An isolated fork child owns its
   * worktree record as the SOLE owner, so deletion uses only that child's
   * lifecycle — the standard snapshot-first removal transaction on the child's
   * own record — and never mutates the source session, the source's record, or
   * the source branch/HEAD/index. Shared children keep dropping exactly one
   * owner from the shared record (legacy behavior).
   */
  describe('SessionManager isolated fork child deletion (Task 7 cleanup provenance)', () => {
    /** The fork journal entry that published the given child session. */
    function forkEntryForChild(childId: string) {
      return services.journal
        .entries()
        .find((e) => e.op === 'fork' && e.metadata?.childSessionId === childId)
    }

    it('delete-with-worktree removes only the child lifecycle and leaves the source untouched', async () => {
      injectSession('source-del')
      await persistSourceWithMessages('source-del')
      armStrictAdapter('source-del')
      const childId = await confirmChild('source-del', 'del-child')
      if (!childId) return

      // The child owns its own record as the SOLE owner.
      const childRecord = services.registry.list().find((r) => r.ownerSessionIds.includes(childId))
      expect(childRecord).toBeDefined()
      expect(childRecord!.ownerSessionIds).toEqual([childId])
      expect(childRecord!.state).toBe('ready')
      const childCheckoutPath = childRecord!.checkoutPath

      // Source repo state (branch/HEAD/index) and fork journal entry before deletion.
      const headBefore = (await git(repo, ['rev-parse', 'HEAD'])).trim()
      const branchBefore = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
      const indexBefore = await git(repo, ['status', '--porcelain'])
      expect(forkEntryForChild(childId)?.status).toBe('committed')

      const result = await sm.deleteSession(childId, { removeManagedWorktree: true })

      expect(result.deleted).toBe(true)
      expect(result.worktreeRemoval?.removed).toBe(true)

      // Child session gone: runtime and persisted storage.
      expect(sm.getSessions().some((s) => s.id === childId)).toBe(false)
      expect(existsSync(getSessionFilePath(root, childId))).toBe(false)

      // Child record removed from the ready/owned set snapshot-first: the
      // checkout is gone, the record is snapshotted with no owners and a
      // verified snapshot, and the removal is journaled.
      const after = services.registry.get(childRecord!.managedWorktreeId)
      expect(after?.ownerSessionIds).toEqual([])
      expect(after?.state).toBe('snapshotted')
      expect((after as import('@kata-sh/shared/protocol').ManagedWorktreeRecordV2 | undefined)?.snapshot).toBeDefined()
      expect(existsSync(childCheckoutPath)).toBe(false)
      expect(
        services.journal
          .entries()
          .some((e) => e.op === 'session-delete' && e.recordId === childRecord!.managedWorktreeId && e.status === 'committed'),
      ).toBe(true)

      // The fork journal entry is retained (kept by compaction) — never cleaned
      // up by child deletion.
      expect(forkEntryForChild(childId)?.status).toBe('committed')

      // Source session + persisted record untouched.
      expect(sm.getSessions().some((s) => s.id === 'source-del')).toBe(true)
      const sourceStored = loadStoredSession(root, 'source-del')
      expect(sourceStored?.messages.map((m) => m.id)).toEqual(['msg-1', 'msg-2'])
      expect(sourceStored?.checkout).toBeUndefined()

      // Source branch/HEAD/index unchanged.
      expect((await git(repo, ['rev-parse', 'HEAD'])).trim()).toBe(headBefore)
      expect((await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe(branchBefore)
      expect(await git(repo, ['status', '--porcelain'])).toBe(indexBefore)
    })

    it('deleting an isolated child without the removal choice leaves its record unowned and manageable (auto-delete applies)', async () => {
      injectSession('source-del2')
      await persistSourceWithMessages('source-del2')
      armStrictAdapter('source-del2')
      const childId = await confirmChild('source-del2', 'keep-child')
      if (!childId) return

      const childRecord = services.registry.list().find((r) => r.ownerSessionIds.includes(childId))!
      const childCheckoutPath = childRecord.checkoutPath
      // A second materialized record so the retention sweep has a candidate to
      // select beyond the limit (retention candidates require count > limit).
      injectEmptySession('extra-owner')
      const prep = await sm.prepareCheckout('extra-owner', {
        mode: 'managed-worktree',
        workingDirectory: repo,
        baseRef: 'main',
      })
      const extraRecordId = prep.checkout.managedWorktreeId!

      const result = await sm.deleteSession(childId)
      expect(result.deleted).toBe(true)

      // The child's record stays manageable: unowned, checkout intact, nothing
      // removed, no snapshot. The source record is untouched.
      const after = services.registry.get(childRecord.managedWorktreeId)!
      expect(after.state).toBe('unowned')
      expect(after.ownerSessionIds).toEqual([])
      expect((after as import('@kata-sh/shared/protocol').ManagedWorktreeRecordV2).snapshot).toBeUndefined()
      expect(existsSync(childCheckoutPath)).toBe(true)
      expect(services.registry.get(extraRecordId)!.ownerSessionIds).toEqual(['extra-owner'])
      expect(sm.getSessions().some((s) => s.id === 'source-del2')).toBe(true)

      // Auto-delete policy then removes the unowned record snapshot-first,
      // exactly like any other record (the registry is provenance-neutral).
      services.worktreeSettings.update({
        materializationRoot: join(root, 'worktrees'),
        autoDeleteEnabled: true,
        retentionLimit: 1,
      })
      await services.lifecycle.runCleanupSweep()
      const removed = services.registry.get(childRecord.managedWorktreeId)!
      expect(removed.state).toBe('snapshotted')
      expect((removed as import('@kata-sh/shared/protocol').ManagedWorktreeRecordV2).snapshot).toBeDefined()
      expect(existsSync(childCheckoutPath)).toBe(false)
      // The owned record survives the sweep.
      expect(existsSync(prep.checkout.checkoutPath)).toBe(true)
    })

    it('deleting a shared-branch child drops exactly one owner from the shared record (regression guard)', async () => {
      injectEmptySession('shared-parent')
      const prep = await sm.prepareCheckout('shared-parent', {
        mode: 'managed-worktree',
        workingDirectory: repo,
        baseRef: 'main',
      })
      const recordId = prep.checkout.managedWorktreeId!
      // Mirror the createSession shared-branch end state: the child mirrors the
      // parent checkout, records 'shared' provenance, and joins the record as a
      // second owner with a path lease.
      const childId = 'shared-child'
      const childManaged = injectSession(childId)
      childManaged.checkout = prep.checkout as never
      childManaged.workingDirectory = prep.checkout.checkoutPath
      childManaged.sdkCwd = prep.checkout.checkoutPath
      ;(childManaged as unknown as { checkoutStrategy?: string }).checkoutStrategy = 'shared'
      services.worktrees.addOwner(recordId, childId)
      services.pathLeases.lease(childId, prep.checkout.checkoutPath)
      await saveStoredSession({
        id: childId,
        workspaceRootPath: root,
        name: 'shared-child',
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        sdkCwd: prep.checkout.checkoutPath,
        sdkSessionId: 'sdk-parent-1',
        workingDirectory: prep.checkout.checkoutPath,
        messages: [],
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
      } as never)

      expect(services.registry.get(recordId)!.ownerSessionIds).toEqual(['shared-parent', childId])

      const result = await sm.deleteSession(childId)
      expect(result.deleted).toBe(true)

      // Exactly one owner dropped; the shared record, checkout, and the other
      // owner are untouched.
      const record = services.registry.get(recordId)!
      expect(record.ownerSessionIds).toEqual(['shared-parent'])
      expect(record.state).toBe('ready')
      expect(existsSync(prep.checkout.checkoutPath)).toBe(true)
      expect(sm.getSessions().some((s) => s.id === childId)).toBe(false)
      expect(sm.getSessions().some((s) => s.id === 'shared-parent')).toBe(true)
    })

    it('inspectManagedWorktreeRemoval reports the child record with no other owners (provenance-correct inspection)', async () => {
      injectSession('source-inspect')
      await persistSourceWithMessages('source-inspect')
      armStrictAdapter('source-inspect')
      const childId = await confirmChild('source-inspect', 'inspect-child')
      if (!childId) return
      const childRecord = services.registry.list().find((r) => r.ownerSessionIds.includes(childId))!

      // The inspection resolves the CHILD's own record — never the source's —
      // and reports a sole owner, so the delete dialog shows no shared-worktree
      // language and an accurate removal label.
      const risk = await sm.inspectManagedWorktreeRemoval(childId)
      expect(risk.managedWorktreeId).toBe(childRecord.managedWorktreeId)
      expect(risk.ownerSessionIds).toEqual([childId])
      expect(risk.otherOwnerCount).toBe(0)
      expect(risk.blocked).toBe(false)
    })

    it('a recovery-required fork journal entry survives child deletion and later reconcile', async () => {
      injectSession('source-rec')
      await persistSourceWithMessages('source-rec')
      armStrictAdapter('source-rec')
      const childId = await confirmChild('source-rec', 'recovery-child')
      if (!childId) return
      const forkEntry = forkEntryForChild(childId)!
      // Drive the committed entry into the recovery-required state that an
      // interrupted fork leaves behind; the deletion escape hatch must still
      // apply and the entry must stay for later reconcile.
      services.journal.updateMetadata(forkEntry.journalId, {
        state: 'recovery-required',
        recoveryReason: 'simulated interrupted fork',
      })

      const result = await sm.deleteSession(childId, { removeManagedWorktree: true })
      expect(result.deleted).toBe(true)

      const after = services.journal
        .entries()
        .find((e) => e.journalId === forkEntry.journalId)!
      expect(after.status).toBe('committed')
      expect(after.metadata?.state).toBe('recovery-required')

      // Reconcile reports the retained entry without blocking or editing it.
      const report = await services.fork.reconcileForkJournal()
      expect(report.recoveryRequired).toBeGreaterThanOrEqual(1)
      const still = services.journal
        .entries()
        .find((e) => e.journalId === forkEntry.journalId)!
      expect(still.status).toBe('committed')
    })

    it('pendingFork children skip the branch-preflight rollback (structural guard)', async () => {
      // rollbackFailedBranchCreation is only reachable from the branch backend
      // preflight gate, which requires `branchContextStrategy === 'sdk-fork' &&
      // !options.pendingFork`. A pendingFork child therefore never enters it:
      // the child is created durably with NO backend preflight (no agent) and
      // its worktree record survives, even though this harness cannot complete
      // the shared-branch preflight (no real backend). The fork service owns
      // compensation for failed fork creation instead.
      injectSession('source-gate')
      await persistSourceWithMessages('source-gate')
      armStrictAdapter('source-gate')
      const childId = await confirmChild('source-gate', 'gate-child')
      if (!childId) return

      const managed = (sm as unknown as { sessions: Map<string, unknown> }).sessions.get(
        childId,
      ) as { agent?: unknown; pendingFork?: unknown; checkoutStrategy?: string }
      expect(managed.agent == null).toBe(true)
      expect(managed.pendingFork).toBeDefined()
      expect(managed.checkoutStrategy).toBe('isolated')
      // The child's worktree record exists (nothing was rolled back).
      expect(services.registry.list().some((r) => r.ownerSessionIds.includes(childId))).toBe(true)
      // The durable fork creation committed exactly once.
      expect(forkEntryForChild(childId)?.status).toBe('committed')
    })

    it('delete-with-worktree on an isolated child never mutates a managed source record', async () => {
      // A managed source: the fork source owns its OWN worktree record. The
      // child's deletion must leave that record, its checkout, and its HEAD
      // exactly as they were.
      const sourceManaged = injectEmptySession('managed-source')
      const prep = await sm.prepareCheckout('managed-source', {
        mode: 'managed-worktree',
        workingDirectory: repo,
        baseRef: 'main',
      })
      const sourceRecordId = prep.checkout.managedWorktreeId!
      // Restore the SDK identity the fork child anchors on (the stored record
      // below also carries it).
      ;(sourceManaged as unknown as { sdkSessionId?: string }).sdkSessionId = 'sdk-parent-1'
      await persistSourceWithMessages('managed-source')
      armStrictAdapter('managed-source')
      services.pathLeases.lease('managed-source', prep.checkout.checkoutPath)

      const preview = await services.fork.preview({
        sessionId: 'managed-source',
        strategy: 'isolated-worktree',
        worktreeNameSuffix: 'src-isolated',
      })
      expect(preview.blocked).toBeUndefined()
      if (preview.blocked) return
      const result = await services.fork.confirm({
        sessionId: 'managed-source',
        strategy: 'isolated-worktree',
        transactionId: preview.transactionId,
        previewFingerprint: preview.previewFingerprint,
        worktreeNameSuffix: 'src-isolated',
      })
      expect(result.outcome).toBe('committed')
      if (result.outcome !== 'committed') return
      const childId = result.summary.sessionId

      const childRecord = services.registry.list().find((r) => r.ownerSessionIds.includes(childId))!
      expect(childRecord.managedWorktreeId).not.toBe(sourceRecordId)
      const sourceCheckoutPath = prep.checkout.checkoutPath
      const sourceHeadBefore = (await git(sourceCheckoutPath, ['rev-parse', 'HEAD'])).trim()
      const sourceBranchBefore = (await git(sourceCheckoutPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()

      const del = await sm.deleteSession(childId, { removeManagedWorktree: true })
      expect(del.deleted).toBe(true)

      // The source record is untouched: same sole owner, still ready, checkout
      // on disk, branch/HEAD unchanged.
      const sourceRecordAfter = services.registry.get(sourceRecordId)!
      expect(sourceRecordAfter.ownerSessionIds).toEqual(['managed-source'])
      expect(sourceRecordAfter.state).toBe('ready')
      expect(existsSync(sourceCheckoutPath)).toBe(true)
      expect((await git(sourceCheckoutPath, ['rev-parse', 'HEAD'])).trim()).toBe(sourceHeadBefore)
      expect((await git(sourceCheckoutPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe(sourceBranchBefore)
      expect(sm.getSessions().some((s) => s.id === 'managed-source')).toBe(true)

      // The child record is the only thing removed from the ready/owned set.
      const childAfter = services.registry.get(childRecord.managedWorktreeId)
      expect(childAfter?.ownerSessionIds).toEqual([])
      expect(childAfter?.state).toBe('snapshotted')
      expect(existsSync(childRecord.checkoutPath)).toBe(false)
    })
  })
})
