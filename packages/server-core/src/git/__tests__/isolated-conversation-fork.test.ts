import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, realpathSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createGitServices } from '../index'
import type { GitServices } from '../index'
import type {
  ConversationForkPreview,
  ConversationForkPreviewInput,
  ConversationForkStrategy,
  SessionCheckout,
} from '@kata-sh/shared/protocol'
import type { StrictConversationForkCapability } from '@kata-sh/shared/agent/backend'
import { createDeterministicStrictForkAdapter, resolveIsolatedForkCapability } from '@kata-sh/shared/agent/backend'
import { initRepo, makeTmpDir, cleanup, git, writeFile, runGit } from './test-helpers'
import {
  WORKTREE_SNAPSHOT_REF_PREFIX,
  computeWorktreeFingerprint,
} from '../worktree-snapshot-service'
import { ConversationForkError } from '../isolated-conversation-fork-service'

const cleanups: string[] = []
function tmp(): string {
  const dir = makeTmpDir('kata-fork-test-')
  cleanups.push(dir)
  return dir
}
afterEach(() => {
  while (cleanups.length) cleanup(cleanups.pop()!)
})

interface SessionFixture {
  checkoutPath: string
  workspaceId: string
  checkout: SessionCheckout | null
  transcriptCwd: string
  conversationHead: { messageId: string; turnId: string }
  sdkSessionId?: string
  forkPointMessageId?: string
  forkPointTurnId?: string
}

interface Harness {
  root: string
  repo: string
  svc: GitServices
  sessions: Map<string, SessionFixture>
  adapters: Map<string, StrictConversationForkCapability | null>
  activeSessions: Set<string>
}

let previousV1: string | undefined
let previousV2: string | undefined
let harness: Harness

function makeHarness(): Harness {
  const root = tmp()
  const repo = join(root, 'repo')
  const sessions = new Map<string, SessionFixture>()
  const adapters = new Map<string, StrictConversationForkCapability | null>()
  const activeSessions = new Set<string>()
  const svc = createGitServices({
    worktreeRoot: join(root, 'worktrees'),
    registryPath: join(root, 'worktrees', 'registry.json'),
    snapshotsRoot: join(root, 'snapshots'),
    lockDirectory: join(root, 'locks'),
    forkHooks: {
      resolveSession: (sessionId) => sessions.get(sessionId) ?? null,
      // Mirrors production wiring (SessionManager): the advertised capability
      // is the strict-fork gate's output, never the raw adapter.
      resolveCapability: (sessionId) => {
        const adapter = adapters.get(sessionId) ?? null
        if (!adapter) return null
        const resolution = resolveIsolatedForkCapability({ conversationFork: adapter })
        return resolution.supported ? resolution.capability : null
      },
      resolveCapabilityAdapter: (sessionId) => adapters.get(sessionId) ?? null,
      isSessionActive: (sessionId) => activeSessions.has(sessionId),
      quiesceRuntimes: async (ids) => {
        for (const id of ids) activeSessions.delete(id)
        return true
      },
    },
  })
  svc.worktreeSettings.update({
    materializationRoot: join(root, 'worktrees'),
    autoDeleteEnabled: false,
    retentionLimit: 15,
  })
  return { root, repo, svc, sessions, adapters, activeSessions }
}

beforeEach(async () => {
  previousV1 = process.env.KATA_FEATURE_GIT_WORKSPACE_V1
  previousV2 = process.env.KATA_FEATURE_WORKTREE_V2
  process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = '1'
  process.env.KATA_FEATURE_WORKTREE_V2 = '1'
  harness = makeHarness()
  await initRepo(harness.repo)
  harness.svc.lifecycle.markReady()
  harness.adapters.set('session-1', createDeterministicStrictForkAdapter({ adapterId: 'pi-test' }))
})

afterEach(() => {
  if (previousV1 === undefined) delete process.env.KATA_FEATURE_GIT_WORKSPACE_V1
  else process.env.KATA_FEATURE_GIT_WORKSPACE_V1 = previousV1
  if (previousV2 === undefined) delete process.env.KATA_FEATURE_WORKTREE_V2
  else process.env.KATA_FEATURE_WORKTREE_V2 = previousV2
})

function currentSession(overrides: Partial<SessionFixture> = {}): SessionFixture {
  const fixture: SessionFixture = {
    checkoutPath: harness.repo,
    workspaceId: 'ws1',
    checkout: null,
    transcriptCwd: join(harness.repo, '.kata-transcript'),
    conversationHead: { messageId: 'msg-1', turnId: 'turn-1' },
    ...overrides,
  }
  harness.sessions.set('session-1', fixture)
  // Mirror startup reconciliation: every live session leases its canonical
  // (git-resolved) checkout root so lifecycle decisions see the full fence set.
  harness.svc.pathLeases.lease('session-1', realpathSync(fixture.checkoutPath))
  return fixture
}

async function preview(
  strategy: ConversationForkStrategy,
  nameSuffix?: string,
): Promise<ConversationForkPreview> {
  // Pass the suffix even when empty: the renderer clearing the field sends an
  // explicit empty string, which the server must reject as invalid-name.
  const input: ConversationForkPreviewInput = { sessionId: 'session-1', strategy }
  if (nameSuffix !== undefined) input.worktreeNameSuffix = nameSuffix
  return harness.svc.fork.preview(input)
}

describe('IsolatedConversationForkService preview', () => {
  test('returns a typed blocked preview (never throws) when no strict fork capability is advertised', async () => {
    currentSession()
    harness.adapters.set('session-1', null)

    const p = await preview('isolated-worktree', 'demo')
    expect(p.blocked?.blocked).toBe(true)
    expect(p.blocked?.code).toBe('unsupported-provider')
    expect(p.strategy).toBe('isolated-worktree')
    expect(p.currentHead).toBe(true)
  })

  test('returns a typed blocked preview for an adapter that advertises but lacks the establish surface', async () => {
    currentSession()
    // Capability DTO advertises true, but the adapter is structurally
    // incomplete (no establishNativeFork) — the gate must still block.
    harness.adapters.set('session-1', {
      adapterId: 'pi-test',
      forkCapability: () => ({ adapterId: 'pi-test', strictCrossCwdNativeFork: true }),
    } as StrictConversationForkCapability)

    const p = await preview('isolated-worktree', 'demo')
    expect(p.blocked?.blocked).toBe(true)
    expect(p.blocked?.code).toBe('unsupported-provider')
  })

  test('returns a typed blocked preview for an adapter advertising strictCrossCwdNativeFork false', async () => {
    currentSession()
    harness.adapters.set('session-1', {
      adapterId: 'pi-test',
      forkCapability: () => ({ adapterId: 'pi-test', strictCrossCwdNativeFork: false }),
      establishNativeFork: async () => ({
        childSdkSessionId: 'sdk-child',
        proof: { adapterId: 'pi-test', destinationPath: '', verifiedAt: 0, checks: [] },
      }),
    } as StrictConversationForkCapability)

    const p = await preview('isolated-worktree', 'demo')
    expect(p.blocked?.blocked).toBe(true)
    expect(p.blocked?.code).toBe('unsupported-provider')
  })

  test('returns a valid isolated preview with capability, currentHead, and bound fingerprint for an eligible current-checkout source', async () => {
    currentSession()

    const p = await preview('isolated-worktree', 'demo')
    expect(p.blocked).toBeUndefined()
    expect(p.strategy).toBe('isolated-worktree')
    expect(p.currentHead).toBe(true)
    expect(p.providerCapability).toEqual({ adapterId: 'pi-test', strictCrossCwdNativeFork: true })
    expect(p.source.sessionId).toBe('session-1')
    expect(p.source.conversationHeadMessageId).toBe('msg-1')
    expect(p.source.conversationHeadTurnId).toBe('turn-1')
    expect(p.source.checkout.mode).toBe('current')
    expect(p.source.branch).toBe('main')
    expect(p.source.headSha).toMatch(/^[0-9a-f]{40}$/)
    expect(p.source.leases).toContain('session-1')
    expect(p.destination.branch).toBe('kata-agent/demo')
    expect(p.destination.serverId).toBe('local')
    expect(p.destination.exists).toBe(false)
    expect(p.excludedIgnoredPolicy.includeOnly).toBe(true)
    expect(p.previewFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(p.transactionId).toMatch(/^[0-9a-f]{16}$/)
  })

  test('shared-worktree preview is unblocked without a provider capability and reports the shared checkout as destination', async () => {
    currentSession()
    harness.adapters.set('session-1', null)

    const p = await preview('shared-worktree')
    expect(p.blocked).toBeUndefined()
    expect(p.strategy).toBe('shared-worktree')
    expect(p.destination.branch).toBe('main')
    expect(p.destination.exists).toBe(true)
    expect(p.destination.checkoutPath).toBe(realpathSync(harness.repo))
  })

  test('registers a preview transaction only for the isolated strategy; a re-preview supersedes it', async () => {
    currentSession()

    const isolated = await preview('isolated-worktree', 'txn-demo')
    expect(isolated.blocked).toBeUndefined()
    expect(harness.svc.fork.isSessionFenced('session-1')).toBe(true)

    // A fresh preview of either strategy supersedes the stale pending
    // preview-only transaction (it has never mutated anything).
    const shared = await preview('shared-worktree')
    expect(shared.blocked).toBeUndefined()
    expect(harness.svc.fork.isSessionFenced('session-1')).toBe(false)

    const again = await preview('isolated-worktree', 'txn-demo')
    expect(again.blocked).toBeUndefined()
    expect(harness.svc.fork.isSessionFenced('session-1')).toBe(true)
  })

  test('blocks isolated for an older fork point (non-head-source); shared stays available', async () => {
    currentSession()
    harness.sessions.set('session-1', {
      ...harness.sessions.get('session-1')!,
      forkPointMessageId: 'msg-0',
      forkPointTurnId: 'turn-0',
    })

    const p = await preview('isolated-worktree', 'demo')
    expect(p.blocked?.blocked).toBe(true)
    expect(p.blocked?.code).toBe('non-head-source')
    expect(p.currentHead).toBe(false)

    // Shared branching remains the historical-conversation-point path.
    const shared = await preview('shared-worktree')
    expect(shared.blocked).toBeUndefined()
    expect(shared.currentHead).toBe(false)
  })

  test('blocks when any source owner has an active turn (source-active)', async () => {
    currentSession()
    harness.activeSessions.add('session-1')

    const p = await preview('isolated-worktree', 'demo')
    expect(p.blocked?.code).toBe('source-active')
  })

  test('blocks when a foreign session leases the source path (path-unleased)', async () => {
    currentSession()
    harness.svc.pathLeases.lease('foreign-session', realpathSync(harness.repo))

    const p = await preview('isolated-worktree', 'demo')
    expect(p.blocked?.code).toBe('path-unleased')
  })

  test('blocks an invalid name suffix (invalid-name)', async () => {
    currentSession()

    const p = await preview('isolated-worktree', 'bad name!')
    expect(p.blocked?.code).toBe('invalid-name')

    const empty = await preview('isolated-worktree', '')
    expect(empty.blocked?.code).toBe('invalid-name')
  })

  test('blocks a colliding branch or occupied destination (name-collision)', async () => {
    currentSession()
    await git(harness.repo, ['branch', 'kata-agent/taken'])

    const p = await preview('isolated-worktree', 'taken')
    expect(p.blocked?.code).toBe('name-collision')
  })

  test('blocks when feature flags are disabled (flags-disabled)', async () => {
    currentSession()
    const previousV2 = process.env.KATA_FEATURE_WORKTREE_V2
    process.env.KATA_FEATURE_WORKTREE_V2 = '0'
    try {
      const p = await preview('isolated-worktree', 'demo')
      expect(p.blocked?.code).toBe('flags-disabled')
    } finally {
      if (previousV2 === undefined) delete process.env.KATA_FEATURE_WORKTREE_V2
      else process.env.KATA_FEATURE_WORKTREE_V2 = previousV2
    }
  })

  test('blocks while lifecycle cleanup is in progress (cleanup-in-progress)', async () => {
    currentSession()
    ;(harness.svc.lifecycle as unknown as { sweepRunning: object }).sweepRunning = {}

    const p = await preview('isolated-worktree', 'demo')
    expect(p.blocked?.code).toBe('cleanup-in-progress')
  })

  test('blocks while a pending fork journal transaction exists (fork-in-progress)', async () => {
    currentSession()

    const first = await preview('isolated-worktree', 'demo')
    expect(first.blocked).toBeUndefined()
    // A restarted server instance reads the SAME journal file: the in-memory
    // transaction is gone but the durable 'fork' entry is still pending.
    const fresh = createGitServices({
      worktreeRoot: join(harness.root, 'worktrees'),
      registryPath: join(harness.root, 'worktrees', 'registry.json'),
      snapshotsRoot: join(harness.root, 'snapshots'),
      lockDirectory: join(harness.root, 'locks'),
      forkHooks: {
        resolveSession: (sessionId) => harness.sessions.get(sessionId) ?? null,
        resolveCapability: () => ({ adapterId: 'pi-test', strictCrossCwdNativeFork: true }),
        resolveCapabilityAdapter: () => createDeterministicStrictForkAdapter({ adapterId: 'pi-test' }),
        isSessionActive: () => false,
      },
    })
    fresh.lifecycle.markReady()

    const p = await fresh.fork.preview({ sessionId: 'session-1', strategy: 'isolated-worktree', worktreeNameSuffix: 'demo' })
    expect(p.blocked?.code).toBe('fork-in-progress')
  })

  test('returns a typed blocked preview for an unknown session (missing-source)', async () => {
    const p = await harness.svc.fork.preview({ sessionId: 'ghost', strategy: 'isolated-worktree', worktreeNameSuffix: 'demo' })
    expect(p.blocked?.blocked).toBe(true)
    expect(p.blocked?.code).toBe('missing-source')
  })

  test('blocks a snapshotted/missing managed source (missing-source)', async () => {
    const record = await managedSession('snap-src')
    // Snapshotted: the record leaves `ready` and its checkout is released.
    harness.svc.registry.setState(record.managedWorktreeId, 'snapshotted')
    rmSync(record.checkoutPath, { recursive: true, force: true })

    const p = await preview('isolated-worktree', 'demo')
    expect(p.blocked?.code).toBe('missing-source')
  })

  test('blocks an unmerged index (git-operation-in-progress)', async () => {
    currentSession()
    // A real merge conflict leaves an unmerged index and operation metadata.
    writeFile(harness.repo, 'conflict.txt', 'base\n')
    await git(harness.repo, ['add', 'conflict.txt'])
    await git(harness.repo, ['commit', '-m', 'base'])
    await git(harness.repo, ['switch', '-c', 'side'])
    writeFile(harness.repo, 'conflict.txt', 'side\n')
    await git(harness.repo, ['add', 'conflict.txt'])
    await git(harness.repo, ['commit', '-m', 'side'])
    await git(harness.repo, ['switch', 'main'])
    writeFile(harness.repo, 'conflict.txt', 'main\n')
    await git(harness.repo, ['add', 'conflict.txt'])
    await git(harness.repo, ['commit', '-m', 'main'])
    await runGit(['merge', 'side'], { cwd: harness.repo, okExitCodes: [1] })

    const p = await preview('isolated-worktree', 'demo')
    expect(p.blocked?.code).toBe('git-operation-in-progress')
  })

  test('blocks a detached HEAD source (unsupported-snapshot)', async () => {
    currentSession()
    await git(harness.repo, ['checkout', '--detach', 'HEAD'])

    const p = await preview('isolated-worktree', 'demo')
    expect(p.blocked?.code).toBe('unsupported-snapshot')
  })

  test('shared strategy stays available for a detached HEAD source (no seed is captured)', async () => {
    currentSession()
    await git(harness.repo, ['checkout', '--detach', 'HEAD'])

    const p = await preview('shared-worktree')
    expect(p.blocked).toBeUndefined()
    expect(p.strategy).toBe('shared-worktree')
  })

  test('blocks an oversized source state (oversized-capture)', async () => {
    currentSession()
    const big = 'x'.repeat(1024 * 1024)
    for (let i = 0; i < 150; i++) writeFile(harness.repo, `bulk/file-${i}.bin`, `${i}:${big}`)

    const p = await preview('isolated-worktree', 'demo')
    expect(p.blocked?.code).toBe('oversized-capture')
  })
})

/** Bind session-1 to a newly created managed worktree (V2 named record). */
async function managedSession(name = 'demo'): Promise<Awaited<ReturnType<GitServices['worktrees']['createWorktree']>>['record']> {
  const gitCommonDir = (await git(harness.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
  const { record } = await harness.svc.worktrees.createWorktree({
    workspaceId: 'ws1',
    sessionId: 'session-1',
    repositoryRoot: harness.repo,
    gitCommonDir,
    baseRef: 'main',
    worktreeNameSuffix: name,
  })
  if (record.schemaVersion !== 2) throw new Error('expected a V2 named record')
  const checkout: SessionCheckout = {
    schemaVersion: 2,
    mode: 'managed-worktree',
    repositoryRoot: record.repositoryRoot,
    checkoutPath: record.checkoutPath,
    branchAtPreparation: record.expectedBranch,
    baseRef: record.baseRef,
    managedWorktreeId: record.managedWorktreeId,
    displayName: record.displayName,
    expectedBranch: record.expectedBranch,
    materializationRoot: record.materializationRoot,
  }
  currentSession({ checkoutPath: record.checkoutPath, checkout })
  harness.svc.pathLeases.lease('session-1', record.checkoutPath)
  return record
}

describe('IsolatedConversationForkService managed/shared sources', () => {
  test('previews an eligible single-owner managed source with the record owners leased', async () => {
    await managedSession('src')

    const p = await preview('isolated-worktree', 'child')
    expect(p.blocked).toBeUndefined()
    expect(p.source.checkout.mode).toBe('managed-worktree')
    expect(p.source.checkout.managedWorktreeId).toBeDefined()
    expect(p.source.branch).toBe('kata-agent/src')
    expect(p.source.leases).toContain('session-1')
    expect(p.destination.branch).toBe('kata-agent/child')
  })

  test('requires every shared-source owner to be idle (source-active on a second owner)', async () => {
    const record = await managedSession('shared-src')
    harness.svc.worktrees.addOwner(record.managedWorktreeId, 'session-2')
    harness.svc.pathLeases.lease('session-2', record.checkoutPath)

    // Both owners idle → eligible.
    const ok = await preview('isolated-worktree', 'child')
    expect(ok.blocked).toBeUndefined()
    expect(ok.source.leases).toEqual(expect.arrayContaining(['session-1', 'session-2']))

    // Second owner active → blocked.
    harness.activeSessions.add('session-2')
    const p = await preview('isolated-worktree', 'child')
    expect(p.blocked?.code).toBe('source-active')
  })

  test('blocks a shared managed source with a foreign lease on the checkout (path-unleased)', async () => {
    const record = await managedSession('shared-src-2')
    harness.svc.worktrees.addOwner(record.managedWorktreeId, 'session-2')
    harness.svc.pathLeases.lease('session-2', record.checkoutPath)
    // A session outside the owner set occupies the checkout path.
    harness.svc.pathLeases.lease('session-99', record.checkoutPath)

    const p = await preview('isolated-worktree', 'child')
    expect(p.blocked?.code).toBe('path-unleased')
  })

  test('canonicalizes a current-checkout source with a nested working directory to the repository root', async () => {
    const nested = join(harness.repo, 'nested', 'workdir')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(nested, { recursive: true })
    currentSession({ checkoutPath: nested })
    harness.svc.pathLeases.lease('session-1', realpathSync(harness.repo))

    const p = await preview('isolated-worktree', 'child')
    expect(p.blocked).toBeUndefined()
    expect(p.source.branch).toBe('main')
    expect(p.destination.repositoryRoot).toBe(realpathSync(harness.repo))
    // The source lease set is evaluated at the canonical repository root.
    expect(p.source.leases).toContain('session-1')
  })

  test('exposes currentHead false for an older fork point and blocks isolated', async () => {
    await managedSession('head-src')
    harness.sessions.set('session-1', {
      ...harness.sessions.get('session-1')!,
      forkPointMessageId: 'msg-0',
    })

    const p = await preview('isolated-worktree', 'child')
    expect(p.blocked?.code).toBe('non-head-source')
    expect(p.currentHead).toBe(false)
  })
})

describe('IsolatedConversationForkService seed capture', () => {
  async function dirtySource(): Promise<{ policyVersion: number; branch: string; headOid: string }> {
    writeFile(harness.repo, 'staged.txt', 'staged\n')
    void git(harness.repo, ['add', 'staged.txt'])
    writeFile(harness.repo, 'unstaged.txt', 'unstaged\n')
    writeFile(harness.repo, 'untracked.txt', 'untracked\n')
    writeFile(harness.repo, '.gitignore', 'secret.txt\n')
    writeFile(harness.repo, '.worktreeinclude', 'secret.txt\n')
    writeFile(harness.repo, 'secret.txt', 'included-secret\n')
    const branch = (await git(harness.repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    const headOid = (await git(harness.repo, ['rev-parse', 'HEAD'])).trim()
    return { policyVersion: harness.svc.worktreeSettings.getSnapshot('local').version, branch, headOid }
  }

  test('captures a fingerprinted seed at the source head without changing the source', async () => {
    currentSession()
    const gitCommonDir = (await git(harness.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
    const { policyVersion, branch, headOid } = await dirtySource()
    const before = await computeWorktreeFingerprint({
      managedWorktreeId: 'seed-test',
      checkoutPath: realpathSync(harness.repo),
      gitCommonDir,
      expectedBranch: branch,
      baseRef: null,
      ownerSessionIds: ['session-1'],
      policyVersion,
      archivedOwnerSessionIds: [],
    })

    const { snapshotId, fingerprint } = await harness.svc.fork.captureForkSeed({
      checkoutPath: realpathSync(harness.repo),
      repositoryRoot: realpathSync(harness.repo),
      gitCommonDir,
      expectedBranch: branch,
      baseRef: null,
      ownerSessionIds: ['session-1'],
      policyVersion,
      previewFingerprint: 'fp-preview',
    })

    expect(snapshotId).toMatch(/^[0-9a-f]{16}$/)
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/)

    // HEAD is pinned by the CAS-created hidden ref.
    const pinned = (await git(harness.repo, ['rev-parse', '--verify', '--quiet', `${WORKTREE_SNAPSHOT_REF_PREFIX}${snapshotId}`])).trim()
    expect(pinned).toBe(headOid)

    // The payload holds staged + unstaged + untracked + include content.
    const manifest = JSON.parse(readFileSync(join(harness.root, 'snapshots', snapshotId, 'manifest.json'), 'utf8')) as {
      headOid: string
      files: Array<{ path: string }>
    }
    expect(manifest.headOid).toBe(headOid)
    const paths = manifest.files.map((f) => f.path)
    expect(paths).toEqual(expect.arrayContaining(['untracked.txt', 'secret.txt']))

    // Source is byte-for-byte unchanged (staged + unstaged + untracked +
    // included state identical after capture).
    const after = await computeWorktreeFingerprint({
      managedWorktreeId: 'seed-test',
      checkoutPath: realpathSync(harness.repo),
      gitCommonDir,
      expectedBranch: branch,
      baseRef: null,
      ownerSessionIds: ['session-1'],
      policyVersion,
      archivedOwnerSessionIds: [],
    })
    expect(after).toBe(before)
  })

  test('removes a seed by deleting only its payload and owned hidden ref', async () => {
    currentSession()
    const gitCommonDir = (await git(harness.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
    const { policyVersion, branch } = await dirtySource()

    const { snapshotId } = await harness.svc.fork.captureForkSeed({
      checkoutPath: realpathSync(harness.repo),
      repositoryRoot: realpathSync(harness.repo),
      gitCommonDir,
      expectedBranch: branch,
      baseRef: null,
      ownerSessionIds: ['session-1'],
      policyVersion,
      previewFingerprint: 'fp-preview',
    })
    expect(existsSync(join(harness.root, 'snapshots', snapshotId))).toBe(true)

    await harness.svc.fork.removeSeed(snapshotId, realpathSync(harness.repo))

    expect(existsSync(join(harness.root, 'snapshots', snapshotId))).toBe(false)
    const refStillThere = await runGit(
      ['rev-parse', '--verify', '--quiet', `${WORKTREE_SNAPSHOT_REF_PREFIX}${snapshotId}`],
      { cwd: harness.repo, okExitCodes: [1, 128] },
    )
    expect(refStillThere.exitCode).not.toBe(0)
    // Source checkout survives seed removal unchanged.
    expect((await git(harness.repo, ['status', '--porcelain'])).trim().length).toBeGreaterThan(0)
  })

  test('maps capture limit failures to a typed fork seed error', async () => {
    currentSession()
    const gitCommonDir = (await git(harness.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
    const { policyVersion, branch } = await dirtySource()
    const big = 'y'.repeat(1024 * 1024)
    for (let i = 0; i < 150; i++) writeFile(harness.repo, `bulk/file-${i}.bin`, `${i}:${big}`)

    let error: unknown
    try {
      await harness.svc.fork.captureForkSeed({
        checkoutPath: realpathSync(harness.repo),
        repositoryRoot: realpathSync(harness.repo),
        gitCommonDir,
        expectedBranch: branch,
        baseRef: null,
        ownerSessionIds: ['session-1'],
        policyVersion,
        previewFingerprint: 'fp-preview',
      })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ConversationForkError)
    expect((error as ConversationForkError).code).toBe('FORK_SEED_LIMIT')
  })
})
