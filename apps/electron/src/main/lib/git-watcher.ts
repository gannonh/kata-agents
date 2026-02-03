/**
 * Git File Watcher
 *
 * Watches selective .git paths for changes to detect branch switches,
 * commits, and other git operations. Uses chokidar for cross-platform
 * reliability (handles macOS, Linux, Windows differences).
 *
 * Watched paths:
 * - .git/HEAD - Branch reference (changes on checkout, branch switch)
 * - .git/index - Staging area (changes on add, reset, commit)
 * - .git/refs/heads/ - Local branch tips (changes on commit, fetch)
 * - .git/refs/remotes/ - Remote refs (changes on fetch, pull)
 */

import { watch, type FSWatcher } from 'chokidar'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { debug } from '@craft-agent/shared/utils'

// Debounce delay in milliseconds (100ms for rapid git operations like rebase)
const DEBOUNCE_MS = 100

interface GitWatcherOptions {
  debounceMs?: number
  onError?: (error: Error) => void
}

/**
 * Watches .git directory for changes and triggers callback.
 * Per-workspace singleton - create one watcher per workspace directory.
 */
export class GitWatcher {
  private watcher: FSWatcher | null = null
  private debounceTimer: NodeJS.Timeout | null = null
  private readonly debounceMs: number
  private readonly onError?: (error: Error) => void

  constructor(
    private readonly workspaceDir: string,
    private readonly onGitChange: () => void,
    options: GitWatcherOptions = {}
  ) {
    this.debounceMs = options.debounceMs ?? DEBOUNCE_MS
    this.onError = options.onError
  }

  /**
   * Start watching .git paths.
   * @returns true if watching started, false if not a git repo
   */
  start(): boolean {
    const gitDir = join(this.workspaceDir, '.git')

    // Verify .git exists
    if (!existsSync(gitDir)) {
      debug('[GitWatcher] Not a git repository:', this.workspaceDir)
      return false
    }

    // Watch selective paths only - not entire .git directory
    const watchPaths = [
      join(gitDir, 'HEAD'),
      join(gitDir, 'index'),
      join(gitDir, 'refs', 'heads'),
      join(gitDir, 'refs', 'remotes'),
    ]

    this.watcher = watch(watchPaths, {
      persistent: true,
      ignoreInitial: true,      // Don't fire on startup
      depth: 2,                 // Limit recursion in refs/
      awaitWriteFinish: {       // Wait for atomic writes
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    })

    this.watcher
      .on('all', (_event, path) => {
        debug('[GitWatcher] File change:', _event, path)
        this.handleChange()
      })
      .on('error', (error) => {
        debug('[GitWatcher] Error:', error)
        this.onError?.(error)
      })
      .on('ready', () => {
        debug('[GitWatcher] Ready:', this.workspaceDir)
      })

    return true
  }

  private handleChange(): void {
    // Debounce rapid changes (e.g., during rebase which touches multiple files)
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this.onGitChange()
    }, this.debounceMs)
  }

  /**
   * Stop watching and clean up resources.
   */
  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    this.watcher?.close()
    this.watcher = null
    debug('[GitWatcher] Stopped:', this.workspaceDir)
  }

  /**
   * Check if watcher is currently active.
   */
  isRunning(): boolean {
    return this.watcher !== null
  }

  /**
   * Get the workspace directory being watched.
   */
  getWorkspaceDir(): string {
    return this.workspaceDir
  }
}
