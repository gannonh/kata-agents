import { describe, test, expect, afterEach, beforeEach } from 'bun:test'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createGitServices } from '../index'
import type { GitServices } from '../index'
import type {
  SessionCheckout,
  WorktreeHandoffDirection,
  WorktreeHandoffProviderCapability,
} from '@kata-sh/shared/protocol'
import type { ExecutionCwdRebindCapability } from '@kata-sh/shared/agent/backend'
import { createDeterministicHandoffAdapter } from '@kata-sh/shared/agent/backend'
import type { WorktreeHandoffBlockerCode } from '@kata-sh/shared/protocol'
import { initRepo, makeTmpDir, cleanup, git, writeFile } from './test-helpers'

const cleanups: string[] = []
function tmp(): string {
  const dir = makeTmpDir('kata-handoff-test-')
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
}

interface Harness {
  root: string
  repo: string
  svc: GitServices
  sessions: Map<string, SessionFixture>
  capabilities: Map<string, WorktreeHandoffProviderCapability | null>
  adapters: Map<string, ExecutionCwdRebindCapability | null>
  activeSessions: Set<string>
  quiesceResult: boolean
  bindings: Array<{ sessionId: string; checkout: SessionCheckout; executionCwd: string }>
  rebinds: string[]
}

let harness: Harness
let previousV2: string | undefined

function makeHarness(): Harness {
  const root = tmp()
  const repo = join(root, 'repo')
  const sessions = new Map<string, SessionFixture>()
  const capabilities = new Map<string, WorktreeHandoffProviderCapability | null>()
  const adapters = new Map<string, ExecutionCwdRebindCapability | null>()
  const activeSessions = new Set<string>()
  const bindings: Harness['bindings'] = []
  const rebinds: string[] = []
  const state = { quiesceResult: true }
  const svc = createGitServices({
    worktreeRoot: join(root, 'worktrees'),
    registryPath: join(root, 'worktrees', 'registry.json'),
    snapshotsRoot: join(root, 'snapshots'),
    lockDirectory: join(root, 'locks'),
    lifecycleHooks: {
      quiesceRuntimes: async (ids) => {
        if (!state.quiesceResult) return false
        for (const id of ids) activeSessions.delete(id)
        return true
      },
      isSessionActive: (sessionId) => activeSessions.has(sessionId),
      isSessionFlagged: () => false,
      applyOwnerSessionState: () => undefined,
      touchSessionCheckout: () => undefined,
    },
    handoffHooks: {
      resolveSession: (sessionId) => sessions.get(sessionId) ?? null,
      resolveCapability: (sessionId) => capabilities.get(sessionId) ?? null,
      resolveCapabilityAdapter: (sessionId) => adapters.get(sessionId) ?? null,
      isSessionActive: (sessionId) => activeSessions.has(sessionId),
      quiesceRuntimes: async (ids) => {
        if (!state.quiesceResult) return false
        for (const id of ids) activeSessions.delete(id)
        return true
      },
      commitSessionBinding: async (input) => {
        bindings.push(input)
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
    capabilities,
    adapters,
    activeSessions,
    get quiesceResult() {
      return state.quiesceResult
    },
    set quiesceResult(v: boolean) {
      state.quiesceResult = v
    },
    bindings,
    rebinds,
  }
}

beforeEach(async () => {
  previousV2 = process.env.KATA_FEATURE_WORKTREE_V2
  process.env.KATA_FEATURE_WORKTREE_V2 = '1'
  harness = makeHarness()
  await initRepo(harness.repo)
  harness.svc.lifecycle.markReady()
  harness.capabilities.set('session-1', { adapterId: 'pi-test', executionCwdRebindable: true })
  harness.adapters.set('session-1', createDeterministicHandoffAdapter({ adapterId: 'pi-test', rebindLog: harness.rebinds }))
})

afterEach(() => {
  if (previousV2 === undefined) delete process.env.KATA_FEATURE_WORKTREE_V2
  else process.env.KATA_FEATURE_WORKTREE_V2 = previousV2
})

function currentSession(overrides: Partial<SessionFixture> = {}): SessionFixture {
  const fixture: SessionFixture = {
    checkoutPath: harness.repo,
    workspaceId: 'ws1',
    checkout: {
      schemaVersion: 1,
      mode: 'current',
      repositoryRoot: harness.repo,
      checkoutPath: harness.repo,
      branchAtPreparation: null,
      baseRef: null,
      managedWorktreeId: null,
      expectedBranch: null,
    },
    transcriptCwd: join(harness.repo, '.kata', 'sessions', 'session-1'),
    ...overrides,
  }
  harness.sessions.set('session-1', fixture)
  return fixture
}

async function headOf(dir: string): Promise<string> {
  return (await git(dir, ['rev-parse', 'HEAD'])).trim()
}

async function preview(direction: WorktreeHandoffDirection, name = 'demo') {
  return harness.svc.handoff.preview({
    sessionId: 'session-1',
    direction,
    worktreeNameSuffix: name,
  })
}

describe('handoff preview — current-to-managed', () => {
  test('produces a fingerprint-bound preview for an eligible clean session', async () => {
    currentSession()
    const head = await headOf(harness.repo)

    const p = await preview('current-to-managed')

    expect(p.blocked).toBeUndefined()
    expect(p.direction).toBe('current-to-managed')
    expect(p.transactionId).toBeTruthy()
    expect(p.previewFingerprint).toHaveLength(64)
    expect(p.providerCapability).toEqual({ adapterId: 'pi-test', executionCwdRebindable: true })
    expect(p.source).toMatchObject({
      serverId: 'local',
      branch: 'main',
      headSha: head,
      state: 'clean',
      checkoutPath: realpathSync(harness.repo),
      leases: [],
    })
    expect(p.destination).toMatchObject({
      serverId: 'local',
      repositoryRoot: realpathSync(harness.repo),
      exists: false,
      leases: [],
    })
    expect(p.destination.branch).toMatch(/^kata-agent\//)
    expect(p.destination.checkoutPath.startsWith(join(realpathSync(harness.root), 'worktrees'))).toBe(true)
    expect(p.cleanup).toEqual({
      trackedFileCount: 0,
      stagedFileCount: 0,
      eligibleUntrackedFileCount: 0,
      includedIgnoredFileCount: 0,
    })
    expect(p.includeCopyConflicts).toEqual([])
    expect(p.excludedIgnoredPolicy).toEqual({ includeOnly: true, includeFileCount: 0 })
    expect(p.returnRef).toBeUndefined()
    expect(p.recoveryBehavior).toBe('destination-authoritative')
  })

  test('counts exact transferable state and names .worktreeinclude copy conflicts', async () => {
    currentSession()
    // tracked modified + staged + untracked + included ignored + plain ignored
    writeFile(harness.repo, '.gitignore', '*.log\nsecrets.env\n')
    writeFile(harness.repo, 'tracked.txt', 'hello\n')
    await git(harness.repo, ['add', '.'])
    await git(harness.repo, ['commit', '-m', 'add tracked'])
    writeFile(harness.repo, 'tracked.txt', 'modified\n')
    writeFile(harness.repo, 'staged.txt', 'staged content\n')
    await git(harness.repo, ['add', 'staged.txt'])
    writeFile(harness.repo, 'notes/untracked.txt', 'untracked\n')
    writeFile(harness.repo, '.worktreeinclude', 'secrets.env\n')
    writeFile(harness.repo, 'secrets.env', 'token=abc\n')
    writeFile(harness.repo, 'ignored.log', 'noise\n')

    const p = await preview('current-to-managed')

    expect(p.blocked).toBeUndefined()
    expect(p.source.state).toBe('dirty')
    expect(p.cleanup).toEqual({
      trackedFileCount: 1, // tracked.txt modified
      stagedFileCount: 1, // staged.txt
      eligibleUntrackedFileCount: 2, // notes/untracked.txt + .worktreeinclude
      includedIgnoredFileCount: 1, // secrets.env
    })
    expect(p.excludedIgnoredPolicy).toEqual({ includeOnly: true, includeFileCount: 1 })
    // ignored.log is outside .worktreeinclude: stays in source, never transfers.
  })

  test('fingerprint changes when source facts change', async () => {
    currentSession()
    const first = await preview('current-to-managed')
    writeFile(harness.repo, 'new-untracked.txt', 'x\n')
    const second = await preview('current-to-managed')
    expect(second.previewFingerprint).not.toBe(first.previewFingerprint)
  })

  test('blocks unsupported provider with a typed blocker and no mutation', async () => {
    currentSession()
    harness.capabilities.set('session-1', { adapterId: 'anthropic', executionCwdRebindable: false })
    const before = await git(harness.repo, ['status', '--porcelain'])

    const p = await preview('current-to-managed')

    expect(p.blocked).toMatchObject({ blocked: true, code: 'unsupported-provider' })
    const after = await git(harness.repo, ['status', '--porcelain'])
    expect(after).toBe(before)
    expect(harness.bindings).toHaveLength(0)
  })

  test('blocks when no capability resolver is wired (unknown session adapter)', async () => {
    currentSession()
    harness.capabilities.delete('session-1')

    const p = await preview('current-to-managed')

    expect(p.blocked?.code).toBe('unsupported-provider')
  })

  test('blocks a foreign source lease (another-path-user)', async () => {
    currentSession()
    harness.svc.pathLeases.lease('session-other', realpathSync(harness.repo))

    const p = await preview('current-to-managed')

    expect(p.blocked?.code).toBe('another-path-user')
  })

  test('blocks an active runtime (runtime-active)', async () => {
    currentSession()
    harness.activeSessions.add('session-1')

    const p = await preview('current-to-managed')

    expect(p.blocked?.code).toBe('runtime-active')
  })

  test('blocks while a handoff transaction is already in progress', async () => {
    currentSession()
    const first = await preview('current-to-managed')
    expect(first.blocked).toBeUndefined()

    const second = await preview('current-to-managed')
    expect(second.blocked?.code).toBe('handoff-in-progress')
  })

  test('blocks when the source is not a Git repository', async () => {
    currentSession({ checkoutPath: join(harness.root, 'not-a-repo'), checkout: null })

    const p = await preview('current-to-managed')

    expect(p.blocked?.code).toBe('unsupported-snapshot')
  })

  test('canonicalizes a nested legacy current working directory to the repository root', async () => {
    const nested = join(harness.repo, 'nested', 'folder')
    await import('node:fs').then(({ mkdirSync }) => mkdirSync(nested, { recursive: true }))
    currentSession({ checkoutPath: nested, checkout: null })

    const p = await preview('current-to-managed', 'nested-demo')

    expect(p.blocked).toBeUndefined()
    expect(p.source.checkoutPath).toBe(realpathSync(harness.repo))
  })

  test('blocks an invalid generated name before any Git inspection', async () => {
    currentSession()

    const p = await preview('current-to-managed', 'bad..name')

    expect(p.blocked?.code).toBe('invalid-name')
  })

  test('blocks when the branch is checked out by another worktree (branch-occupied-outside-journal)', async () => {
    const record = await managedSession('occupied')
    // A managed worktree already checks out kata-agent/occupied; a current
    // session asking for the same name must be blocked.
    currentSession()

    const p = await preview('current-to-managed', 'occupied')

    expect(p.blocked?.code).toBe('branch-occupied-outside-journal')
    expect(record.expectedBranch).toBe('kata-agent/occupied')
  })

  test('blocks while lifecycle cleanup is in progress (cleanup-in-progress)', async () => {
    currentSession()
    // Simulate an active retention sweep by claiming the sweep slot.
    ;(harness.svc.lifecycle as unknown as { sweepRunning: object }).sweepRunning = {}

    const p = await preview('current-to-managed')

    expect(p.blocked?.code).toBe('cleanup-in-progress')
  })

  test('blocks when feature flags are disabled (flags-disabled)', async () => {
    currentSession()
    const previousV2 = process.env.KATA_FEATURE_WORKTREE_V2
    process.env.KATA_FEATURE_WORKTREE_V2 = '0'
    try {
      const p = await preview('current-to-managed')
      expect(p.blocked?.code).toBe('flags-disabled')
    } finally {
      if (previousV2 === undefined) delete process.env.KATA_FEATURE_WORKTREE_V2
      else process.env.KATA_FEATURE_WORKTREE_V2 = previousV2
    }
  })
})

async function managedSession(name = 'demo') {
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

/** Move a session into the current checkout exactly like a committed m2c. */
async function handBackFixture(name = 'demo'): Promise<Awaited<ReturnType<typeof managedSession>>> {
  const record = await managedSession(name)
  writeFile(record.checkoutPath, 'handback.txt', 'roundtrip\n')
  const p = await preview('managed-to-current', name)
  const m2c = await harness.svc.handoff.confirm({
    sessionId: 'session-1',
    direction: 'managed-to-current',
    transactionId: p.transactionId,
    previewFingerprint: p.previewFingerprint,
  })
  if (m2c.outcome !== 'committed') throw new Error('m2c fixture handoff did not commit')
  // Mirror the durable binding a real SessionManager persists: session now
  // lives in the current checkout and leases it (replacing the old lease).
  currentSession({
    checkoutPath: harness.repo,
    checkout: {
      schemaVersion: 1,
      mode: 'current',
      repositoryRoot: harness.repo,
      checkoutPath: harness.repo,
      branchAtPreparation: null,
      baseRef: null,
      managedWorktreeId: null,
      expectedBranch: null,
    },
  })
  harness.svc.pathLeases.lease('session-1', harness.repo)
  return record
}

describe('handoff preview — managed-to-current', () => {

  test('previews an eligible managed session with return-ref metadata', async () => {
    const record = await managedSession()
    const head = await headOf(harness.repo)

    const p = await preview('managed-to-current')

    expect(p.blocked).toBeUndefined()
    expect(p.source).toMatchObject({
      branch: record.expectedBranch,
      checkoutPath: record.checkoutPath,
      leases: ['session-1'],
    })
    expect(p.source.headSha).toBe(head) // created at main tip
    expect(p.destination).toMatchObject({
      serverId: 'local',
      repositoryRoot: harness.repo,
      branch: 'main',
      checkoutPath: harness.repo,
      exists: true,
      leases: [],
    })
    expect(p.returnRef).toEqual({ branch: 'main', headSha: head })
    expect(p.recoveryBehavior).toBe('source-authoritative')
  })

  test('confirms managed state into the current checkout and releases the source worktree', async () => {
    const record = await managedSession()
    writeFile(harness.repo, '.gitignore', 'secret.env\n')
    await git(harness.repo, ['add', '.gitignore'])
    await git(harness.repo, ['commit', '-m', 'ignore secret'])
    writeFile(record.checkoutPath, 'managed-change.txt', 'managed state\n')
    writeFile(record.checkoutPath, 'secret.env', 'included\n')
    writeFile(record.checkoutPath, '.worktreeinclude', 'secret.env\n')

    const p = await preview('managed-to-current')
    expect(p.blocked).toBeUndefined()
    const result = await harness.svc.handoff.confirm({
      sessionId: 'session-1',
      direction: 'managed-to-current',
      transactionId: p.transactionId,
      previewFingerprint: p.previewFingerprint,
    })

    expect(result.outcome).toBe('committed')
    if (result.outcome !== 'committed') return
    expect(existsSync(record.checkoutPath)).toBe(false)
    expect(await headOf(harness.repo)).toBe(record.expectedBranch ? await git(harness.repo, ['rev-parse', record.expectedBranch]) .then((value) => value.trim()) : '')
    expect(readFileSync(join(harness.repo, 'managed-change.txt'), 'utf8')).toBe('managed state\n')
    expect(readFileSync(join(harness.repo, 'secret.env'), 'utf8')).toBe('included\n')
    expect(harness.bindings.at(-1)).toMatchObject({
      sessionId: 'session-1',
      executionCwd: harness.repo,
      checkout: { mode: 'current', checkoutPath: harness.repo, managedWorktreeId: null },
    })
    expect(harness.rebinds.at(-1)).toBe(harness.repo)
  })

  test('retains a snapshot-backed recovery state when runtime rebinding fails after source release', async () => {
    const record = await managedSession('runtime-failure')
    harness.adapters.set('session-1', createDeterministicHandoffAdapter({ adapterId: 'pi-test', failRebind: true }))

    const p = await preview('managed-to-current', 'runtime-failure')
    const result = await harness.svc.handoff.confirm({
      sessionId: 'session-1',
      direction: 'managed-to-current',
      transactionId: p.transactionId,
      previewFingerprint: p.previewFingerprint,
    })

    expect(result.outcome).toBe('recovery-required')
    if (result.outcome !== 'recovery-required') return
    expect(result.retainedSnapshotId).toBeTruthy()
    expect(existsSync(record.checkoutPath)).toBe(false)
    expect(await harness.svc.handoff.status('session-1')).toMatchObject({
      active: true,
      state: 'recovery-required',
      retainedSnapshotId: result.retainedSnapshotId,
    })
  })

  test('blocks a shared managed worktree (shared-owners)', async () => {
    await managedSession()
    const record = harness.svc.registry.list().find((r) => r.expectedBranch === 'kata-agent/demo')!
    harness.svc.worktrees.addOwner(record.managedWorktreeId, 'session-2')

    const p = await preview('managed-to-current')

    expect(p.blocked?.code).toBe('shared-owners')
  })

  test('blocks when the current checkout is dirty (destination-dirty)', async () => {
    await managedSession()
    writeFile(harness.repo, 'stray.txt', 'dirty current\n')

    const p = await preview('managed-to-current')

    expect(p.blocked?.code).toBe('destination-dirty')
  })

  test('blocks a foreign lease on the current checkout (another-path-user)', async () => {
    await managedSession()
    harness.svc.pathLeases.lease('session-other', harness.repo)

    const p = await preview('managed-to-current')

    expect(p.blocked?.code).toBe('another-path-user')
  })

  test('blocks when the current checkout is detached (destination-detached)', async () => {
    await managedSession()
    await git(harness.repo, ['switch', '--detach', 'HEAD'])

    const p = await preview('managed-to-current')

    expect(p.blocked?.code).toBe('destination-detached')
  })

  test('blocks when a Git operation is in progress on the source (git-operation-in-progress)', async () => {
    const record = await managedSession('git-op')
    const wtGitDir = (await git(record.checkoutPath, ['rev-parse', '--path-format=absolute', '--git-dir'])).trim()
    const { writeFileSync } = await import('node:fs')
    // A merge marker makes the repository report an in-progress operation.
    writeFileSync(join(wtGitDir, 'MERGE_HEAD'), (await git(harness.repo, ['rev-parse', 'HEAD'])).trim())

    const p = await preview('managed-to-current', 'git-op')

    expect(p.blocked?.code).toBe('git-operation-in-progress')
  })

  test('blocks when the managed worktree is missing', async () => {
    const record = await managedSession()
    harness.svc.pathLeases.release('session-1', record.checkoutPath)
    const { rmSync } = await import('node:fs')
    rmSync(record.checkoutPath, { recursive: true, force: true })

    const p = await preview('managed-to-current')

    // The missing checkout is detected at the source-context inspection first.
    expect(p.blocked).toBeDefined()
    expect((p.blocked?.code as WorktreeHandoffBlockerCode) ?? '').toBeTruthy()
  })
})

describe('handoff preview — hand-back', () => {
  test('blocks when no released managed worktree exists to hand back to', async () => {
    currentSession()

    const p = await preview('hand-back')

    expect(p.blocked?.code).toBe('destination-missing')
  })

  test('blocks hand-back when the current checkout is not on the handed branch', async () => {
    const record = await managedSession('wrong-branch')
    writeFile(record.checkoutPath, 'handback.txt', 'roundtrip\n')
    const p = await preview('managed-to-current', 'wrong-branch')
    const m2c = await harness.svc.handoff.confirm({
      sessionId: 'session-1',
      direction: 'managed-to-current',
      transactionId: p.transactionId,
      previewFingerprint: p.previewFingerprint,
    })
    if (m2c.outcome !== 'committed') throw new Error('m2c fixture handoff did not commit')
    // Session drifts to main (e.g. an external checkout switch).
    await git(harness.repo, ['switch', 'main'])
    currentSession({
      checkoutPath: harness.repo,
      checkout: {
        schemaVersion: 1,
        mode: 'current',
        repositoryRoot: harness.repo,
        checkoutPath: harness.repo,
        branchAtPreparation: null,
        baseRef: null,
        managedWorktreeId: null,
        expectedBranch: null,
      },
    })
    harness.svc.pathLeases.lease('session-1', harness.repo)

    const hb = await preview('hand-back', 'wrong-branch')

    expect(hb.blocked?.code).toBe('unsupported-snapshot')
  })
})

describe('handoff confirm — hand-back', () => {
  test('round-trips managed → current → managed with the branch returned to the recorded ref', async () => {
    const record = await handBackFixture('roundtrip')
    const mainHead = (await git(harness.repo, ['rev-parse', 'main'])).trim()
    writeFile(harness.repo, 'extra.txt', 'from current\n')

    const p = await preview('hand-back', 'roundtrip')
    expect(p.blocked).toBeUndefined()
    expect(p.returnRef).toEqual({ branch: 'main', headSha: mainHead })
    expect(p.recoveryBehavior).toBe('source-authoritative')

    const result = await harness.svc.handoff.confirm({
      sessionId: 'session-1',
      direction: 'hand-back',
      transactionId: p.transactionId,
      previewFingerprint: p.previewFingerprint,
    })

    expect(result.outcome).toBe('committed')
    if (result.outcome !== 'committed') return
    // Current returned to the recorded ref; the managed target is re-materialized
    // on the handed branch with the exact handed state.
    expect((await git(harness.repo, ['branch', '--show-current'])).trim()).toBe('main')
    expect((await git(harness.repo, ['rev-parse', 'HEAD'])).trim()).toBe(mainHead)
    expect(existsSync(record.checkoutPath)).toBe(true)
    expect((await git(record.checkoutPath, ['branch', '--show-current'])).trim()).toBe(record.expectedBranch)
    expect(readFileSync(join(record.checkoutPath, 'handback.txt'), 'utf8')).toBe('roundtrip\n')
    expect(readFileSync(join(record.checkoutPath, 'extra.txt'), 'utf8')).toBe('from current\n')
    expect(harness.bindings.at(-1)).toMatchObject({
      sessionId: 'session-1',
      executionCwd: record.checkoutPath,
      checkout: { mode: 'managed-worktree', managedWorktreeId: record.managedWorktreeId },
    })
    expect(harness.rebinds.at(-1)).toBe(record.checkoutPath)
    expect(harness.svc.registry.get(record.managedWorktreeId)?.state).toBe('ready')
    expect(await harness.svc.handoff.status('session-1')).toEqual({ active: false })
    expect(
      harness.svc.journal.entries().filter((entry) => entry.op === 'handoff' && entry.status === 'committed').length,
    ).toBe(2)
  })

  test('leaves current on the recorded ref with a retained snapshot when hand-back rebinding fails', async () => {
    const record = await handBackFixture('recover-handback')
    harness.adapters.set('session-1', createDeterministicHandoffAdapter({ adapterId: 'pi-test', failRebind: true }))

    const p = await preview('hand-back', 'recover-handback')
    const result = await harness.svc.handoff.confirm({
      sessionId: 'session-1',
      direction: 'hand-back',
      transactionId: p.transactionId,
      previewFingerprint: p.previewFingerprint,
    })

    expect(result.outcome).toBe('recovery-required')
    if (result.outcome !== 'recovery-required') return
    expect(result.retainedSnapshotId).toBeTruthy()
    expect((await git(harness.repo, ['branch', '--show-current'])).trim()).toBe('main')
    expect(harness.svc.registry.get(record.managedWorktreeId)?.state).toBe('snapshotted')
    expect(await harness.svc.handoff.status('session-1')).toMatchObject({
      active: true,
      state: 'recovery-required',
      retainedSnapshotId: result.retainedSnapshotId,
    })
  })
})

describe('handoff confirm — current-to-managed', () => {
  test('creates the managed target, transfers state, preserves current branch, and commits binding', async () => {
    const session = currentSession()
    writeFile(harness.repo, 'tracked.txt', 'base\n')
    await git(harness.repo, ['add', 'tracked.txt'])
    await git(harness.repo, ['commit', '-m', 'add tracked'])
    writeFile(harness.repo, 'tracked.txt', 'changed\n')
    writeFile(harness.repo, 'new.txt', 'new file\n')

    const p = await preview('current-to-managed', 'handoff-demo')
    const result = await harness.svc.handoff.confirm({
      sessionId: 'session-1',
      direction: 'current-to-managed',
      transactionId: p.transactionId,
      previewFingerprint: p.previewFingerprint,
    })

    expect(result.outcome).toBe('committed')
    if (result.outcome !== 'committed') return
    expect(result.summary.transcriptCwd).toBe(session.transcriptCwd)
    expect(result.summary.executionCwd).not.toBe(session.transcriptCwd)
    expect(result.summary.checkout.mode).toBe('managed-worktree')
    expect(result.summary.checkout.schemaVersion).toBe(2)
    expect(result.summary.checkout.expectedBranch).toBe('kata-agent/handoff-demo')
    expect(existsSync(result.summary.executionCwd)).toBe(true)
    expect((await git(result.summary.executionCwd, ['branch', '--show-current'])).trim()).toBe('kata-agent/handoff-demo')
    expect(readFileSync(join(result.summary.executionCwd, 'tracked.txt'), 'utf8')).toBe('changed\n')
    expect(existsSync(join(result.summary.executionCwd, 'new.txt'))).toBe(true)
    expect((await git(harness.repo, ['status', '--porcelain'])).trim()).toBe('')
    expect((await git(harness.repo, ['branch', '--show-current'])).trim()).toBe('main')
    expect((await git(harness.repo, ['rev-parse', 'HEAD'])).trim()).toBe(await headOf(harness.repo))
    expect(harness.bindings).toHaveLength(1)
    expect(harness.bindings[0]?.sessionId).toBe('session-1')
    expect(harness.rebinds).toEqual([result.summary.executionCwd])
    expect(harness.bindings[0]?.executionCwd).toBe(result.summary.executionCwd)
    expect(await harness.svc.handoff.status('session-1')).toEqual({ active: false })
    expect(harness.svc.journal.entries().some((entry) => entry.op === 'handoff' && entry.status === 'committed')).toBe(true)
  })

  test('preserves included ignored files in current while copying them to managed', async () => {
    currentSession()
    writeFile(harness.repo, '.gitignore', 'secrets.env\n')
    await git(harness.repo, ['add', '.gitignore'])
    await git(harness.repo, ['commit', '-m', 'ignore secrets'])
    writeFile(harness.repo, '.worktreeinclude', 'secrets.env\n')
    writeFile(harness.repo, 'secrets.env', 'token=one\n')
    writeFile(harness.repo, 'untracked.txt', 'move me\n')

    const p = await preview('current-to-managed', 'include-demo')
    const result = await harness.svc.handoff.confirm({
      sessionId: 'session-1',
      direction: 'current-to-managed',
      transactionId: p.transactionId,
      previewFingerprint: p.previewFingerprint,
    })

    expect(result.outcome).toBe('committed')
    if (result.outcome !== 'committed') return
    expect(readFileSync(join(harness.repo, 'secrets.env'), 'utf8')).toBe('token=one\n')
    expect(readFileSync(join(result.summary.executionCwd, 'secrets.env'), 'utf8')).toBe('token=one\n')
    expect(existsSync(join(harness.repo, 'untracked.txt'))).toBe(false)
    expect(existsSync(join(result.summary.executionCwd, 'untracked.txt'))).toBe(true)
  })

  test('preserves an ignored file matched only by a modified tracked .worktreeinclude pattern', async () => {
    currentSession()
    writeFile(harness.repo, '.gitignore', 'secrets.env\n')
    writeFile(harness.repo, '.worktreeinclude', 'other.env\n')
    await git(harness.repo, ['add', '.gitignore', '.worktreeinclude'])
    await git(harness.repo, ['commit', '-m', 'track include policy'])
    writeFile(harness.repo, '.worktreeinclude', 'secrets.env\n')
    writeFile(harness.repo, 'secrets.env', 'keep this\n')

    const p = await preview('current-to-managed', 'tracked-include')
    const result = await harness.svc.handoff.confirm({
      sessionId: 'session-1',
      direction: 'current-to-managed',
      transactionId: p.transactionId,
      previewFingerprint: p.previewFingerprint,
    })

    expect(result.outcome).toBe('committed')
    if (result.outcome !== 'committed') return
    expect(readFileSync(join(harness.repo, 'secrets.env'), 'utf8')).toBe('keep this\n')
    expect(readFileSync(join(result.summary.executionCwd, 'secrets.env'), 'utf8')).toBe('keep this\n')
  })

  test('transfers binary, rename, deletion, and executable state byte-for-byte through c2m', async () => {
    currentSession()
    // Binary tracked file + executable + a tracked file to rename/delete.
    const binary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x42])
    const { writeFileSync, chmodSync } = await import('node:fs')
    writeFileSync(join(harness.repo, 'blob.bin'), binary)
    writeFileSync(join(harness.repo, 'run.sh'), '#!/bin/sh\necho hi\n')
    chmodSync(join(harness.repo, 'run.sh'), 0o755)
    writeFileSync(join(harness.repo, 'old-name.txt'), 'rename me\n')
    writeFileSync(join(harness.repo, 'delete-me.txt'), 'bye\n')
    await git(harness.repo, ['add', '-A'])
    await git(harness.repo, ['commit', '-m', 'fixture state'])
    // Staged rename + staged deletion + unstaged binary modification.
    await git(harness.repo, ['mv', 'old-name.txt', 'new-name.txt'])
    await git(harness.repo, ['rm', 'delete-me.txt'])
    writeFileSync(join(harness.repo, 'blob.bin'), Buffer.concat([binary, Buffer.from([0x99])]))

    const p = await preview('current-to-managed', 'binary-state')
    expect(p.blocked).toBeUndefined()
    const result = await harness.svc.handoff.confirm({
      sessionId: 'session-1',
      direction: 'current-to-managed',
      transactionId: p.transactionId,
      previewFingerprint: p.previewFingerprint,
    })

    expect(result.outcome).toBe('committed')
    if (result.outcome !== 'committed') return
    const target = result.summary.executionCwd
    expect(readFileSync(join(target, 'blob.bin'))).toEqual(Buffer.concat([binary, Buffer.from([0x99])]))
    expect(readFileSync(join(target, 'new-name.txt'), 'utf8')).toBe('rename me\n')
    expect(existsSync(join(target, 'old-name.txt'))).toBe(false)
    expect(existsSync(join(target, 'delete-me.txt'))).toBe(false)
    expect((await git(target, ['diff', '--cached', '--name-status'])).trim()).toContain('R100')
    expect((await git(target, ['diff', '--cached', '--name-status'])).trim()).toContain('D\tdelete-me.txt')
    expect((await git(target, ['ls-files', '-s', 'run.sh'])).trim()).toMatch(/100755/)
  })

  test('rejects a stale preview without creating a target or mutating source', async () => {
    currentSession()
    const p = await preview('current-to-managed', 'stale-demo')
    writeFile(harness.repo, 'raced.txt', 'external change\n')
    const before = await git(harness.repo, ['status', '--porcelain'])

    const result = await harness.svc.handoff.confirm({
      sessionId: 'session-1',
      direction: 'current-to-managed',
      transactionId: p.transactionId,
      previewFingerprint: p.previewFingerprint,
    })

    expect(result.outcome).toBe('blocked')
    if (result.outcome === 'blocked') expect(result.code).toBe('identity-drift')
    expect(await git(harness.repo, ['status', '--porcelain'])).toBe(before)
    expect(existsSync(p.destination.checkoutPath)).toBe(false)
  })

  test('returns a typed blocker when the runtime cannot quiesce', async () => {
    currentSession()
    harness.quiesceResult = false
    const p = await preview('current-to-managed', 'quiesce-demo')

    const result = await harness.svc.handoff.confirm({
      sessionId: 'session-1',
      direction: 'current-to-managed',
      transactionId: p.transactionId,
      previewFingerprint: p.previewFingerprint,
    })

    expect(result.outcome).toBe('blocked')
    if (result.outcome === 'blocked') expect(result.code).toBe('runtime-active')
  })
})

describe('handoff recover — snapshot-backed rollback', () => {
  async function failingAdapter(): Promise<ExecutionCwdRebindCapability> {
    return createDeterministicHandoffAdapter({ adapterId: 'pi-test', failRebind: true })
  }

  test('rolls back an interrupted c2m: removes the target and restores the cleaned source', async () => {
    currentSession()
    writeFile(harness.repo, 'tracked.txt', 'base\n')
    await git(harness.repo, ['add', 'tracked.txt'])
    await git(harness.repo, ['commit', '-m', 'add tracked'])
    writeFile(harness.repo, 'tracked.txt', 'changed\n')
    writeFile(harness.repo, 'new.txt', 'new file\n')
    harness.svc.handoff.setHooks({
      commitSessionBinding: async () => {
        throw new Error('session persist failed')
      },
    })

    const p = await preview('current-to-managed', 'rollback-c2m')
    const result = await harness.svc.handoff.confirm({
      sessionId: 'session-1',
      direction: 'current-to-managed',
      transactionId: p.transactionId,
      previewFingerprint: p.previewFingerprint,
    })
    expect(result.outcome).toBe('recovery-required')
    if (result.outcome !== 'recovery-required') return
    expect((await git(harness.repo, ['status', '--porcelain'])).trim()).toBe('')
    const targetRecord = harness.svc.registry.list().find((r) => r.expectedBranch === 'kata-agent/rollback-c2m')
    expect(targetRecord).toBeDefined()
    expect(existsSync(targetRecord!.checkoutPath)).toBe(true)

    const rec = await harness.svc.handoff.recover({ sessionId: 'session-1', transactionId: p.transactionId })

    expect(rec).toMatchObject({ outcome: 'blocked', code: 'handoff-rolled-back' })
    expect(existsSync(targetRecord!.checkoutPath)).toBe(false)
    expect(harness.svc.registry.get(targetRecord!.managedWorktreeId)).toBeUndefined()
    expect(await git(harness.repo, ['branch', '--list'])).not.toContain('kata-agent/rollback-c2m')
    // The cleaned source is restored byte-for-byte from the retained snapshot.
    expect(readFileSync(join(harness.repo, 'tracked.txt'), 'utf8')).toBe('changed\n')
    expect(readFileSync(join(harness.repo, 'new.txt'), 'utf8')).toBe('new file\n')
    expect(await harness.svc.handoff.status('session-1')).toEqual({ active: false })
  })

  test('re-materializes the managed target when an interrupted m2c is recovered', async () => {
    const record = await managedSession('recover-m2c')
    writeFile(record.checkoutPath, 'managed.txt', 'managed state\n')
    harness.adapters.set('session-1', await failingAdapter())

    const p = await preview('managed-to-current', 'recover-m2c')
    const result = await harness.svc.handoff.confirm({
      sessionId: 'session-1',
      direction: 'managed-to-current',
      transactionId: p.transactionId,
      previewFingerprint: p.previewFingerprint,
    })
    expect(result.outcome).toBe('recovery-required')
    if (result.outcome !== 'recovery-required') return
    expect((await git(harness.repo, ['branch', '--show-current'])).trim()).toBe('kata-agent/recover-m2c')
    expect(existsSync(record.checkoutPath)).toBe(false)

    const rec = await harness.svc.handoff.recover({ sessionId: 'session-1', transactionId: p.transactionId })

    expect(rec.outcome).toBe('blocked')
    expect((await git(harness.repo, ['branch', '--show-current'])).trim()).toBe('main')
    // The projected state is gone from current: no duplicate copy remains and
    // a future handoff is not blocked by residue.
    expect((await git(harness.repo, ['status', '--porcelain'])).trim()).toBe('')
    expect(existsSync(record.checkoutPath)).toBe(true)
    expect(readFileSync(join(record.checkoutPath, 'managed.txt'), 'utf8')).toBe('managed state\n')
    expect(harness.svc.registry.get(record.managedWorktreeId)?.state).toBe('ready')
    expect(await harness.svc.handoff.status('session-1')).toEqual({ active: false })
  })

  test('returns current to the handed branch when an interrupted hand-back is recovered', async () => {
    const record = await handBackFixture('recover-handback')
    harness.adapters.set('session-1', await failingAdapter())

    const p = await preview('hand-back', 'recover-handback')
    const result = await harness.svc.handoff.confirm({
      sessionId: 'session-1',
      direction: 'hand-back',
      transactionId: p.transactionId,
      previewFingerprint: p.previewFingerprint,
    })
    expect(result.outcome).toBe('recovery-required')
    if (result.outcome !== 'recovery-required') return
    expect((await git(harness.repo, ['branch', '--show-current'])).trim()).toBe('main')
    expect(existsSync(record.checkoutPath)).toBe(true)

    const rec = await harness.svc.handoff.recover({ sessionId: 'session-1', transactionId: p.transactionId })

    expect(rec.outcome).toBe('blocked')
    expect((await git(harness.repo, ['branch', '--show-current'])).trim()).toBe('kata-agent/recover-handback')
    expect(readFileSync(join(harness.repo, 'handback.txt'), 'utf8')).toBe('roundtrip\n')
    expect(existsSync(record.checkoutPath)).toBe(false)
    expect(harness.svc.registry.get(record.managedWorktreeId)?.state).toBe('snapshotted')
    expect(await harness.svc.handoff.status('session-1')).toEqual({ active: false })
  })

  test('a rolled-back failed journal never re-fences the session after restart', async () => {
    currentSession()
    writeFile(harness.repo, 'tracked.txt', 'base\n')
    await git(harness.repo, ['add', 'tracked.txt'])
    await git(harness.repo, ['commit', '-m', 'add tracked'])
    writeFile(harness.repo, 'tracked.txt', 'changed\n')
    harness.svc.handoff.setHooks({
      commitSessionBinding: async () => {
        throw new Error('session persist failed')
      },
    })

    const p = await preview('current-to-managed', 'restart-rollback')
    const result = await harness.svc.handoff.confirm({
      sessionId: 'session-1',
      direction: 'current-to-managed',
      transactionId: p.transactionId,
      previewFingerprint: p.previewFingerprint,
    })
    expect(result.outcome).toBe('recovery-required')
    if (result.outcome !== 'recovery-required') return
    expect(harness.svc.journal.entries().find((entry) => entry.op === 'handoff')?.status).toBe('failed')

    const rec = await harness.svc.handoff.recover({ sessionId: 'session-1', transactionId: p.transactionId })
    expect(rec).toMatchObject({ outcome: 'blocked', code: 'handoff-rolled-back' })
    expect(harness.svc.journal.entries().find((entry) => entry.op === 'handoff')?.status).toBe('recovered')

    // Restart from the same durable storage: the rolled-back entry must not
    // reconstruct a transaction and re-fence the session.
    const restarted = createGitServices({
      worktreeRoot: join(harness.root, 'worktrees'),
      registryPath: join(harness.root, 'worktrees', 'registry.json'),
      snapshotsRoot: join(harness.root, 'snapshots'),
      lockDirectory: join(harness.root, 'locks'),
    })
    expect(await restarted.handoff.status('session-1')).toEqual({ active: false })
    expect(restarted.handoff.isSessionFenced('session-1')).toBe(false)
    expect(restarted.handoff.isPathFenced(harness.repo)).toBe(false)
  })
})

describe('handoff status', () => {
  test('reports no active transaction before a preview', async () => {
    currentSession()
    expect(await harness.svc.handoff.status('session-1')).toEqual({ active: false })
  })

  test('reports an active transaction after a preview', async () => {
    currentSession()
    const p = await preview('current-to-managed')

    const status = await harness.svc.handoff.status('session-1')
    expect(status.active).toBe(true)
    if (status.active) {
      expect(status.transactionId).toBe(p.transactionId)
      expect(status.direction).toBe('current-to-managed')
    }
  })

  test('restores pending transaction status from the durable journal after restart', async () => {
    currentSession()
    const p = await preview('current-to-managed', 'restart-demo')
    const restarted = createGitServices({
      worktreeRoot: join(harness.root, 'worktrees'),
      registryPath: join(harness.root, 'worktrees', 'registry.json'),
      snapshotsRoot: join(harness.root, 'snapshots'),
      lockDirectory: join(harness.root, 'locks'),
    })

    const status = await restarted.handoff.status('session-1')
    expect(status).toMatchObject({ active: true, transactionId: p.transactionId, direction: 'current-to-managed' })
  })

  test('discards malformed journal metadata instead of restoring an arbitrary path fence', async () => {
    const journalPath = harness.svc.journal.getJournalPath()
    writeFileSync(journalPath, JSON.stringify({
      journalId: 'bad-journal',
      op: 'handoff',
      recordId: 'bad-record',
      sessionIds: ['session-1'],
      policyVersion: 1,
      startedAt: Date.now(),
      steps: [],
      status: 'in-progress',
      metadata: {
        transactionId: 'bad-record',
        sessionId: 'session-1',
        direction: 'current-to-managed',
        state: 'recovery-required',
        fingerprint: 'fp',
        sourcePath: '/outside/source',
        destinationPath: '/outside/destination',
        repositoryRoot: '/outside/repo',
        gitCommonDir: '/outside/repo/.git',
        expectedBranch: 'kata-agent/bad',
        providerCapability: { adapterId: 'pi', executionCwdRebindable: true },
        transcriptCwd: '/outside/transcript',
        sourceLeases: [],
        destinationLeases: [],
      },
    }) + '\n')
    const restarted = createGitServices({
      worktreeRoot: join(harness.root, 'worktrees'),
      registryPath: join(harness.root, 'worktrees', 'registry.json'),
      snapshotsRoot: join(harness.root, 'snapshots'),
      lockDirectory: join(harness.root, 'locks'),
    })

    expect(await restarted.handoff.status('session-1')).toEqual({ active: false })
  })
})
