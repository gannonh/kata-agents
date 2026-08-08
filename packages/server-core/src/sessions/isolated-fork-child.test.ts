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

    await sm.sendMessage(childId, 'retry me', undefined, undefined, undefined, retryMessageId)

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
})
