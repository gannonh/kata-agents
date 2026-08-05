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
  const mutationLock = new MutationLock()
  const worktrees = new ManagedWorktreeService(
    worktreeSettings,
    registry,
    repository,
    mutationLock,
  )
  const actions = new GitActionService(repository)
  const github = new GitHubCliService(repository)
  return {
    repository,
    worktrees,
    registry,
    mutationLock,
    actions,
    github,
    worktreeSettings,
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
