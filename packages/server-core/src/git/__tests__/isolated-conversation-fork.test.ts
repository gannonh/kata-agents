import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, realpathSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import { ConversationForkError, type ConversationForkChildSessionInput } from '../isolated-conversation-fork-service'

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
  childCalls: ConversationForkChildSessionInput[]
  deletedChildren: string[]
  failChildCreation: boolean
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
  const childCalls: ConversationForkChildSessionInput[] = []
  const deletedChildren: string[] = []
  const state = { failChildCreation: false }
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
      // SessionManager implements durable child creation in a later phase;
      // this stub records the call and returns a fake child session id.
      createForkChildSession: async (input) => {
        childCalls.push(input)
        if (state.failChildCreation) throw new Error('simulated child-session creation failure')
        return `child-${childCalls.length}`
      },
      deleteForkChildSession: async (childSessionId) => {
        deletedChildren.push(childSessionId)
      },
    },
  })
  svc.worktreeSettings.update({
    materializationRoot: join(root, 'worktrees'),
    autoDeleteEnabled: false,
    retentionLimit: 15,
  })
  return {
    root,
    repo,
    svc,
    sessions,
    adapters,
    activeSessions,
    childCalls,
    deletedChildren,
    get failChildCreation() {
      return state.failChildCreation
    },
    set failChildCreation(v: boolean) {
      state.failChildCreation = v
    },
  }
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

describe('IsolatedConversationForkService seed capture', () => {

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

// ---------------------------------------------------------------------------
// Confirm — durable target/child transaction core
// ---------------------------------------------------------------------------

/** Source-identity fingerprint mirroring the fork service's binding. */
async function sourceFingerprint(owners: string[] = ['session-1']): Promise<string> {
  const gitCommonDir = (await git(harness.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
  const branch = (await git(harness.repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  return computeWorktreeFingerprint({
    managedWorktreeId: `fork:${realpathSync(harness.repo)}`,
    checkoutPath: realpathSync(harness.repo),
    gitCommonDir,
    expectedBranch: branch,
    baseRef: null,
    ownerSessionIds: owners,
    policyVersion: harness.svc.worktreeSettings.getSnapshot('local').version,
    archivedOwnerSessionIds: [],
  })
}

async function confirmIsolated(previewResult: ConversationForkPreview, nameSuffix: string) {
  return harness.svc.fork.confirm({
    sessionId: 'session-1',
    strategy: 'isolated-worktree',
    transactionId: previewResult.transactionId,
    previewFingerprint: previewResult.previewFingerprint,
    worktreeNameSuffix: nameSuffix,
  })
}

function forkJournalEntries() {
  return harness.svc.journal.entries().filter((entry) => entry.op === 'fork')
}

describe('IsolatedConversationForkService confirm', () => {
  test('commits one child owner + one target worktree at source HEAD with the seed restored', async () => {
    currentSession()
    writeFile(harness.repo, 'staged.txt', 'staged\n')
    await git(harness.repo, ['add', 'staged.txt'])
    writeFile(harness.repo, 'unstaged.txt', 'unstaged\n')
    writeFile(harness.repo, 'untracked.txt', 'untracked\n')
    writeFile(harness.repo, '.gitignore', 'secret.txt\n')
    writeFile(harness.repo, '.worktreeinclude', 'secret.txt\n')
    writeFile(harness.repo, 'secret.txt', 'included-secret\n')
    const headOid = (await git(harness.repo, ['rev-parse', 'HEAD'])).trim()
    const sourceBefore = await sourceFingerprint()

    const p = await preview('isolated-worktree', 'child-one')
    expect(p.blocked).toBeUndefined()
    const result = await confirmIsolated(p, 'child-one')

    expect(result.outcome).toBe('committed')
    if (result.outcome !== 'committed') return
    expect(result.summary.strategy).toBe('isolated-worktree')
    expect(result.summary.childProviderIdPresent).toBe(false)
    expect(result.summary.transcriptCwd).toBe(join(harness.repo, '.kata-transcript'))
    expect(result.summary.checkout.mode).toBe('managed-worktree')
    expect(result.summary.checkout.schemaVersion).toBe(2)
    expect(result.summary.checkout.expectedBranch).toBe('kata-agent/child-one')
    expect(result.summary.executionCwd).toBe(result.summary.checkout.checkoutPath)

    // Exactly one registry owner + one child session + one target worktree.
    const records = harness.svc.registry.list().filter((r) => r.expectedBranch === 'kata-agent/child-one')
    expect(records).toHaveLength(1)
    expect(records[0]?.ownerSessionIds).toEqual([result.summary.sessionId])
    expect(result.summary.sessionId).toMatch(/^child-\d+$/)
    expect((await git(records[0]!.checkoutPath, ['branch', '--show-current'])).trim()).toBe('kata-agent/child-one')
    expect((await git(records[0]!.checkoutPath, ['rev-parse', 'HEAD'])).trim()).toBe(headOid)
    expect(existsSync(records[0]!.checkoutPath)).toBe(true)

    // Seed restored: staged/unstaged/untracked/.worktreeinclude all present.
    const target = records[0]!.checkoutPath
    expect(readFileSync(join(target, 'staged.txt'), 'utf8')).toBe('staged\n')
    expect(readFileSync(join(target, 'unstaged.txt'), 'utf8')).toBe('unstaged\n')
    expect(readFileSync(join(target, 'untracked.txt'), 'utf8')).toBe('untracked\n')
    expect(readFileSync(join(target, 'secret.txt'), 'utf8')).toBe('included-secret\n')
    expect((await git(target, ['diff', '--cached', '--name-only'])).trim()).toContain('staged.txt')
    expect((await git(target, ['status', '--porcelain'])).trim()).toContain('unstaged.txt')

    // Durable journal committed; seed removed; child hook called with the
    // exact target identity; pending-fork intent is NOT persisted here.
    const committed = forkJournalEntries().filter((entry) => entry.status === 'committed')
    expect(committed).toHaveLength(1)
    const seedSnapshotId = committed[0]?.metadata?.seedSnapshotId
    expect(typeof seedSnapshotId).toBe('string')
    expect(existsSync(join(harness.root, 'snapshots', seedSnapshotId as string))).toBe(false)
    expect(harness.childCalls).toHaveLength(1)
    const call = harness.childCalls[0]!
    expect(call.transactionId).toBe(p.transactionId)
    expect(call.parentSessionId).toBe('session-1')
    expect(call.parentSdkSessionId).toBeUndefined()
    expect(call.parentSdkTurnId).toBe('turn-1')
    expect(call.workspaceId).toBe('ws1')
    expect(call.nameSuffix).toBe('child-one')
    expect(call.sourceMessageId).toBe('msg-1')
    expect(call.forkPointMessageId).toBe('msg-1')
    expect(call.transcriptCwd).toBe(join(harness.repo, '.kata-transcript'))
    expect(call.executionCwd).toBe(target)
    expect(call.checkout).toMatchObject({
      mode: 'managed-worktree',
      managedWorktreeId: records[0]!.managedWorktreeId,
      expectedBranch: 'kata-agent/child-one',
    })
    expect(harness.svc.journal.entries().some((entry) => entry.metadata?.pendingIntent)).toBe(false)

    // Source untouched: same HEAD/branch, same index/worktree bytes, same
    // fingerprint, no leftover leases or fences.
    expect((await git(harness.repo, ['branch', '--show-current'])).trim()).toBe('main')
    expect((await git(harness.repo, ['rev-parse', 'HEAD'])).trim()).toBe(headOid)
    expect(await sourceFingerprint()).toBe(sourceBefore)
    expect(harness.svc.fork.isSessionFenced('session-1')).toBe(false)
    expect(harness.svc.pathLeases.leasedBy(realpathSync(harness.repo))).toEqual(['session-1'])
  })

  test('confirms from a shared managed source with every owner leased and leaves source owners unchanged', async () => {
    const record = await managedSession('shared-src-confirm')
    harness.svc.worktrees.addOwner(record.managedWorktreeId, 'session-2')
    harness.svc.pathLeases.lease('session-2', record.checkoutPath)
    writeFile(record.checkoutPath, 'shared-state.txt', 'from source\n')

    const p = await preview('isolated-worktree', 'shared-child')
    expect(p.blocked).toBeUndefined()
    const result = await confirmIsolated(p, 'shared-child')

    expect(result.outcome).toBe('committed')
    if (result.outcome !== 'committed') return
    // Source owners are unchanged; the target is owned solely by the child.
    expect(harness.svc.registry.get(record.managedWorktreeId)?.ownerSessionIds).toEqual(['session-1', 'session-2'])
    const targetRecord = harness.svc.registry.list().find((r) => r.expectedBranch === 'kata-agent/shared-child')
    expect(targetRecord?.ownerSessionIds).toEqual([result.summary.sessionId])
    expect(readFileSync(join(targetRecord!.checkoutPath, 'shared-state.txt'), 'utf8')).toBe('from source\n')
    expect((await git(record.checkoutPath, ['rev-parse', 'HEAD'])).trim()).toBe(
      (await git(targetRecord!.checkoutPath, ['rev-parse', 'HEAD'])).trim(),
    )
  })

  test('blocks confirm when a shared source owner holds no stable lease (path-unleased)', async () => {
    const record = await managedSession('unleased-src')
    harness.svc.worktrees.addOwner(record.managedWorktreeId, 'session-2')
    // session-2 is deliberately NOT leased.

    const p = await preview('isolated-worktree', 'unleased-child')
    expect(p.blocked).toBeUndefined()
    const result = await confirmIsolated(p, 'unleased-child')

    expect(result.outcome).toBe('blocked')
    if (result.outcome === 'blocked') expect(result.code).toBe('path-unleased')
    expect(harness.svc.registry.list().filter((r) => r.expectedBranch === 'kata-agent/unleased-child')).toHaveLength(0)
    expect(existsSync(p.destination.checkoutPath)).toBe(false)
    expect(harness.childCalls).toHaveLength(0)
  })

  test('blocks confirm when a shared source owner becomes active (source-active)', async () => {
    const record = await managedSession('active-src')
    harness.svc.worktrees.addOwner(record.managedWorktreeId, 'session-2')
    harness.svc.pathLeases.lease('session-2', record.checkoutPath)

    const p = await preview('isolated-worktree', 'active-child')
    expect(p.blocked).toBeUndefined()
    harness.activeSessions.add('session-2')
    const result = await confirmIsolated(p, 'active-child')

    expect(result.outcome).toBe('blocked')
    if (result.outcome === 'blocked') expect(result.code).toBe('source-active')
    expect(harness.svc.registry.list().filter((r) => r.expectedBranch === 'kata-agent/active-child')).toHaveLength(0)
    expect(harness.childCalls).toHaveLength(0)
  })

  test('blocks confirm on a name/branch collision appearing after the preview', async () => {
    currentSession()
    const p = await preview('isolated-worktree', 'collide')
    expect(p.blocked).toBeUndefined()
    await git(harness.repo, ['branch', 'kata-agent/collide'])

    const result = await confirmIsolated(p, 'collide')

    expect(result.outcome).toBe('blocked')
    if (result.outcome === 'blocked') expect(result.code).toBe('name-collision')
    expect(harness.svc.registry.list().filter((r) => r.expectedBranch === 'kata-agent/collide')).toHaveLength(0)
    expect(harness.childCalls).toHaveLength(0)
    expect(existsSync(p.destination.checkoutPath)).toBe(false)
  })

  test('blocks confirm on fingerprint drift (file change or nameSuffix change)', async () => {
    currentSession()
    writeFile(harness.repo, 'tracked.txt', 'base\n')
    await git(harness.repo, ['add', 'tracked.txt'])
    await git(harness.repo, ['commit', '-m', 'base'])

    // A source file changed between preview and confirm.
    const p1 = await preview('isolated-worktree', 'drift-one')
    writeFile(harness.repo, 'tracked.txt', 'changed\n')
    const r1 = await confirmIsolated(p1, 'drift-one')
    expect(r1.outcome).toBe('blocked')
    if (r1.outcome === 'blocked') expect(r1.code).toBe('identity-drift')

    // The editable nameSuffix changed between preview and confirm.
    const p2 = await preview('isolated-worktree', 'drift-two')
    const r2 = await confirmIsolated(p2, 'different-name')
    expect(r2.outcome).toBe('blocked')
    if (r2.outcome === 'blocked') expect(r2.code).toBe('identity-drift')

    // No mutation happened for either stale confirmation.
    expect(harness.childCalls).toHaveLength(0)
    expect(harness.svc.registry.list().filter((r) => r.expectedBranch.startsWith('kata-agent/drift'))).toHaveLength(0)
    expect(harness.svc.registry.list().filter((r) => r.expectedBranch === 'kata-agent/different-name')).toHaveLength(0)
  })

  test('fails with a typed hook-not-wired error when child-session creation is not wired', async () => {
    currentSession()
    const bare = createGitServices({
      worktreeRoot: join(harness.root, 'worktrees-bare'),
      registryPath: join(harness.root, 'worktrees-bare', 'registry.json'),
      snapshotsRoot: join(harness.root, 'snapshots-bare'),
      lockDirectory: join(harness.root, 'locks-bare'),
      forkHooks: {
        resolveSession: (sessionId) => harness.sessions.get(sessionId) ?? null,
        resolveCapability: () => ({ adapterId: 'pi-test', strictCrossCwdNativeFork: true }),
        resolveCapabilityAdapter: () => createDeterministicStrictForkAdapter({ adapterId: 'pi-test' }),
        isSessionActive: () => false,
      },
    })
    bare.lifecycle.markReady()
    bare.worktreeSettings.update({
      materializationRoot: join(harness.root, 'worktrees-bare'),
      autoDeleteEnabled: false,
      retentionLimit: 15,
    })
    const p = await bare.fork.preview({ sessionId: 'session-1', strategy: 'isolated-worktree', worktreeNameSuffix: 'bare' })
    expect(p.blocked).toBeUndefined()

    let error: unknown
    try {
      await bare.fork.confirm({
        sessionId: 'session-1',
        strategy: 'isolated-worktree',
        transactionId: p.transactionId,
        previewFingerprint: p.previewFingerprint,
        worktreeNameSuffix: 'bare',
      })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ConversationForkError)
    expect((error as ConversationForkError).code).toBe('FORK_HOOK_NOT_WIRED')
    // The session lease is still required for a current source; nothing mutated.
    expect(existsSync(join(harness.root, 'worktrees-bare'))).toBe(true)
  })

  test('compensates only transaction-owned artifacts on a mid-transaction failure (CAS proof)', async () => {
    currentSession()
    writeFile(harness.repo, 'tracked.txt', 'base\n')
    await git(harness.repo, ['add', 'tracked.txt'])
    await git(harness.repo, ['commit', '-m', 'base'])
    const headOid = (await git(harness.repo, ['rev-parse', 'HEAD'])).trim()
    const externalOid = (await git(harness.repo, ['rev-parse', 'HEAD~1'])).trim()
    const sourceBefore = await sourceFingerprint()

    const p = await preview('isolated-worktree', 'cas-demo')
    expect(p.blocked).toBeUndefined()
    // The child hook fires after target materialization. It advances the
    // target branch to an OID this transaction never created, then fails: the
    // branch is external work and compensation must NOT delete it.
    harness.svc.fork.setHooks({
      createForkChildSession: async () => {
        await runGit(['update-ref', 'refs/heads/kata-agent/cas-demo', externalOid], { cwd: harness.repo })
        throw new Error('simulated mid-transaction failure')
      },
    })

    let error: unknown
    try {
      await confirmIsolated(p, 'cas-demo')
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ConversationForkError)
    expect((error as ConversationForkError).code).toBe('FORK_TARGET_FAILED')

    // The pre-existing/advanced branch survives (CAS proof: it no longer
    // points at the journaled head OID this transaction created).
    const branchOid = (await git(harness.repo, ['rev-parse', '--verify', '--quiet', 'refs/heads/kata-agent/cas-demo'])).trim()
    expect(branchOid).toBe(externalOid)
    // The target checkout + record are gone.
    expect(harness.svc.registry.list().filter((r) => r.expectedBranch === 'kata-agent/cas-demo')).toHaveLength(0)
    expect(existsSync(p.destination.checkoutPath)).toBe(false)
    // The seed is removed and the journal records the rollback.
    const rolledBack = forkJournalEntries().filter((entry) => entry.status === 'recovered')
    expect(rolledBack).toHaveLength(1)
    const seedSnapshotId = rolledBack[0]?.metadata?.seedSnapshotId
    expect(typeof seedSnapshotId).toBe('string')
    expect(existsSync(join(harness.root, 'snapshots', seedSnapshotId as string))).toBe(false)
    // Source untouched.
    expect((await git(harness.repo, ['rev-parse', 'HEAD'])).trim()).toBe(headOid)
    expect(await sourceFingerprint()).toBe(sourceBefore)
    expect(harness.svc.fork.isSessionFenced('session-1')).toBe(false)
  })

  test('compensates a created child session when a post-creation step fails', async () => {
    currentSession()
    writeFile(harness.repo, 'tracked.txt', 'base\n')
    await git(harness.repo, ['add', 'tracked.txt'])
    await git(harness.repo, ['commit', '-m', 'base'])
    const p = await preview('isolated-worktree', 'child-cas')
    expect(p.blocked).toBeUndefined()
    // The child is created, then the target record leaves `ready` before the
    // owner commit — the transaction must compensate the created child too.
    harness.svc.fork.setHooks({
      createForkChildSession: async (input) => {
        harness.svc.registry.setState(input.checkout.managedWorktreeId, 'snapshotted')
        return 'child-created-then-failed'
      },
    })

    let error: unknown
    try {
      await confirmIsolated(p, 'child-cas')
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ConversationForkError)
    expect((error as ConversationForkError).code).toBe('FORK_TARGET_FAILED')
    expect(harness.deletedChildren).toEqual(['child-created-then-failed'])
    expect(harness.svc.registry.list().filter((r) => r.expectedBranch === 'kata-agent/child-cas')).toHaveLength(0)
    expect(existsSync(p.destination.checkoutPath)).toBe(false)
    const branch = await runGit(['rev-parse', '--verify', '--quiet', 'refs/heads/kata-agent/child-cas'], {
      cwd: harness.repo,
      okExitCodes: [1, 128],
    })
    expect(branch.exitCode).not.toBe(0)
    expect(forkJournalEntries().filter((entry) => entry.status === 'recovered')).toHaveLength(1)
  })

  test('replays an interrupted confirm with the same transactionId and commits exactly once', async () => {
    currentSession()
    writeFile(harness.repo, 'tracked.txt', 'base\n')
    await git(harness.repo, ['add', 'tracked.txt'])
    await git(harness.repo, ['commit', '-m', 'base'])
    const p = await preview('isolated-worktree', 'replay')
    expect(p.blocked).toBeUndefined()
    let childCalls = 0
    harness.svc.fork.setHooks({
      createForkChildSession: async () => {
        childCalls++
        if (childCalls === 1) throw new Error('simulated interrupt after target creation')
        return `child-replay-${childCalls}`
      },
    })

    let error: unknown
    try {
      await confirmIsolated(p, 'replay')
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ConversationForkError)
    // The interrupted attempt was fully compensated and journaled as rolled back.
    expect(forkJournalEntries().find((entry) => entry.recordId === p.transactionId)?.status).toBe('recovered')
    expect(harness.svc.registry.list().filter((r) => r.expectedBranch === 'kata-agent/replay')).toHaveLength(0)
    expect(existsSync(p.destination.checkoutPath)).toBe(false)

    // A repeated confirm with the same transactionId resumes from the journal
    // and commits exactly once: one child, one owner, one worktree.
    const result = await confirmIsolated(p, 'replay')
    expect(result.outcome).toBe('committed')
    if (result.outcome !== 'committed') return
    expect(childCalls).toBe(2)
    const records = harness.svc.registry.list().filter((r) => r.expectedBranch === 'kata-agent/replay')
    expect(records).toHaveLength(1)
    expect(records[0]?.ownerSessionIds).toEqual([result.summary.sessionId])
    expect(await git(harness.repo, ['worktree', 'list'])).toContain(records[0]!.checkoutPath)
    expect(forkJournalEntries().filter((entry) => entry.recordId === p.transactionId && entry.status === 'committed')).toHaveLength(1)
    expect(forkJournalEntries().filter((entry) => entry.recordId === p.transactionId)).toHaveLength(2)
  })

  test('a repeat confirm after a durable commit returns the committed summary without double-creating', async () => {
    currentSession()
    const p = await preview('isolated-worktree', 'double-submit')
    expect(p.blocked).toBeUndefined()
    const first = await confirmIsolated(p, 'double-submit')
    expect(first.outcome).toBe('committed')
    if (first.outcome !== 'committed') return

    const second = await confirmIsolated(p, 'double-submit')
    expect(second.outcome).toBe('committed')
    if (second.outcome !== 'committed') return
    expect(second.summary.sessionId).toBe(first.summary.sessionId)
    expect(second.summary.executionCwd).toBe(first.summary.executionCwd)
    expect(harness.svc.registry.list().filter((r) => r.expectedBranch === 'kata-agent/double-submit')).toHaveLength(1)
    expect(harness.childCalls).toHaveLength(1)
  })

  test('continues an in-progress fork journal from the recorded steps (forward replay after restart)', async () => {
    currentSession()
    writeFile(harness.repo, 'tracked.txt', 'base\n')
    await git(harness.repo, ['add', 'tracked.txt'])
    await git(harness.repo, ['commit', '-m', 'base'])
    const p = await preview('isolated-worktree', 'forward-replay')
    expect(p.blocked).toBeUndefined()
    // Simulate a crash after the first journal step: the durable entry is still
    // in-progress with the preview metadata, and the in-memory transaction is
    // gone. A fresh server instance over the same roots must rehydrate the
    // transaction from the journal and complete it exactly once.
    const journalId = harness.svc.journal.inProgress().find((entry) => entry.recordId === p.transactionId)!.journalId
    harness.svc.journal.step(journalId, 'locks-acquired')

    const freshChildCalls: ConversationForkChildSessionInput[] = []
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
        createForkChildSession: async (input) => {
          freshChildCalls.push(input)
          return 'child-forward-replay'
        },
        deleteForkChildSession: async () => undefined,
      },
    })
    fresh.lifecycle.markReady()

    const result = await fresh.fork.confirm({
      sessionId: 'session-1',
      strategy: 'isolated-worktree',
      transactionId: p.transactionId,
      previewFingerprint: p.previewFingerprint,
      worktreeNameSuffix: 'forward-replay',
    })

    expect(result.outcome).toBe('committed')
    if (result.outcome !== 'committed') return
    expect(freshChildCalls).toHaveLength(1)
    const records = fresh.registry.list().filter((r) => r.expectedBranch === 'kata-agent/forward-replay')
    expect(records).toHaveLength(1)
    expect(records[0]?.ownerSessionIds).toEqual(['child-forward-replay'])
    expect(harness.svc.registry.list().filter((r) => r.expectedBranch === 'kata-agent/forward-replay')).toHaveLength(1)
    expect(forkJournalEntries().filter((entry) => entry.recordId === p.transactionId && entry.status === 'committed')).toHaveLength(1)
  })

  test('resumes a fork journal that crashed after target materialization (own destination is not a name-collision)', async () => {
    currentSession()
    writeFile(harness.repo, 'tracked.txt', 'base\n')
    await git(harness.repo, ['add', 'tracked.txt'])
    await git(harness.repo, ['commit', '-m', 'base'])
    const p = await preview('isolated-worktree', 'crash-materialized')
    expect(p.blocked).toBeUndefined()
    if (p.blocked) return

    const gitCommonDir = (await git(harness.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
    const headOid = (await git(harness.repo, ['rev-parse', 'HEAD'])).trim()
    const branch = (await git(harness.repo, ['branch', '--show-current'])).trim()
    const entry = forkJournalEntries().find((e) => e.recordId === p.transactionId)!
    const journalId = entry.journalId
    const pathToken = entry.metadata?.pathToken as string
    const journal = harness.svc.journal

    // Drive the durable journal to the exact post-materialization state a crash
    // would leave: steps recorded through target-verified, a real target
    // worktree materialized, a real seed captured and restored into it. The
    // in-memory transaction is gone (server restarted).
    journal.step(journalId, 'locks-acquired')
    journal.step(journalId, 'source-quiesced')
    const seed = await harness.svc.fork.captureForkSeed({
      checkoutPath: realpathSync(harness.repo),
      repositoryRoot: realpathSync(harness.repo),
      gitCommonDir,
      expectedBranch: branch,
      baseRef: null,
      ownerSessionIds: ['session-1'],
      policyVersion: harness.svc.worktreeSettings.getSnapshot().version,
      previewFingerprint: p.previewFingerprint,
    })
    journal.updateMetadata(journalId, {
      state: 'seed-captured',
      seedSnapshotId: seed.snapshotId,
      seedFingerprint: seed.fingerprint,
      headOid,
    })
    journal.step(journalId, 'seed-captured')

    const created = await harness.svc.worktrees.createWorktree({
      workspaceId: 'ws1',
      sessionId: 'session-1',
      repositoryRoot: realpathSync(harness.repo),
      gitCommonDir,
      baseRef: headOid,
      worktreeNameSuffix: 'crash-materialized',
      pathToken,
      lockAlreadyHeld: true,
    })
    journal.updateMetadata(journalId, {
      state: 'target-materialized',
      managedWorktreeId: created.record.managedWorktreeId,
    })
    journal.step(journalId, 'target-materialized')

    const seedMeta = harness.svc.snapshots.loadSnapshotMeta(seed.snapshotId)
    expect(seedMeta).toBeTruthy()
    if (!seedMeta) return
    await harness.svc.snapshots.applySnapshotToCheckout({
      meta: seedMeta,
      checkoutPath: created.record.checkoutPath,
    })
    journal.step(journalId, 'target-restored')
    journal.step(journalId, 'target-verified')

    // A fresh server instance over the same roots must rehydrate the
    // transaction and resume WITHOUT treating the transaction's own
    // materialized destination as a name-collision, and without creating a
    // second target/child/owner.
    const freshChildCalls: ConversationForkChildSessionInput[] = []
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
        createForkChildSession: async (input) => {
          freshChildCalls.push(input)
          return 'child-crash-resume'
        },
        deleteForkChildSession: async () => undefined,
      },
    })
    fresh.lifecycle.markReady()

    const result = await fresh.fork.confirm({
      sessionId: 'session-1',
      strategy: 'isolated-worktree',
      transactionId: p.transactionId,
      previewFingerprint: p.previewFingerprint,
      worktreeNameSuffix: 'crash-materialized',
    })

    expect(result.outcome).toBe('committed')
    if (result.outcome !== 'committed') return
    expect(freshChildCalls).toHaveLength(1)
    const records = fresh.registry.list().filter((r) => r.expectedBranch === 'kata-agent/crash-materialized')
    expect(records).toHaveLength(1)
    expect(records[0]?.managedWorktreeId).toBe(created.record.managedWorktreeId)
    expect(records[0]?.ownerSessionIds).toEqual(['child-crash-resume'])
    expect(
      harness.svc.registry.list().filter((r) => r.expectedBranch === 'kata-agent/crash-materialized'),
    ).toHaveLength(1)
    expect(forkJournalEntries().find((e) => e.recordId === p.transactionId)?.status).toBe('committed')
    // The seed is released only after the durable commit.
    expect(existsSync(join(harness.root, 'snapshots', seed.snapshotId))).toBe(false)
  })
})

describe('IsolatedConversationForkService fork-journal GC retention', () => {
  test('retains an in-progress fork journal seed through orphan GC and releases it after resolution', async () => {
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
      previewFingerprint: 'fp-gc',
    })
    expect(existsSync(join(harness.root, 'snapshots', snapshotId))).toBe(true)
    const entry = harness.svc.journal.begin({
      op: 'fork',
      recordId: 'a'.repeat(16),
      sessionIds: ['session-1'],
      policyVersion,
      metadata: { seedSnapshotId: snapshotId, state: 'seed-captured' },
    })
    // An unrelated orphan payload must still be swept.
    const orphan = join(harness.root, 'snapshots', 'b'.repeat(16))
    mkdirSync(orphan, { recursive: true })
    writeFileSync(join(orphan, 'manifest.json'), '{}')

    await harness.svc.lifecycle.reconcileJournal()

    // The in-progress fork journal entry's seed survives GC.
    expect(existsSync(join(harness.root, 'snapshots', snapshotId))).toBe(true)
    expect(existsSync(orphan)).toBe(false)

    // After the journal commits nothing retains the seed: GC removes it.
    harness.svc.journal.commit(entry.journalId, 'gc-test-commit')
    await harness.svc.lifecycle.reconcileJournal()
    expect(existsSync(join(harness.root, 'snapshots', snapshotId))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Status / cancel / recover — the recovery and cancellation surface
// ---------------------------------------------------------------------------

function freshServicesWithChildRecording(childCalls: ConversationForkChildSessionInput[], childId: string) {
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
      createForkChildSession: async (input) => {
        childCalls.push(input)
        return childId
      },
      deleteForkChildSession: async () => undefined,
    },
  })
  fresh.lifecycle.markReady()
  return fresh
}

/**
 * Drive a confirm into a durable FAILED (recovery-required) state: the child
 * is created, then the target record leaves `ready` before the owner commit,
 * and compensation then fails (the child-removal hook throws). Mirrors the
 * existing compensation-failure test pattern with compensation itself failing,
 * which is exactly the state a real FORK_COMPENSATION_FAILED leaves behind.
 */
async function compensationFailedFork(nameSuffix: string): Promise<ConversationForkPreview> {
  writeFile(harness.repo, 'tracked.txt', 'base\n')
  await git(harness.repo, ['add', 'tracked.txt'])
  await git(harness.repo, ['commit', '-m', 'base'])
  const p = await preview('isolated-worktree', nameSuffix)
  expect(p.blocked).toBeUndefined()
  if (p.blocked) return p
  harness.svc.fork.setHooks({
    createForkChildSession: async (input) => {
      harness.svc.registry.setState(input.checkout.managedWorktreeId, 'snapshotted')
      return `child-${nameSuffix}`
    },
    deleteForkChildSession: async () => {
      throw new Error('simulated compensation failure')
    },
  })
  let error: unknown
  try {
    await confirmIsolated(p, nameSuffix)
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(ConversationForkError)
  expect((error as ConversationForkError).code).toBe('FORK_COMPENSATION_FAILED')
  const entry = forkJournalEntries().find((e) => e.recordId === p.transactionId)
  expect(entry?.status).toBe('failed')
  expect(entry?.metadata?.state).toBe('recovery-required')
  return p
}

describe('IsolatedConversationForkService status', () => {
  test('reports active:false for a session with no fork transaction', async () => {
    currentSession()

    expect(await harness.svc.fork.status({ sessionId: 'session-1' })).toEqual({ active: false })
  })

  test('reports an active pending transaction after preview (in-memory and durable)', async () => {
    currentSession()

    const p = await preview('isolated-worktree', 'status-pending')
    expect(p.blocked).toBeUndefined()

    const status = await harness.svc.fork.status({ sessionId: 'session-1' })
    expect(status).toMatchObject({
      active: true,
      transactionId: p.transactionId,
      strategy: 'isolated-worktree',
      state: 'pending',
      providerIdentity: { status: 'pending' },
    })
    if (status.active) expect(status.since).toBeGreaterThan(0)

    // The preview transaction is durably journaled as in-progress.
    expect(forkJournalEntries().find((e) => e.recordId === p.transactionId)?.status).toBe('in-progress')
  })

  test('rehydrates an active transaction from the journal after a restart', async () => {
    currentSession()

    const p = await preview('isolated-worktree', 'status-rehydrate')
    expect(p.blocked).toBeUndefined()

    const fresh = freshServicesWithChildRecording([], 'child-unused')
    const status = await fresh.fork.status({ sessionId: 'session-1' })

    expect(status).toMatchObject({
      active: true,
      transactionId: p.transactionId,
      strategy: 'isolated-worktree',
      state: 'pending',
    })
    if (status.active) expect(status.since).toBeGreaterThan(0)
    expect(fresh.fork.isSessionFenced('session-1')).toBe(false)
  })

  test('status reports recovery-required for a compensation-failed transaction', async () => {
    currentSession()

    const p = await compensationFailedFork('recovery-required-status')
    if (p.blocked) return

    // The durable entry is failed with recovery-required metadata and the
    // in-memory transaction is still present: status must surface the durable
    // recovery-required state, not the stale in-memory step state, and the
    // fence stays held until the recovery-required state resolves.
    const status = await harness.svc.fork.status({ sessionId: 'session-1' })
    expect(status).toMatchObject({
      active: true,
      transactionId: p.transactionId,
      strategy: 'isolated-worktree',
      state: 'recovery-required',
    })
    if (status.active) expect(status.since).toBeGreaterThan(0)
    expect(harness.svc.fork.isSessionFenced('session-1')).toBe(true)
  })
})

describe('IsolatedConversationForkService cancel', () => {
  test('cancel makes status inactive and a re-preview works (stale-journal gap regression)', async () => {
    currentSession()

    const p = await preview('isolated-worktree', 'cancel-repreview')
    expect(p.blocked).toBeUndefined()
    expect(forkJournalEntries().filter((e) => e.status === 'in-progress')).toHaveLength(1)

    const cancelled = await harness.svc.fork.cancel({ sessionId: 'session-1', transactionId: p.transactionId })
    expect(cancelled).toEqual({ active: false })
    expect(await harness.svc.fork.status({ sessionId: 'session-1' })).toEqual({ active: false })

    // The durable entry is recovered with the preview-cancelled marker: a
    // restarted server must NOT block a new preview on this session (the Task 2
    // review gap: a dismissed preview previously left a durable in-progress
    // fork entry that blocked re-preview forever after restart).
    const cancelledEntry = forkJournalEntries().find((e) => e.recordId === p.transactionId)
    expect(cancelledEntry?.status).toBe('recovered')
    expect(cancelledEntry?.commitMarker).toBe('preview-cancelled')
    expect(cancelledEntry?.metadata?.state).toBe('preview-cancelled')

    const fresh = freshServicesWithChildRecording([], 'child-unused')
    expect(await fresh.fork.status({ sessionId: 'session-1' })).toEqual({ active: false })

    const again = await preview('isolated-worktree', 'cancel-repreview')
    expect(again.blocked).toBeUndefined()
    expect(again.transactionId).not.toBe(p.transactionId)
    expect(forkJournalEntries().filter((e) => e.recordId === again.transactionId && e.status === 'in-progress')).toHaveLength(1)
  })

  test('cancel releases the session and path fences held by a pending preview', async () => {
    currentSession()

    const p = await preview('isolated-worktree', 'cancel-fence')
    expect(p.blocked).toBeUndefined()
    expect(harness.svc.fork.isSessionFenced('session-1')).toBe(true)
    expect(harness.svc.fork.isPathFenced(realpathSync(harness.repo))).toBe(true)
    expect(harness.svc.fork.isPathFenced(p.destination.checkoutPath)).toBe(true)

    await harness.svc.fork.cancel({ sessionId: 'session-1', transactionId: p.transactionId })

    expect(harness.svc.fork.isSessionFenced('session-1')).toBe(false)
    expect(harness.svc.fork.isPathFenced(realpathSync(harness.repo))).toBe(false)
    expect(harness.svc.fork.isPathFenced(p.destination.checkoutPath)).toBe(false)
  })

  test('cancel on an unknown transaction id is a no-op returning the current status', async () => {
    currentSession()

    expect(await harness.svc.fork.cancel({ sessionId: 'session-1', transactionId: 'c'.repeat(16) })).toEqual({
      active: false,
    })
  })

  test('cancel refuses a failed (recovery-required) entry on both in-memory and restarted paths', async () => {
    currentSession()

    const p = await compensationFailedFork('cancel-refused-failed')
    if (p.blocked) return

    // In-process: the failed entry is still in the map and fenced; cancel must
    // refuse (nothing to cancel) and report the recovery-required status.
    const cancelled = await harness.svc.fork.cancel({ sessionId: 'session-1', transactionId: p.transactionId })
    expect(cancelled).toMatchObject({ active: true, transactionId: p.transactionId, state: 'recovery-required' })
    expect(forkJournalEntries().find((e) => e.recordId === p.transactionId)?.status).toBe('failed')
    expect(harness.svc.fork.isSessionFenced('session-1')).toBe(true)

    // After restart: the durable failed entry is still not cancellable and the
    // entry is left untouched (a new preview is still gated by the leftover
    // recovery state rather than a bogus cancel).
    const fresh = freshServicesWithChildRecording([], 'child-unused')
    const cancelledFresh = await fresh.fork.cancel({ sessionId: 'session-1', transactionId: p.transactionId })
    expect(cancelledFresh.active).toBe(false)
    expect(forkJournalEntries().find((e) => e.recordId === p.transactionId)?.status).toBe('failed')
  })

  test('cancel that wins the mutation lock first aborts the queued confirm (no child on a cancelled entry)', async () => {
    currentSession()
    writeFile(harness.repo, 'tracked.txt', 'base\n')
    await git(harness.repo, ['add', 'tracked.txt'])
    await git(harness.repo, ['commit', '-m', 'base'])
    const p = await preview('isolated-worktree', 'cancel-wins-race')
    expect(p.blocked).toBeUndefined()
    if (p.blocked) return
    const gitCommonDir = (await git(harness.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()

    // Hold the mutation lock so both the cancel and the confirm queue behind
    // it in FIFO order (cancel first). When released, cancel must cancel the
    // pure pending preview, and the queued confirm must abort with a typed
    // error instead of durably committing a child the journal no longer
    // records.
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const gateHeld = harness.svc.mutationLock.withLock(gitCommonDir, async () => {
      await gate
    })
    const cancelP = harness.svc.fork.cancel({ sessionId: 'session-1', transactionId: p.transactionId })
    const confirmP = harness.svc.fork
      .confirm({
        sessionId: 'session-1',
        strategy: 'isolated-worktree',
        transactionId: p.transactionId,
        previewFingerprint: p.previewFingerprint,
        worktreeNameSuffix: 'cancel-wins-race',
      })
      .then(
        (result) => ({ result }),
        (error) => ({ error }),
      )
    releaseGate()
    await gateHeld
    const [cancelResult, confirmOutcome] = await Promise.all([cancelP, confirmP])

    expect(cancelResult).toEqual({ active: false })
    expect('error' in confirmOutcome).toBe(true)
    if ('error' in confirmOutcome) {
      expect(confirmOutcome.error).toBeInstanceOf(ConversationForkError)
      expect((confirmOutcome.error as ConversationForkError).code).toBe('FORK_TRANSACTION_UNKNOWN')
    }
    const entry = forkJournalEntries().find((e) => e.recordId === p.transactionId)
    expect(entry?.status).toBe('recovered')
    expect(entry?.commitMarker).toBe('preview-cancelled')
    expect(harness.childCalls).toHaveLength(0)
  })

  test('confirm that wins the mutation lock first makes the queued cancel refuse (entry stays committed)', async () => {
    currentSession()
    writeFile(harness.repo, 'tracked.txt', 'base\n')
    await git(harness.repo, ['add', 'tracked.txt'])
    await git(harness.repo, ['commit', '-m', 'base'])
    const p = await preview('isolated-worktree', 'confirm-wins-race')
    expect(p.blocked).toBeUndefined()
    if (p.blocked) return
    const gitCommonDir = (await git(harness.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()

    // FIFO order: confirm queues first, cancel second. Confirm commits
    // durably; the queued cancel then sees the first journal step and refuses
    // instead of cancelling a committed transaction.
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const gateHeld = harness.svc.mutationLock.withLock(gitCommonDir, async () => {
      await gate
    })
    const confirmP = harness.svc.fork.confirm({
      sessionId: 'session-1',
      strategy: 'isolated-worktree',
      transactionId: p.transactionId,
      previewFingerprint: p.previewFingerprint,
      worktreeNameSuffix: 'confirm-wins-race',
    })
    const cancelP = harness.svc.fork.cancel({ sessionId: 'session-1', transactionId: p.transactionId })
    releaseGate()
    await gateHeld
    const [confirmResult, cancelResult] = await Promise.all([confirmP, cancelP])

    expect(confirmResult.outcome).toBe('committed')
    expect(cancelResult).toEqual({ active: false })
    const entry = forkJournalEntries().find((e) => e.recordId === p.transactionId)
    expect(entry?.status).toBe('committed')
    expect(entry?.commitMarker).toBe(p.transactionId)
    expect(harness.childCalls).toHaveLength(1)
  })
})

describe('IsolatedConversationForkService recover', () => {
  test('recover with an unknown transactionId throws a typed fork error', async () => {
    currentSession()

    let error: unknown
    try {
      await harness.svc.fork.recover({ sessionId: 'session-1', transactionId: 'f'.repeat(16) })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ConversationForkError)
    expect((error as ConversationForkError).code).toBe('FORK_TRANSACTION_UNKNOWN')
  })

  test('recover and confirm on a failed (recovery-required) entry throw the same typed fork error in-process', async () => {
    currentSession()

    const p = await compensationFailedFork('recover-failed-inprocess')
    if (p.blocked) return

    // The failed entry must not be silently reset and re-run over possibly
    // uncompensated artifacts (the old in-memory beginFreshAttempt bug): both
    // recover and confirm surface the typed transaction-unknown error, exactly
    // like the durable failed entry does after a restart.
    let recoverError: unknown
    try {
      await harness.svc.fork.recover({ sessionId: 'session-1', transactionId: p.transactionId })
    } catch (caught) {
      recoverError = caught
    }
    expect(recoverError).toBeInstanceOf(ConversationForkError)
    expect((recoverError as ConversationForkError).code).toBe('FORK_TRANSACTION_UNKNOWN')

    let confirmError: unknown
    try {
      await confirmIsolated(p, 'recover-failed-inprocess')
    } catch (caught) {
      confirmError = caught
    }
    expect(confirmError).toBeInstanceOf(ConversationForkError)
    expect((confirmError as ConversationForkError).code).toBe('FORK_TRANSACTION_UNKNOWN')

    // Nothing re-ran: still one failed entry, no fresh journal entry, no new
    // child creation attempt beyond the original failure.
    expect(forkJournalEntries().filter((e) => e.recordId === p.transactionId)).toHaveLength(1)
  })

  test('recover on a failed (recovery-required) entry after restart throws the same typed fork error', async () => {
    currentSession()

    const p = await compensationFailedFork('recover-failed-restart')
    if (p.blocked) return

    const fresh = freshServicesWithChildRecording([], 'child-unused')
    let error: unknown
    try {
      await fresh.fork.recover({ sessionId: 'session-1', transactionId: p.transactionId })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ConversationForkError)
    expect((error as ConversationForkError).code).toBe('FORK_TRANSACTION_UNKNOWN')
    // The durable failed entry is untouched.
    expect(forkJournalEntries().find((e) => e.recordId === p.transactionId)?.status).toBe('failed')
  })

  test('recover on a committed entry returns the committed summary without re-creating anything', async () => {
    currentSession()

    const p = await preview('isolated-worktree', 'recover-committed')
    expect(p.blocked).toBeUndefined()
    const first = await confirmIsolated(p, 'recover-committed')
    expect(first.outcome).toBe('committed')
    if (first.outcome !== 'committed') return

    const rec = await harness.svc.fork.recover({ sessionId: 'session-1', transactionId: p.transactionId })

    expect(rec.outcome).toBe('committed')
    if (rec.outcome !== 'committed') return
    expect(rec.summary.sessionId).toBe(first.summary.sessionId)
    expect(rec.summary.executionCwd).toBe(first.summary.executionCwd)
    expect(rec.summary.committedAt).toBe(first.summary.committedAt)
    // Nothing re-created: still exactly one target, one child call, one owner.
    expect(harness.svc.registry.list().filter((r) => r.expectedBranch === 'kata-agent/recover-committed')).toHaveLength(1)
    expect(harness.childCalls).toHaveLength(1)
  })

  test('recover after a rolled-back entry starts a fresh attempt and commits exactly once', async () => {
    currentSession()
    writeFile(harness.repo, 'tracked.txt', 'base\n')
    await git(harness.repo, ['add', 'tracked.txt'])
    await git(harness.repo, ['commit', '-m', 'base'])

    const p = await preview('isolated-worktree', 'recover-rolled-back')
    expect(p.blocked).toBeUndefined()
    let childCalls = 0
    harness.svc.fork.setHooks({
      createForkChildSession: async () => {
        childCalls++
        if (childCalls === 1) throw new Error('simulated interrupt')
        return `child-rolled-back-${childCalls}`
      },
    })
    let error: unknown
    try {
      await confirmIsolated(p, 'recover-rolled-back')
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(ConversationForkError)
    // The interrupted attempt was fully compensated and journaled rolled-back.
    const rolledBack = forkJournalEntries().find((e) => e.recordId === p.transactionId)
    expect(rolledBack?.status).toBe('recovered')
    expect(rolledBack?.commitMarker).toBe('rolled-back')
    expect(harness.svc.registry.list().filter((r) => r.expectedBranch === 'kata-agent/recover-rolled-back')).toHaveLength(0)
    expect(existsSync(p.destination.checkoutPath)).toBe(false)

    // Recover re-enters the confirm machinery as a fresh attempt (the
    // rolled-back entry's artifacts are fully compensated) and commits once.
    const rec = await harness.svc.fork.recover({ sessionId: 'session-1', transactionId: p.transactionId })

    expect(rec.outcome).toBe('committed')
    if (rec.outcome !== 'committed') return
    expect(childCalls).toBe(2)
    const records = harness.svc.registry.list().filter((r) => r.expectedBranch === 'kata-agent/recover-rolled-back')
    expect(records).toHaveLength(1)
    expect(records[0]?.ownerSessionIds).toEqual([rec.summary.sessionId])
    expect(await git(harness.repo, ['worktree', 'list'])).toContain(records[0]!.checkoutPath)
    expect(forkJournalEntries().filter((e) => e.recordId === p.transactionId && e.status === 'committed')).toHaveLength(1)
    expect(forkJournalEntries().filter((e) => e.recordId === p.transactionId)).toHaveLength(2)
    expect(harness.svc.fork.isSessionFenced('session-1')).toBe(false)
  })

  test('cancel does NOT cancel an in-progress confirm and recover completes it exactly once', async () => {
    currentSession()
    writeFile(harness.repo, 'tracked.txt', 'base\n')
    await git(harness.repo, ['add', 'tracked.txt'])
    await git(harness.repo, ['commit', '-m', 'base'])

    const p = await preview('isolated-worktree', 'in-progress-cancel')
    expect(p.blocked).toBeUndefined()
    if (p.blocked) return
    const entry = forkJournalEntries().find((e) => e.recordId === p.transactionId)!
    const journalId = entry.journalId
    const journal = harness.svc.journal
    const gitCommonDir = (await git(harness.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
    const headOid = (await git(harness.repo, ['rev-parse', 'HEAD'])).trim()
    const branch = (await git(harness.repo, ['branch', '--show-current'])).trim()

    // Drive the durable journal past the preview (seed-captured), as a crash
    // after seed capture would leave it.
    journal.step(journalId, 'locks-acquired')
    journal.step(journalId, 'source-quiesced')
    const seed = await harness.svc.fork.captureForkSeed({
      checkoutPath: realpathSync(harness.repo),
      repositoryRoot: realpathSync(harness.repo),
      gitCommonDir,
      expectedBranch: branch,
      baseRef: null,
      ownerSessionIds: ['session-1'],
      policyVersion: harness.svc.worktreeSettings.getSnapshot().version,
      previewFingerprint: p.previewFingerprint,
    })
    journal.updateMetadata(journalId, {
      state: 'seed-captured',
      seedSnapshotId: seed.snapshotId,
      seedFingerprint: seed.fingerprint,
      headOid,
    })
    journal.step(journalId, 'seed-captured')

    // In-process cancel must refuse: the transaction is past pending.
    const cancelResult = await harness.svc.fork.cancel({ sessionId: 'session-1', transactionId: p.transactionId })
    expect(cancelResult.active).toBe(true)
    if (cancelResult.active) expect(cancelResult.transactionId).toBe(p.transactionId)
    // The transaction stays in the map (still fenced, still recoverable).
    expect(harness.svc.fork.isSessionFenced('session-1')).toBe(true)
    const durable = forkJournalEntries().find((e) => e.recordId === p.transactionId)
    expect(durable?.status).toBe('in-progress')
    expect(durable?.metadata?.state).toBe('seed-captured')

    // A restarted server sees the same durable state: the fork is recoverable.
    const freshChildCalls: ConversationForkChildSessionInput[] = []
    const fresh = freshServicesWithChildRecording(freshChildCalls, 'child-seed-captured-recover')
    const status = await fresh.fork.status({ sessionId: 'session-1' })
    expect(status).toMatchObject({ active: true, transactionId: p.transactionId, state: 'seed-captured' })

    const rec = await fresh.fork.recover({ sessionId: 'session-1', transactionId: p.transactionId })

    expect(rec.outcome).toBe('committed')
    if (rec.outcome !== 'committed') return
    expect(freshChildCalls).toHaveLength(1)
    const records = fresh.registry.list().filter((r) => r.expectedBranch === 'kata-agent/in-progress-cancel')
    expect(records).toHaveLength(1)
    expect(records[0]?.ownerSessionIds).toEqual(['child-seed-captured-recover'])
    expect(
      harness.svc.registry.list().filter((r) => r.expectedBranch === 'kata-agent/in-progress-cancel'),
    ).toHaveLength(1)
    expect(forkJournalEntries().find((e) => e.recordId === p.transactionId)?.status).toBe('committed')
    expect(existsSync(join(harness.root, 'snapshots', seed.snapshotId))).toBe(false)
  })

  test('recover resumes a fork journal that crashed after target materialization exactly once', async () => {
    currentSession()
    writeFile(harness.repo, 'tracked.txt', 'base\n')
    await git(harness.repo, ['add', 'tracked.txt'])
    await git(harness.repo, ['commit', '-m', 'base'])

    const p = await preview('isolated-worktree', 'crash-materialized-recover')
    expect(p.blocked).toBeUndefined()
    if (p.blocked) return
    const gitCommonDir = (await git(harness.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
    const headOid = (await git(harness.repo, ['rev-parse', 'HEAD'])).trim()
    const branch = (await git(harness.repo, ['branch', '--show-current'])).trim()
    const entry = forkJournalEntries().find((e) => e.recordId === p.transactionId)!
    const journalId = entry.journalId
    const pathToken = entry.metadata?.pathToken as string
    const journal = harness.svc.journal

    // Drive the durable journal to the exact post-materialization state a crash
    // would leave: steps recorded through target-verified, a real target
    // worktree materialized, a real seed captured and restored into it.
    journal.step(journalId, 'locks-acquired')
    journal.step(journalId, 'source-quiesced')
    const seed = await harness.svc.fork.captureForkSeed({
      checkoutPath: realpathSync(harness.repo),
      repositoryRoot: realpathSync(harness.repo),
      gitCommonDir,
      expectedBranch: branch,
      baseRef: null,
      ownerSessionIds: ['session-1'],
      policyVersion: harness.svc.worktreeSettings.getSnapshot().version,
      previewFingerprint: p.previewFingerprint,
    })
    journal.updateMetadata(journalId, {
      state: 'seed-captured',
      seedSnapshotId: seed.snapshotId,
      seedFingerprint: seed.fingerprint,
      headOid,
    })
    journal.step(journalId, 'seed-captured')

    const created = await harness.svc.worktrees.createWorktree({
      workspaceId: 'ws1',
      sessionId: 'session-1',
      repositoryRoot: realpathSync(harness.repo),
      gitCommonDir,
      baseRef: headOid,
      worktreeNameSuffix: 'crash-materialized-recover',
      pathToken,
      lockAlreadyHeld: true,
    })
    journal.updateMetadata(journalId, {
      state: 'target-materialized',
      managedWorktreeId: created.record.managedWorktreeId,
    })
    journal.step(journalId, 'target-materialized')

    const seedMeta = harness.svc.snapshots.loadSnapshotMeta(seed.snapshotId)
    expect(seedMeta).toBeTruthy()
    if (!seedMeta) return
    await harness.svc.snapshots.applySnapshotToCheckout({
      meta: seedMeta,
      checkoutPath: created.record.checkoutPath,
    })
    journal.step(journalId, 'target-restored')
    journal.step(journalId, 'target-verified')

    // A fresh server instance must rehydrate and resume WITHOUT treating the
    // transaction's own materialized destination as a name-collision, and
    // without creating a second target/child/owner.
    const freshChildCalls: ConversationForkChildSessionInput[] = []
    const fresh = freshServicesWithChildRecording(freshChildCalls, 'child-crash-materialized-recover')

    const result = await fresh.fork.recover({ sessionId: 'session-1', transactionId: p.transactionId })

    expect(result.outcome).toBe('committed')
    if (result.outcome !== 'committed') return
    expect(freshChildCalls).toHaveLength(1)
    const records = fresh.registry.list().filter((r) => r.expectedBranch === 'kata-agent/crash-materialized-recover')
    expect(records).toHaveLength(1)
    expect(records[0]?.managedWorktreeId).toBe(created.record.managedWorktreeId)
    expect(records[0]?.ownerSessionIds).toEqual(['child-crash-materialized-recover'])
    expect(
      harness.svc.registry.list().filter((r) => r.expectedBranch === 'kata-agent/crash-materialized-recover'),
    ).toHaveLength(1)
    expect(forkJournalEntries().find((e) => e.recordId === p.transactionId)?.status).toBe('committed')
    expect(existsSync(join(harness.root, 'snapshots', seed.snapshotId))).toBe(false)
  })

  test('markEstablished records the child provider identity on the committed journal entry (metadata-only)', async () => {
    currentSession()
    const p = await preview('isolated-worktree', 'established-child')
    expect(p.blocked).toBeUndefined()
    const result = await confirmIsolated(p, 'established-child')
    expect(result.outcome).toBe('committed')
    if (result.outcome !== 'committed') return

    const entry = forkJournalEntries().find((e) => e.recordId === p.transactionId)!
    expect(entry.status).toBe('committed')
    expect(entry.metadata?.state).not.toBe('established')

    // First-Send establishment records the provider child ID on the same
    // committed entry without changing its status.
    harness.svc.fork.markEstablished(p.transactionId, 'sdk-child-xyz')

    const updated = forkJournalEntries().find((e) => e.recordId === p.transactionId)!
    expect(updated.status).toBe('committed')
    expect(updated.metadata?.state).toBe('established')
    expect(updated.metadata?.childSdkSessionId).toBe('sdk-child-xyz')
    expect(typeof updated.metadata?.establishedAt).toBe('number')
  })

  test('markEstablished for an unknown/missing transaction is a no-op (child session record is authoritative)', async () => {
    currentSession()
    expect(() => harness.svc.fork.markEstablished('no-such-transaction', 'sdk-child-ghost')).not.toThrow()
    expect(forkJournalEntries().some((e) => e.metadata?.state === 'established')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Startup reconciliation — fork journal classification + establish backfill
// ---------------------------------------------------------------------------

/** Begin a durable fork journal entry in an arbitrary crash-left state. */
function journalFork(opts: {
  recordId: string
  childSessionId?: string
  steps?: string[]
  status?: 'in-progress' | 'committed' | 'failed'
  state?: string
}): void {
  const entry = harness.svc.journal.begin({
    op: 'fork',
    recordId: opts.recordId,
    sessionIds: ['session-1'],
    policyVersion: harness.svc.worktreeSettings.getSnapshot('local').version,
    metadata: {
      transactionId: opts.recordId,
      strategy: 'isolated-worktree',
      state: opts.state ?? 'pending',
      ...(opts.childSessionId ? { childSessionId: opts.childSessionId } : {}),
    },
  })
  for (const step of opts.steps ?? []) harness.svc.journal.step(entry.journalId, step)
  if (opts.status === 'committed') harness.svc.journal.commit(entry.journalId, opts.recordId)
  if (opts.status === 'failed') harness.svc.journal.fail(entry.journalId, 'test failure')
}

const CHILD_CREATED_STEPS = [
  'locks-acquired',
  'source-quiesced',
  'seed-captured',
  'destination-leased',
  'target-materialized',
  'target-restored',
  'target-verified',
  'child-created',
]

function forkStateResolver(
  states: Map<string, import('../isolated-conversation-fork-service').SessionForkState>,
) {
  return (sessionId: string) => states.get(sessionId) ?? null
}

describe('IsolatedConversationForkService startup reconciliation', () => {
  test('classifies committed entries as committed and never touches them', async () => {
    currentSession()
    journalFork({
      recordId: 'a'.repeat(16),
      steps: ['child-created', 'owner-committed'],
      status: 'committed',
      state: 'binding-committed',
      childSessionId: 'child-a',
    })

    const report = await harness.svc.fork.reconcileForkJournal()

    const entry = forkJournalEntries().find((e) => e.recordId === 'a'.repeat(16))
    expect(entry?.status).toBe('committed')
    expect(entry?.metadata?.state).toBe('binding-committed')
    expect(report).toEqual({ resumed: 0, recovered: 0, recoveryRequired: 0 })
  })

  test('classifies a child-created in-progress entry as recovery-required when no live pending child owns it', async () => {
    currentSession()
    journalFork({
      recordId: 'b'.repeat(16),
      steps: CHILD_CREATED_STEPS,
      state: 'target-materialized',
      childSessionId: 'child-b',
    })

    const report = await harness.svc.fork.reconcileForkJournal()

    const entry = forkJournalEntries().find((e) => e.recordId === 'b'.repeat(16))
    expect(entry?.status).toBe('in-progress')
    expect(entry?.metadata?.state).toBe('recovery-required')
    expect(typeof entry?.metadata?.recoveryReason).toBe('string')
    expect(report).toEqual({ resumed: 0, recovered: 1, recoveryRequired: 1 })
  })

  test('leaves a pre-child in-progress entry resumable (steps through target-verified, no child)', async () => {
    currentSession()
    journalFork({
      recordId: 'c'.repeat(16),
      steps: CHILD_CREATED_STEPS.slice(0, -1),
      state: 'target-verified',
    })

    const report = await harness.svc.fork.reconcileForkJournal()

    const entry = forkJournalEntries().find((e) => e.recordId === 'c'.repeat(16))
    expect(entry?.status).toBe('in-progress')
    expect(entry?.metadata?.state).toBe('target-verified')
    expect(report).toEqual({ resumed: 0, recovered: 0, recoveryRequired: 0 })
  })

  test('leaves failed entries failed (not resumable) and reports pre-existing recovery-required state', async () => {
    currentSession()
    journalFork({
      recordId: 'd'.repeat(16),
      steps: ['child-created'],
      status: 'failed',
      state: 'recovery-required',
      childSessionId: 'child-d',
    })

    const report = await harness.svc.fork.reconcileForkJournal()

    const entry = forkJournalEntries().find((e) => e.recordId === 'd'.repeat(16))
    expect(entry?.status).toBe('failed')
    expect(entry?.metadata?.state).toBe('recovery-required')
    expect(report).toEqual({ resumed: 0, recovered: 0, recoveryRequired: 1 })
  })

  test('leaves a child-created in-progress entry untouched when the child is live and pending (establish flow owns it)', async () => {
    currentSession()
    journalFork({
      recordId: 'e'.repeat(16),
      steps: CHILD_CREATED_STEPS,
      state: 'target-materialized',
      childSessionId: 'child-e',
    })
    const states = new Map<string, import('../isolated-conversation-fork-service').SessionForkState>([
      ['child-e', { pendingFork: { transactionId: 'e'.repeat(16) }, checkoutStrategy: 'isolated' }],
    ])

    const report = await harness.svc.fork.reconcileForkJournal({
      resolveSessionForkState: forkStateResolver(states),
    })

    const entry = forkJournalEntries().find((e) => e.recordId === 'e'.repeat(16))
    expect(entry?.status).toBe('in-progress')
    expect(entry?.metadata?.state).toBe('target-materialized')
    expect(report).toEqual({ resumed: 0, recovered: 0, recoveryRequired: 0 })
  })

  test('backfills the established marker on a committed entry whose child is durably established', async () => {
    currentSession()
    journalFork({
      recordId: 'f'.repeat(16),
      steps: ['child-created', 'owner-committed'],
      status: 'committed',
      state: 'binding-committed',
      childSessionId: 'child-f',
    })
    const states = new Map<string, import('../isolated-conversation-fork-service').SessionForkState>([
      ['child-f', { sdkSessionId: 'sdk-child-f', pendingFork: null, checkoutStrategy: 'isolated' }],
    ])

    const report = await harness.svc.fork.reconcileForkJournal({
      resolveSessionForkState: forkStateResolver(states),
    })

    const entry = forkJournalEntries().find((e) => e.recordId === 'f'.repeat(16))
    expect(entry?.status).toBe('committed')
    expect(entry?.metadata?.state).toBe('established')
    expect(entry?.metadata?.childSdkSessionId).toBe('sdk-child-f')
    expect(typeof entry?.metadata?.establishedAt).toBe('number')
    expect(report).toEqual({ resumed: 1, recovered: 0, recoveryRequired: 0 })
  })

  test('does not backfill when the committed child session is still pending', async () => {
    currentSession()
    journalFork({
      recordId: 'g'.repeat(16),
      steps: ['child-created', 'owner-committed'],
      status: 'committed',
      state: 'binding-committed',
      childSessionId: 'child-g',
    })
    const states = new Map<string, import('../isolated-conversation-fork-service').SessionForkState>([
      ['child-g', { pendingFork: { transactionId: 'g'.repeat(16) }, checkoutStrategy: 'isolated' }],
    ])

    const report = await harness.svc.fork.reconcileForkJournal({
      resolveSessionForkState: forkStateResolver(states),
    })

    const entry = forkJournalEntries().find((e) => e.recordId === 'g'.repeat(16))
    expect(entry?.status).toBe('committed')
    expect(entry?.metadata?.state).toBe('binding-committed')
    expect(report).toEqual({ resumed: 0, recovered: 0, recoveryRequired: 0 })
  })

  test('leaves an already-established committed entry untouched', async () => {
    currentSession()
    journalFork({
      recordId: 'h'.repeat(16),
      steps: ['child-created', 'owner-committed'],
      status: 'committed',
      state: 'established',
      childSessionId: 'child-h',
    })
    const states = new Map<string, import('../isolated-conversation-fork-service').SessionForkState>([
      ['child-h', { sdkSessionId: 'sdk-child-h', pendingFork: null, checkoutStrategy: 'isolated' }],
    ])

    const report = await harness.svc.fork.reconcileForkJournal({
      resolveSessionForkState: forkStateResolver(states),
    })

    const entry = forkJournalEntries().find((e) => e.recordId === 'h'.repeat(16))
    expect(entry?.status).toBe('committed')
    expect(entry?.metadata?.state).toBe('established')
    expect(entry?.metadata?.childSdkSessionId).toBeUndefined()
    expect(report).toEqual({ resumed: 0, recovered: 0, recoveryRequired: 0 })
  })
})

// ---------------------------------------------------------------------------
// Orphan ledger reconciliation — the journal-backed startup wiring
// ---------------------------------------------------------------------------

describe('IsolatedConversationForkService orphan reconciliation', () => {
  /** The startup `isEstablished` wiring: the fork journal records childSessionId
   *  + established state under the same transaction id as the orphan attempt. */
  function isEstablished(transactionId: string): boolean {
    return harness.svc.journal
      .entries()
      .some(
        (entry) =>
          entry.op === 'fork' &&
          entry.recordId === transactionId &&
          entry.status === 'committed' &&
          entry.metadata?.state === 'established',
      )
  }

  test('resolves a failed orphan attempt once the same transaction establishes', async () => {
    currentSession()
    const transactionId = 'i'.repeat(16)
    // The failed establishment attempt is on the ledger; the journal entry is
    // still committed-but-unestablished (the establish window crash state).
    const orphan = harness.svc.forkOrphans.recordAttempt({
      transactionId,
      idempotencyKey: 'idem-key-1',
      parentSdkSessionId: 'parent',
      parentSdkTurnId: 'turn-1',
      executionCwd: '/wt/child',
      result: 'failed',
    })
    journalFork({
      recordId: transactionId,
      steps: ['child-created', 'owner-committed'],
      status: 'committed',
      state: 'binding-committed',
      childSessionId: 'child-i',
    })

    // Before establishment: the orphan is retained.
    const before = harness.svc.forkOrphans.reconcile({ isEstablished })
    expect(before).toEqual({ resolved: 0, retained: 1, expiredUnresolved: 0, expiredAttemptIds: [] })

    // The transaction later establishes (first Send, journal marker durable).
    harness.svc.fork.markEstablished(transactionId, 'sdk-child-i')

    // Startup reconciliation resolves the orphan and never touches the entry.
    const report = harness.svc.forkOrphans.reconcile({ isEstablished })
    expect(report).toEqual({ resolved: 1, retained: 0, expiredUnresolved: 0, expiredAttemptIds: [] })
    expect(harness.svc.forkOrphans.entries()).toHaveLength(0)
    expect(harness.svc.forkOrphans.entries({ includeResolved: true })).toHaveLength(1)
    expect(harness.svc.forkOrphans.entries({ includeResolved: true })[0]).toMatchObject({
      attemptId: orphan.attemptId,
      transactionId,
      idempotencyKey: 'idem-key-1',
    })
  })

  test('keeps unrelated orphans when their transaction never established', async () => {
    currentSession()
    harness.svc.forkOrphans.recordAttempt({
      transactionId: 'unrelated-txn',
      idempotencyKey: 'idem-key-2',
      parentSdkSessionId: 'parent',
      parentSdkTurnId: 'turn-1',
      executionCwd: '/wt/other',
      result: 'unverified',
    })

    const report = harness.svc.forkOrphans.reconcile({ isEstablished })

    expect(report).toEqual({ resolved: 0, retained: 1, expiredUnresolved: 0, expiredAttemptIds: [] })
    expect(harness.svc.forkOrphans.entries()).toHaveLength(1)
    expect(harness.svc.forkOrphans.entries()[0]?.transactionId).toBe('unrelated-txn')
    // No session was created or bound by the reconcile.
    expect(harness.childCalls).toHaveLength(0)
  })
})
