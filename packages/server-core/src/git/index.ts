/**
 * Server-owned Git domain.
 *
 * The server that owns the workspace filesystem owns all Git behavior. This
 * module bundles the read-only {@link RepositoryService}, the
 * {@link ManagedWorktreeService} (+ registry), and the per-common-directory
 * {@link MutationLock} into a single {@link GitServices} object that both the
 * SessionManager (for checkout preparation) and the RPC handlers consume.
 */

import { join } from 'node:path'
import { CONFIG_DIR } from '@kata-sh/shared/config/paths'
import { RepositoryService } from './repository-service'
import { ManagedWorktreeService } from './managed-worktree-service'
import { WorktreeSettingsService } from './worktree-settings-service'
import { WorktreeRegistry } from './worktree-registry'
import { MutationLock } from './mutation-lock'
import { GitActionService } from './action-service'
import { GitHubCliService } from './github-cli-service'
import { WorktreeSnapshotService } from './worktree-snapshot-service'
import { WorktreeLifecycleService, type WorktreeLifecycleDeps } from './worktree-lifecycle-service'
import { PathLeaseManager } from './path-leases'
import { WorktreeJournal, journalPathFor } from './worktree-journal'
import { WorktreeHandoffService, type WorktreeHandoffHooks } from './worktree-handoff-service'
import { IsolatedConversationForkService, type ConversationForkHooks } from './isolated-conversation-fork-service'
import { ForkOrphanLedger, forkOrphanLedgerPathFor } from './fork-orphan-ledger'

export * from './command-runner'
export * from './repository-service'
export * from './managed-worktree-service'
export * from './worktree-settings-service'
export * from './worktree-registry'
export * from './worktree-include'
export * from './mutation-lock'
export * from './diff-language'
export * from './status-subscription'
export * from './action-service'
export * from './github-cli-service'
export * from './worktree-snapshot-service'
export * from './worktree-lifecycle-service'
export * from './path-leases'
export * from './worktree-journal'
export * from './worktree-handoff-service'
export * from './isolated-conversation-fork-service'
export * from './fork-orphan-ledger'

export interface GitServices {
  repository: RepositoryService
  worktrees: ManagedWorktreeService
  registry: WorktreeRegistry
  mutationLock: MutationLock
  /** Commit / pull / push mutations (spec: AC13, AC14, AC16). */
  actions: GitActionService
  /** GitHub `gh` adapter for capability + pull requests (spec: AC15). */
  github: GitHubCliService
  /** Current server-owned materialization root (registry remains fixed). */
  worktreeRoot: string
  worktreeSettings: WorktreeSettingsService
  /** Phase 2: snapshot-backed lifecycle (management, sweeps, recovery). */
  lifecycle: WorktreeLifecycleService
  /** Phase 2: snapshot capture/restore/verification. */
  snapshots: WorktreeSnapshotService
  /** Phase 2: canonical checkout-path leases. */
  pathLeases: PathLeaseManager
  /** Phase 2: durable lifecycle journal. */
  journal: WorktreeJournal
  /** Phase 3: conflict-safe checkout handoff. */
  handoff: WorktreeHandoffService
  /** Phase 4: isolated conversation forks (eligibility preview + seed capture). */
  fork: IsolatedConversationForkService
  /** Phase 4: durable orphan ledger for failed/unverified fork establishments. */
  forkOrphans: ForkOrphanLedger
}

export interface GitServicesConfig {
  /** Default root directory beneath which managed worktrees are created. */
  worktreeRoot: string
  /** Path to the managed-worktree registry JSON file. */
  registryPath: string
  /** Stable identity used in capability/settings snapshots. */
  serverId?: string
  /** Optional override for the fixed settings file, primarily for tests. */
  worktreeSettingsPath?: string
  /** Additional server-owned paths that a materialization root may not overlap. */
  protectedWorktreePaths?: string[]
  /** Inject an already-owned settings service when composing a host. */
  worktreeSettings?: WorktreeSettingsService
  /** Optional snapshot storage root (defaults to <config>/snapshots). */
  snapshotsRoot?: string
  /** Optional lifecycle host lock directory (defaults to <config>/locks). */
  lockDirectory?: string
  /** Optional lifecycle hooks (quiescence/activity), wired by the host. */
  lifecycleHooks?: Pick<
    WorktreeLifecycleDeps,
    'quiesceRuntimes' | 'isSessionActive' | 'isSessionFlagged' | 'isPathFenced' | 'applyOwnerSessionState' | 'touchSessionCheckout'
  >
  /** Optional handoff hooks (session/capability resolution), wired by the host. */
  handoffHooks?: WorktreeHandoffHooks
  /** Optional fork hooks (session/capability resolution), wired by the host. */
  forkHooks?: ConversationForkHooks
}

export function createGitServices(config: GitServicesConfig): GitServices {
  const registry = new WorktreeRegistry(config.registryPath)
  const worktreeSettings = config.worktreeSettings ?? new WorktreeSettingsService({
    serverId: config.serverId ?? 'local',
    defaultRoot: config.worktreeRoot,
    settingsPath: config.worktreeSettingsPath ?? join(config.worktreeRoot, 'settings.json'),
    registry,
    protectedPaths: config.protectedWorktreePaths,
  })
  // Root-update validation consults the settings service's own registry; it
  // must be the same authority ManagedWorktreeService uses, or overlap checks
  // would miss records in the active registry.
  if (config.worktreeSettings && config.worktreeSettings.registry?.getRegistryPath() !== config.registryPath) {
    throw new Error('Injected worktree settings must be bound to the active worktree registry.')
  }
  const repository = new RepositoryService()
  const mutationLock = new MutationLock(config.lockDirectory ? join(config.lockDirectory, 'git') : undefined)
  const worktrees = new ManagedWorktreeService(
    worktreeSettings,
    registry,
    repository,
    mutationLock,
  )
  const actions = new GitActionService(repository)
  const github = new GitHubCliService(repository)
  const lockBase = config.lockDirectory ?? join(CONFIG_DIR, 'locks')
  const snapshots = new WorktreeSnapshotService(config.snapshotsRoot ?? join(CONFIG_DIR, 'snapshots'))
  const pathLeases = new PathLeaseManager(join(lockBase, 'path-leases'))
  const journal = new WorktreeJournal(journalPathFor(config.registryPath))
  const forkOrphans = new ForkOrphanLedger(forkOrphanLedgerPathFor(config.registryPath))
  const lifecycle = new WorktreeLifecycleService({
    registry,
    snapshots,
    settings: worktreeSettings,
    worktrees,
    mutationLock,
    leases: pathLeases,
    journal,
    hostLockPath: join(lockBase, 'worktree-lifecycle.lock'),
    cleanupStatePath: join(lockBase, 'worktree-cleanup-state.json'),
    ...config.lifecycleHooks,
  })
  const handoff = new WorktreeHandoffService({
    registry,
    snapshots,
    worktrees,
    mutationLock,
    leases: pathLeases,
    journal,
    lifecycle,
    repository,
    settings: worktreeSettings,
    serverId: config.serverId ?? 'local',
    hooks: config.handoffHooks,
  })
  const fork = new IsolatedConversationForkService({
    registry,
    snapshots,
    worktrees,
    mutationLock,
    leases: pathLeases,
    journal,
    lifecycle,
    repository,
    settings: worktreeSettings,
    serverId: config.serverId ?? 'local',
    hooks: config.forkHooks,
  })
  lifecycle.setHooks({ isPathFenced: (path) => handoff.isPathFenced(path) || fork.isPathFenced(path) })
  return {
    repository,
    worktrees,
    registry,
    mutationLock,
    actions,
    github,
    worktreeSettings,
    lifecycle,
    snapshots,
    pathLeases,
    journal,
    handoff,
    fork,
    forkOrphans,
    get worktreeRoot() {
      return worktrees.getWorktreeRoot()
    },
  }
}

let defaultServices: GitServices | null = null

/** Lazily-constructed default services rooted under the Kata config directory. */
export function getDefaultGitServices(): GitServices {
  if (!defaultServices) {
    const worktreeRoot = join(CONFIG_DIR, 'worktrees')
    defaultServices = createGitServices({
      worktreeRoot,
      registryPath: join(worktreeRoot, 'registry.json'),
    })
  }
  return defaultServices
}
