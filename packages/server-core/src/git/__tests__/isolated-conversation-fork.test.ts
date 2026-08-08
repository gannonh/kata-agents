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
